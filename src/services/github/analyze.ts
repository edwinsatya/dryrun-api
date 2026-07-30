/**
 * Pure analysis. No network, no environment access, no Next.js imports.
 * Give it a JSON fixture and it returns a CandidateProfile.
 */

import type {
  CandidateProfile,
  Confidence,
  DataQuality,
  DetectedGap,
  DetectedTech,
  Evidence,
  ExperienceSignals,
  GapArea,
  LanguageStat,
  RepoSummary,
  SeniorityEstimate,
  SeniorityLevel,
  TechCategory,
} from "../../types/candidate.js";

// ---------------------------------------------------------------------------
// Raw GitHub shapes — the input contract
// ---------------------------------------------------------------------------

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  html_url: string;
  followers: number;
  following: number;
  public_repos: number;
  created_at: string | null;
}

export interface GitHubRepo {
  name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  fork: boolean;
  archived: boolean;
  /** repository size in KB */
  size: number;
  created_at: string;
  pushed_at: string;
}

/** Result of the per-repo deep read (README + package.json). */
export interface RepoDeepRead {
  name: string;
  /** already truncated to ~500 chars; null when the repo has no README */
  readme: string | null;
  /** null when the repo has no package.json — normal for non-JS repos */
  dependencies: string[] | null;
}

export interface AnalyzeInput {
  user: GitHubUser;
  repos: GitHubRepo[];
  deepReads: RepoDeepRead[];
  /** ISO 8601; defaults to now. Pass it in tests to keep output deterministic. */
  fetchedAt?: string;
}

// ---------------------------------------------------------------------------
// Dependency → technology lookup
// ---------------------------------------------------------------------------

interface TechEntry {
  name: string;
  category: TechCategory;
}

/** Keys are package names exactly as they appear in package.json. */
const TECH_MAP: Record<string, TechEntry> = {
  // framework
  next: { name: "Next.js", category: "framework" },
  nuxt: { name: "Nuxt", category: "framework" },
  "@remix-run/react": { name: "Remix", category: "framework" },
  "@angular/core": { name: "Angular", category: "framework" },
  express: { name: "Express", category: "framework" },
  fastify: { name: "Fastify", category: "framework" },
  "@nestjs/core": { name: "NestJS", category: "framework" },

  // ui
  tailwindcss: { name: "Tailwind CSS", category: "ui" },
  "@mui/material": { name: "MUI", category: "ui" },
  "styled-components": { name: "styled-components", category: "ui" },
  "@chakra-ui/react": { name: "Chakra UI", category: "ui" },

  // state
  zustand: { name: "Zustand", category: "state" },
  "@reduxjs/toolkit": { name: "Redux Toolkit", category: "state" },
  jotai: { name: "Jotai", category: "state" },
  "@tanstack/react-query": { name: "TanStack Query", category: "state" },

  // orm
  prisma: { name: "Prisma", category: "orm" },
  "@prisma/client": { name: "Prisma", category: "orm" },
  "drizzle-orm": { name: "Drizzle", category: "orm" },
  mongoose: { name: "Mongoose", category: "orm" },
  typeorm: { name: "TypeORM", category: "orm" },
  sequelize: { name: "Sequelize", category: "orm" },

  // validation
  zod: { name: "Zod", category: "validation" },
  yup: { name: "Yup", category: "validation" },
  joi: { name: "Joi", category: "validation" },
  valibot: { name: "Valibot", category: "validation" },

  // testing
  vitest: { name: "Vitest", category: "testing" },
  jest: { name: "Jest", category: "testing" },
  "@playwright/test": { name: "Playwright", category: "testing" },
  cypress: { name: "Cypress", category: "testing" },
  "@testing-library/react": { name: "Testing Library", category: "testing" },

  // auth
  "next-auth": { name: "NextAuth", category: "auth" },
  "@auth/core": { name: "Auth.js", category: "auth" },
  jsonwebtoken: { name: "JSON Web Token", category: "auth" },
  passport: { name: "Passport", category: "auth" },
  "@clerk/nextjs": { name: "Clerk", category: "auth" },

  // api
  graphql: { name: "GraphQL", category: "api" },
  "@apollo/client": { name: "Apollo Client", category: "api" },
  axios: { name: "Axios", category: "api" },
  trpc: { name: "tRPC", category: "api" },
  "@trpc/server": { name: "tRPC", category: "api" },

  // build
  vite: { name: "Vite", category: "build" },
  webpack: { name: "webpack", category: "build" },
  turbo: { name: "Turborepo", category: "build" },
  esbuild: { name: "esbuild", category: "build" },
};

/** How many repos are read in full. Also caps the request budget. */
export const DEEP_READ_LIMIT = 5;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Repo selection — shared with the query layer so the rule lives in one place
// ---------------------------------------------------------------------------

/** Drop forks and archives, most recently pushed first, top N. */
export function selectDeepReadRepos(
  repos: GitHubRepo[],
  limit: number = DEEP_READ_LIMIT,
): GitHubRepo[] {
  return repos
    .filter((repo) => !repo.fork && !repo.archived)
    .slice()
    .sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function pluralRepos(count: number): string {
  return count === 1 ? "1 repository" : `${count} repositories`;
}

/** ["a", "b", "c"] → "a, b and c" */
function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/** Number of top languages listed before the remainder collapses into "Other". */
const LANGUAGE_ROWS = 5;

/**
 * Aggregated from the `language` field on each repo — /languages is never
 * called, so `bytes` is approximated from repository size (KB → bytes) and
 * attributed to that repo's primary language.
 */
function buildLanguages(originalRepos: GitHubRepo[]): LanguageStat[] {
  const totals = new Map<string, { bytes: number; repoCount: number }>();

  for (const repo of originalRepos) {
    if (!repo.language) continue;
    const current = totals.get(repo.language) ?? { bytes: 0, repoCount: 0 };
    current.bytes += Math.max(repo.size, 1) * 1024;
    current.repoCount += 1;
    totals.set(repo.language, current);
  }

  const totalBytes = [...totals.values()].reduce((sum, t) => sum + t.bytes, 0);
  if (totalBytes === 0) return [];

  const ranked = [...totals.entries()]
    .map(([name, t]) => ({
      name,
      bytes: t.bytes,
      repoCount: t.repoCount,
      percentage: round((t.bytes / totalBytes) * 100, 1),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  if (ranked.length <= LANGUAGE_ROWS) return ranked;

  const head = ranked.slice(0, LANGUAGE_ROWS);
  const tail = ranked.slice(LANGUAGE_ROWS);

  return [
    ...head,
    {
      name: "Other",
      bytes: tail.reduce((sum, l) => sum + l.bytes, 0),
      repoCount: tail.reduce((sum, l) => sum + l.repoCount, 0),
      percentage: round(
        tail.reduce((sum, l) => sum + l.percentage, 0),
        1,
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

/**
 * One DetectedTech per display name, so `prisma` and `@prisma/client` in the
 * same repo count as one repo, not two.
 */
function buildStack(deepReads: RepoDeepRead[]): DetectedTech[] {
  const found = new Map<
    string,
    { category: TechCategory; repos: Map<string, Set<string>> }
  >();

  for (const read of deepReads) {
    if (!read.dependencies) continue;

    for (const dependency of read.dependencies) {
      const entry = TECH_MAP[dependency];
      if (!entry) continue;

      const record = found.get(entry.name) ?? {
        category: entry.category,
        repos: new Map<string, Set<string>>(),
      };
      const packages = record.repos.get(read.name) ?? new Set<string>();
      packages.add(dependency);
      record.repos.set(read.name, packages);
      found.set(entry.name, record);
    }
  }

  return [...found.entries()]
    .map(([name, record]) => {
      // Evidence is never empty: the "Why this question?" feature depends on it.
      const evidence: Evidence[] = [...record.repos.entries()].map(
        ([repo, packages]) => ({
          repo,
          reason: `${[...packages].sort().join(", ")} listed in package.json`,
        }),
      );

      return {
        name,
        category: record.category,
        // A declared dependency proves the package is installed, not that it is
        // used well — high confidence is not available from a manifest alone.
        confidence: (evidence.length > 1 ? "high" : "medium") as Confidence,
        repoCount: evidence.length,
        evidence,
      };
    })
    .sort((a, b) => b.repoCount - a.repoCount || a.name.localeCompare(b.name));
}

function reposInCategory(stack: DetectedTech[], category: TechCategory): number {
  const repos = new Set<string>();
  for (const tech of stack) {
    if (tech.category !== category) continue;
    for (const item of tech.evidence) repos.add(item.repo);
  }
  return repos.size;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function buildSignals(
  user: GitHubUser,
  repos: GitHubRepo[],
  originalRepos: GitHubRepo[],
  deepReads: RepoDeepRead[],
  stack: DetectedTech[],
  now: number,
): ExperienceSignals {
  const yearAgo = now - MS_PER_YEAR;

  const pushTimes = repos
    .map((repo) => Date.parse(repo.pushed_at))
    .filter((time) => Number.isFinite(time));

  const readmeCoverage =
    deepReads.length === 0
      ? 0
      : round(
          deepReads.filter((read) => read.readme !== null).length /
            deepReads.length,
          2,
        );

  return {
    totalPublicRepos: user.public_repos,
    originalRepos: originalRepos.length,
    forkedRepos: repos.filter((repo) => repo.fork).length,
    activeLastYear: originalRepos.filter(
      (repo) => Date.parse(repo.pushed_at) >= yearAgo,
    ).length,
    totalStars: originalRepos.reduce(
      (sum, repo) => sum + repo.stargazers_count,
      0,
    ),

    usesTypeScript: originalRepos.some((repo) => repo.language === "TypeScript"),
    hasTests: reposInCategory(stack, "testing") > 0,
    // Neither is ever inspected — see UNINSPECTED_AREAS. `false` here means
    // "not confirmed", not "confirmed absent"; nothing renders it as a finding.
    hasCI: false,
    hasDocker: false,

    readmeCoverage,

    mostRecentPush:
      pushTimes.length === 0
        ? null
        : new Date(Math.max(...pushTimes)).toISOString(),
    accountAgeYears: user.created_at
      ? round((now - Date.parse(user.created_at)) / MS_PER_YEAR, 1)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/** Share of original repos on TypeScript, below which type safety is a gap. */
const TYPESCRIPT_THRESHOLD = 0.3;
/** README coverage below which documentation is a gap. */
const README_THRESHOLD = 0.5;

/**
 * Areas Dryrun cannot currently see. Confirming either would mean fetching
 * files that are not requested — workflow definitions and Dockerfiles — so
 * they are reported as unconfirmed, never as absent.
 *
 * This is the single source of truth for `DetectedGap.inspected` and for the
 * ledger's "not checked" rows.
 */
const UNINSPECTED_AREAS = new Set<GapArea>(["ci-cd", "containerization"]);

function buildGaps(
  originalRepos: GitHubRepo[],
  deepReads: RepoDeepRead[],
  stack: DetectedTech[],
  signals: ExperienceSignals,
): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  const readCount = deepReads.length;
  const originals = originalRepos.length;

  const typeScriptRepos = originalRepos.filter(
    (repo) => repo.language === "TypeScript",
  ).length;
  const typeScriptShare = originals === 0 ? 0 : typeScriptRepos / originals;
  const readmeCount = deepReads.filter((read) => read.readme !== null).length;

  if (reposInCategory(stack, "testing") === 0) {
    gaps.push({
      area: "testing",
      label: "Automated testing",
      reason: `No test library appears in any of the ${pluralRepos(readCount)} read in full.`,
      interviewAngle:
        "No test dependency was found. Ask how they verify a change before shipping it, what they would test first in their most recent project, and where they draw the line between unit and end-to-end coverage.",
      severity: "significant",
      inspected: true,
    });
  }

  // Unconfirmed, not absent — see UNINSPECTED_AREAS.
  gaps.push({
    area: "ci-cd",
    label: "CI / CD",
    reason:
      "Dryrun does not read workflow files, so continuous integration is unconfirmed rather than absent.",
    interviewAngle:
      "Continuous integration was never inspected, so treat it as unknown rather than missing. Ask what happens between a push and a deploy on their projects, and whether anything runs automatically.",
    severity: "significant",
    inspected: false,
  });

  gaps.push({
    area: "containerization",
    label: "Containers",
    reason:
      "Dryrun does not read Dockerfiles, so containerization is unconfirmed rather than absent.",
    interviewAngle:
      "Containerization was never inspected, so treat it as unknown rather than missing. Ask how they would hand a project to someone else so it runs identically on their machine.",
    severity: "info",
    inspected: false,
  });

  if (reposInCategory(stack, "auth") === 0) {
    gaps.push({
      // NOTE: the frozen GapArea union has no "auth" member, so this maps onto
      // the nearest available area. See the handover note — adding "auth"
      // requires a schemaVersion bump in lib/types/candidate.ts.
      area: "backend",
      label: "Authentication",
      reason: `No session or token handling appears in the ${pluralRepos(readCount)} read in full.`,
      interviewAngle:
        "No auth library was found. Ask how they would keep a user signed in across requests, and where they would store a session token and why.",
      severity: "info",
      inspected: true,
    });
  }

  if (typeScriptShare < TYPESCRIPT_THRESHOLD) {
    gaps.push({
      area: "type-safety",
      label: "Type safety",
      reason:
        originals === 0
          ? "No original repositories were available to check for TypeScript."
          : `TypeScript is the primary language in ${typeScriptRepos} of ${originals} original repositories.`,
      interviewAngle:
        "TypeScript adoption is low. Ask what they gain from static types, and how they would type a value whose shape is only known at runtime.",
      severity: "notable",
      inspected: true,
    });
  }

  if (signals.readmeCoverage < README_THRESHOLD) {
    gaps.push({
      area: "documentation",
      label: "Documentation",
      reason: `${readmeCount} of the ${pluralRepos(readCount)} read in full carry a README.`,
      interviewAngle:
        "README coverage is thin. Ask what a new contributor would need in the first ten minutes on their project.",
      severity: "notable",
      inspected: true,
    });
  }

  if (reposInCategory(stack, "orm") === 0) {
    gaps.push({
      area: "database",
      label: "Database / ORM",
      reason: `No ORM or database client appears in the ${pluralRepos(readCount)} read in full.`,
      interviewAngle:
        "No database layer was found. Ask how they would model a one-to-many relationship, and what they would do about a query that got slow.",
      severity: "notable",
      inspected: true,
    });
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Seniority
// ---------------------------------------------------------------------------

/**
 * A transparent point tally, not a guess. Every point that is awarded turns
 * into a rationale line citing the number that earned it.
 */
function buildSeniority(
  signals: ExperienceSignals,
  stack: DetectedTech[],
  languages: LanguageStat[],
  dataQuality: DataQuality,
): SeniorityEstimate {
  if (dataQuality === "empty") {
    return {
      level: "unknown",
      confidence: "low",
      rationale: ["No original public repositories were available to read."],
    };
  }

  const rationale: string[] = [];
  let score = 0;

  if (signals.originalRepos >= 8) {
    score += 1;
    rationale.push(
      `${signals.originalRepos} original repositories, enough of a body of work to read patterns from`,
    );
  } else {
    rationale.push(
      `Only ${signals.originalRepos} original ${signals.originalRepos === 1 ? "repository" : "repositories"}, a narrow sample to judge from`,
    );
  }

  if (signals.accountAgeYears !== null && signals.accountAgeYears >= 3) {
    score += 1;
    rationale.push(
      `Account active for ${signals.accountAgeYears} years, with ${signals.activeLastYear} ${signals.activeLastYear === 1 ? "repository" : "repositories"} pushed in the last 12 months`,
    );
  }

  const typeScript = languages.find((lang) => lang.name === "TypeScript");
  if (typeScript && typeScript.percentage >= 50) {
    score += 1;
    rationale.push(
      `TypeScript accounts for ${typeScript.percentage}% of original code, used consistently rather than occasionally`,
    );
  }

  const hasBackend =
    reposInCategory(stack, "orm") > 0 || reposInCategory(stack, "framework") > 0;
  if (hasBackend) {
    score += 1;
    const parts = [
      reposInCategory(stack, "framework") > 0 ? "a framework" : null,
      reposInCategory(stack, "orm") > 0 ? "an ORM" : null,
      reposInCategory(stack, "validation") > 0 ? "schema validation" : null,
    ].filter((part): part is string => part !== null);
    rationale.push(`Has worked with ${listSentence(parts)}`);
  }

  if (signals.hasTests) {
    score += 1;
    rationale.push("Test tooling present in public code");
  } else {
    // Only tests are actually checked — CI and containers are not, so they
    // cannot be cited as missing signals here.
    rationale.push(
      "No test tooling in any repository read in full, the one team-practice signal available",
    );
  }

  if (signals.totalStars >= 50) {
    score += 1;
    rationale.push(
      `${signals.totalStars} stars across original repositories, indicating work others found worth using`,
    );
  }

  const level: SeniorityLevel =
    score >= 5 ? "senior" : score >= 3 ? "mid" : "junior";

  // Capped at medium: CI, containers, and in-repo test files are never
  // inspected, so the evidence base is too narrow to claim high confidence.
  const confidence: Confidence =
    dataQuality === "rich" || dataQuality === "moderate" ? "medium" : "low";

  return { level, confidence, rationale };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary(
  user: GitHubUser,
  signals: ExperienceSignals,
  languages: LanguageStat[],
  stack: DetectedTech[],
  gaps: DetectedGap[],
  seniority: SeniorityEstimate,
  readCount: number,
): string {
  const who = user.name ?? user.login;

  if (signals.originalRepos === 0) {
    return `${who} (@${user.login}) has no original public repositories, so no technical profile could be built from code. Treat the stack and level as unknown and ask the candidate to describe their work directly.`;
  }

  const topLanguages = languages
    .filter((lang) => lang.name !== "Other")
    .slice(0, 3)
    .map((lang) => lang.name);

  const topStack = stack.slice(0, 5).map((tech) => tech.name);
  // The two are not interchangeable: one was checked and came back empty, the
  // other was never checked at all. The prompt must not conflate them.
  const missing = gaps.filter((gap) => gap.inspected).map((gap) => gap.label);
  const unchecked = gaps.filter((gap) => !gap.inspected).map((gap) => gap.label);

  const first = `${who} (@${user.login}) has ${signals.originalRepos} original public ${signals.originalRepos === 1 ? "repository" : "repositories"}, ${signals.activeLastYear} pushed to in the last 12 months, written mainly in ${listSentence(topLanguages) || "no single dominant language"}.`;

  const second =
    topStack.length > 0
      ? ` Their public code shows ${listSentence(topStack)}, read from package.json across the ${pluralRepos(readCount)} inspected most closely.`
      : " No recognisable dependencies were found in the repositories inspected most closely.";

  const third = ` Estimated level is ${seniority.level} at ${seniority.confidence} confidence.`;

  const fourth =
    missing.length > 0
      ? ` No supporting evidence was found for ${listSentence(missing)}.`
      : "";

  const fifth =
    unchecked.length > 0
      ? ` ${listSentence(unchecked)} ${unchecked.length === 1 ? "was" : "were"} never inspected, so treat ${unchecked.length === 1 ? "it" : "them"} as unknown rather than missing.`
      : "";

  return first + second + third + fourth + fifth;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function toRepoSummary(repo: GitHubRepo, read: RepoDeepRead | undefined): RepoSummary {
  return {
    name: repo.name,
    description: repo.description,
    url: repo.html_url,
    primaryLanguage: repo.language,
    topics: repo.topics ?? [],
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    isFork: repo.fork,
    isArchived: repo.archived,
    sizeKb: repo.size,
    createdAt: repo.created_at,
    pushedAt: repo.pushed_at,
    hasReadme: read?.readme != null,
    readmeExcerpt: read?.readme ?? null,
    dependencies: read?.dependencies ?? [],
  };
}

function toDataQuality(originalRepos: number): DataQuality {
  if (originalRepos === 0) return "empty";
  if (originalRepos < 3) return "thin";
  if (originalRepos < 8) return "moderate";
  return "rich";
}

export function analyze(input: AnalyzeInput): CandidateProfile {
  const { user, repos, deepReads } = input;
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const now = Date.parse(fetchedAt);

  const originalRepos = repos.filter((repo) => !repo.fork);
  const selected = selectDeepReadRepos(repos);

  const languages = buildLanguages(originalRepos);
  const stack = buildStack(deepReads);
  const signals = buildSignals(user, repos, originalRepos, deepReads, stack, now);
  const gaps = buildGaps(originalRepos, deepReads, stack, signals);
  const dataQuality = toDataQuality(originalRepos.length);
  const seniority = buildSeniority(signals, stack, languages, dataQuality);

  const readsByName = new Map(deepReads.map((read) => [read.name, read]));

  return {
    schemaVersion: 1,
    source: "github",
    fetchedAt,
    dataQuality,

    identity: {
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      bio: user.bio,
      company: user.company,
      location: user.location,
      blog: user.blog ? user.blog : null,
      profileUrl: user.html_url,
      followers: user.followers,
      following: user.following,
      publicRepos: user.public_repos,
      createdAt: user.created_at,
    },

    languages,
    stack,
    gaps,
    signals,
    seniority,

    highlightRepos: selected.map((repo) =>
      toRepoSummary(repo, readsByName.get(repo.name)),
    ),

    summary: buildSummary(
      user,
      signals,
      languages,
      stack,
      gaps,
      seniority,
      deepReads.length,
    ),
  };
}

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

/**
 * Which repositories an area could possibly have been measured against.
 *
 * Language data comes from the repo list, so it covers every original
 * repository. Dependency and README data require reading a repo in full, so it
 * only covers the handful selected. Mixing the two in one table invites
 * comparisons between numbers that share no denominator, which is why the
 * ledger groups by this.
 */
export type LedgerPopulation = "all-original" | "read-in-full";

export interface LedgerRow {
  /** continuous across groups: E-01 … E-09 */
  id: string;
  /** inferred category name — sans, per the typography rule */
  name: string;
  /** repositories carrying evidence for this area */
  count: number;
  /** repositories that could have carried it */
  of: number;
  /** false when the area is never actually looked at */
  inspected: boolean;
}

export interface LedgerGroup {
  population: LedgerPopulation;
  heading: string;
  rows: LedgerRow[];
}

/** Distinct repos backing any tech in a category. */
function reposWithCategory(
  stack: DetectedTech[],
  category: TechCategory,
): number {
  const repos = new Set<string>();
  for (const tech of stack) {
    if (tech.category !== category) continue;
    for (const item of tech.evidence) repos.add(item.repo);
  }
  return repos.size;
}

/**
 * The nine assessment areas, grouped by the population each was measured
 * against. Derived entirely from CandidateProfile so the component stays
 * presentational.
 */
export function buildLedger(profile: CandidateProfile): LedgerGroup[] {
  const { stack, languages, highlightRepos, signals } = profile;

  const allOriginal = signals.originalRepos;
  const readInFull = highlightRepos.length;

  const fromAll: Omit<LedgerRow, "id">[] = [
    {
      name: "Languages",
      count: languages
        .filter((language) => language.name !== "Other")
        .reduce((sum, language) => sum + language.repoCount, 0),
      of: allOriginal,
      inspected: true,
    },
    {
      name: "Type safety",
      count: languages.find((l) => l.name === "TypeScript")?.repoCount ?? 0,
      of: allOriginal,
      inspected: true,
    },
  ];

  const fromRead: Omit<LedgerRow, "id">[] = [
    {
      name: "Frameworks",
      count: reposWithCategory(stack, "framework"),
      of: readInFull,
      inspected: true,
    },
    {
      name: "Database / ORM",
      count: reposWithCategory(stack, "orm"),
      of: readInFull,
      inspected: true,
    },
    {
      name: "Documentation",
      count: highlightRepos.filter((repo) => repo.hasReadme).length,
      of: readInFull,
      inspected: true,
    },
    {
      name: "Testing",
      count: reposWithCategory(stack, "testing"),
      of: readInFull,
      inspected: true,
    },
    {
      name: "CI / CD",
      count: 0,
      of: readInFull,
      inspected: !UNINSPECTED_AREAS.has("ci-cd"),
    },
    {
      name: "Containers",
      count: 0,
      of: readInFull,
      inspected: !UNINSPECTED_AREAS.has("containerization"),
    },
    {
      name: "Authentication",
      count: reposWithCategory(stack, "auth"),
      of: readInFull,
      inspected: true,
    },
  ];

  // Numbering runs continuously across both groups.
  let sequence = 0;
  const number = (row: Omit<LedgerRow, "id">): LedgerRow => ({
    id: `E-${String(++sequence).padStart(2, "0")}`,
    ...row,
  });

  return [
    {
      population: "all-original",
      heading: `From all ${allOriginal} original ${allOriginal === 1 ? "repository" : "repositories"}`,
      rows: fromAll.map(number),
    },
    {
      population: "read-in-full",
      heading: `From the ${pluralRepos(readInFull)} read in full`,
      rows: fromRead.map(number),
    },
  ];
}

// ---------------------------------------------------------------------------
// Display helpers shared by the UI
// ---------------------------------------------------------------------------

/**
 * The dependencies worth showing in the sources table: those the lookup table
 * recognises, in manifest order, deduplicated by the technology they indicate
 * so `prisma` and `@prisma/client` do not both appear.
 *
 * Returns raw package names — they are quoted from package.json verbatim and
 * therefore render in mono.
 */
export function recognizedDependencies(
  dependencies: string[],
  limit = 4,
): string[] {
  const seen = new Set<string>();
  const shown: string[] = [];

  for (const dependency of dependencies) {
    const entry = TECH_MAP[dependency];
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    shown.push(dependency);
    if (shown.length === limit) break;
  }

  return shown;
}

/** "3 days", "1 month" — the relative push age shown in the sources table. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / MS_PER_DAY);
  if (!Number.isFinite(days) || days < 0) return "today";
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month" : `${months} months`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year" : `${years} years`;
}
