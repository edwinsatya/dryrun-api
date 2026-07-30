/**
 * Session planning. Pure — no LLM, no network, deterministic for a given
 * profile, which is what lets a route handler rebuild the same eight topics
 * from a username without the client sending them back.
 */

import type {
  CandidateProfile,
  DetectedGap,
  Evidence,
  RepoSummary,
} from "../../types/candidate.js";

export const SESSION_LENGTH = 8;
/** Of the eight, how many come from demonstrated work. */
const DEMONSTRATED_TARGET = 5;
/** …and how many from gaps. */
const GAP_TARGET = 3;

export interface PlannedTopic {
  /** T-01 … T-08 */
  id: string;
  index: number;
  /** display label — inferred by Dryrun, so it renders in sans */
  topic: string;
  sourceType: "repo" | "gap";
  /** the technology, repository or gap area this came from */
  sourceRef: string;
  /**
   * Why this topic exists at all. Powers "Why this question?" — never empty,
   * never placeholder.
   */
  evidence: Evidence[];
  /** extra material handed to the model when the question is generated */
  context: TopicContext;
}

export interface TopicContext {
  kind: "tech" | "repo" | "language" | "gap";
  /** repositories worth quoting into the prompt for this topic */
  repos: string[];
  dependencies?: string[];
  readmeExcerpt?: string | null;
  /** gap-only */
  gapReason?: string;
  gapAngle?: string;
  gapSeverity?: DetectedGap["severity"];
}

const SEVERITY_RANK: Record<DetectedGap["severity"], number> = {
  significant: 0,
  notable: 1,
  info: 2,
};

/** Candidate topic before numbering, carrying a key for de-duplication. */
interface Draft extends Omit<PlannedTopic, "id" | "index"> {
  key: string;
}

function repoByName(
  profile: CandidateProfile,
  name: string,
): RepoSummary | undefined {
  return profile.highlightRepos.find((repo) => repo.name === name);
}

// ---------------------------------------------------------------------------
// Demonstrated work
// ---------------------------------------------------------------------------

/**
 * Detected technologies, most-evidenced first. The strongest source: each one
 * already carries the repositories it was read from.
 */
function techDrafts(profile: CandidateProfile): Draft[] {
  return [...profile.stack]
    .sort((a, b) => b.repoCount - a.repoCount || a.name.localeCompare(b.name))
    .map((tech) => {
      const repos = tech.evidence.map((item) => item.repo);
      const primary = repoByName(profile, repos[0]);

      return {
        key: `tech:${tech.name.toLowerCase()}`,
        topic: tech.name,
        sourceType: "repo" as const,
        sourceRef: tech.name,
        evidence: tech.evidence,
        context: {
          kind: "tech" as const,
          repos,
          dependencies: primary?.dependencies ?? [],
          readmeExcerpt: primary?.readmeExcerpt ?? null,
        },
      };
    });
}

/**
 * One topic per repository read in full. The fallback that keeps sparse
 * profiles viable — a repo with a README is always something to ask about,
 * even when its manifest yielded nothing recognisable.
 */
function repoDrafts(profile: CandidateProfile): Draft[] {
  return profile.highlightRepos.map((repo) => {
    const detail =
      repo.description ??
      (repo.readmeExcerpt ? "described in its README" : "no description given");

    return {
      key: `repo:${repo.name.toLowerCase()}`,
      topic: repo.name,
      sourceType: "repo" as const,
      sourceRef: repo.name,
      evidence: [
        {
          repo: repo.name,
          reason: repo.hasReadme
            ? `read in full: ${detail}`
            : `read in full, no README present: ${detail}`,
        },
      ],
      context: {
        kind: "repo" as const,
        repos: [repo.name],
        dependencies: repo.dependencies,
        readmeExcerpt: repo.readmeExcerpt,
      },
    };
  });
}

/**
 * Broader areas implied by the languages present. Last resort, and still
 * evidence-backed: every language names the repositories written in it.
 */
function languageDrafts(profile: CandidateProfile): Draft[] {
  return profile.languages
    .filter((language) => language.name !== "Other")
    .map((language) => {
      const repos = profile.highlightRepos
        .filter((repo) => repo.primaryLanguage === language.name)
        .map((repo) => repo.name);

      // Language stats cover every original repo, but only the ones read in
      // full can be named. Fall back to the aggregate when none overlap.
      const evidence: Evidence[] =
        repos.length > 0
          ? repos.map((repo) => ({
              repo,
              reason: `primary language is ${language.name}`,
            }))
          : [
              {
                repo: `${language.repoCount} repositories`,
                reason: `${language.name} is the primary language in ${language.percentage}% of original code`,
              },
            ];

      return {
        key: `lang:${language.name.toLowerCase()}`,
        topic: language.name,
        sourceType: "repo" as const,
        sourceRef: language.name,
        evidence,
        context: {
          kind: "language" as const,
          repos,
          readmeExcerpt: repoByName(profile, repos[0])?.readmeExcerpt ?? null,
        },
      };
    });
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/**
 * Gaps worth asking about.
 *
 * A gap with `inspected: false` is excluded unconditionally: Dryrun never
 * looked at CI configuration or Dockerfiles, so questioning their absence
 * would be questioning something it does not know.
 */
function gapDrafts(profile: CandidateProfile): Draft[] {
  return profile.gaps
    .filter((gap) => gap.inspected)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .map((gap) => ({
      key: `gap:${gap.area}`,
      topic: gap.label,
      sourceType: "gap" as const,
      sourceRef: gap.area,
      evidence: [
        {
          repo:
            profile.highlightRepos.map((r) => r.name).join(", ") ||
            profile.identity.login,
          reason: gap.reason,
        },
      ],
      context: {
        kind: "gap" as const,
        repos: profile.highlightRepos.map((repo) => repo.name),
        gapReason: gap.reason,
        gapAngle: gap.interviewAngle,
        gapSeverity: gap.severity,
      },
    }));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Eight distinct topics, interleaved so the session opens on demonstrated work
 * and gaps arrive once the candidate has warmed up.
 *
 * Thin profiles are the interesting case: an account with three detected
 * technologies still has to yield eight topics, so demonstrated work is drawn
 * from technologies, then repositories, then languages, taking whatever the
 * profile can actually support before falling back to the next source.
 */
export function buildSessionPlan(profile: CandidateProfile): PlannedTopic[] {
  const seen = new Set<string>();
  const take = (drafts: Draft[], limit: number): Draft[] => {
    const out: Draft[] = [];
    for (const draft of drafts) {
      if (out.length >= limit) break;
      if (seen.has(draft.key)) continue;
      seen.add(draft.key);
      out.push(draft);
    }
    return out;
  };

  const gaps = take(gapDrafts(profile), GAP_TARGET);

  // Demonstrated work fills its own quota plus anything the gaps could not.
  const demonstratedTarget =
    DEMONSTRATED_TARGET + (GAP_TARGET - gaps.length);

  const demonstrated = [
    ...take(techDrafts(profile), demonstratedTarget),
  ];
  if (demonstrated.length < demonstratedTarget) {
    demonstrated.push(
      ...take(repoDrafts(profile), demonstratedTarget - demonstrated.length),
    );
  }
  if (demonstrated.length < demonstratedTarget) {
    demonstrated.push(
      ...take(languageDrafts(profile), demonstratedTarget - demonstrated.length),
    );
  }

  // If a profile is so thin that even that is not enough, more gaps are better
  // than a short session.
  const remaining = SESSION_LENGTH - demonstrated.length - gaps.length;
  if (remaining > 0) {
    gaps.push(...take(gapDrafts(profile), remaining));
  }

  return interleave(demonstrated, gaps)
    .slice(0, SESSION_LENGTH)
    .map((draft, index) => ({
      id: `T-${String(index + 1).padStart(2, "0")}`,
      index,
      topic: draft.topic,
      sourceType: draft.sourceType,
      sourceRef: draft.sourceRef,
      evidence: draft.evidence,
      context: draft.context,
    }));
}

/**
 * Two demonstrated topics, then a gap, repeating. Opening on something the
 * candidate built is deliberate — the first question should be answerable.
 */
function interleave(demonstrated: Draft[], gaps: Draft[]): Draft[] {
  const out: Draft[] = [];
  const work = [...demonstrated];
  const holes = [...gaps];

  while (work.length > 0 || holes.length > 0) {
    if (work.length > 0) out.push(work.shift()!);
    if (work.length > 0) out.push(work.shift()!);
    if (holes.length > 0) out.push(holes.shift()!);
  }

  return out;
}
