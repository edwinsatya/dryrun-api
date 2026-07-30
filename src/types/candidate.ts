/**
 * CandidateProfile
 * ----------------
 * One type, three jobs:
 *   Phase 1  → output of lib/github/analyze.ts, consumed by UI components
 *   Phase 2  → context source for the LLM system prompt
 *   Phase 3  → stored verbatim in the `Candidate.profile` Json column
 *
 * Rule: this shape must NOT drift between phases.
 * If it has to change, bump schemaVersion.
 *
 * ---------------------------------------------------------------------------
 * SOURCE OF TRUTH. This file is mirrored byte-for-byte, minus this note, at
 * dryrun/src/lib/types/candidate.ts in the frontend repo. There is no package
 * and no submodule — at two repos and one developer, keeping two copies in
 * step by hand is cheaper than either.
 *
 * Edit this file first, then copy it across. Both READMEs say the same.
 * ---------------------------------------------------------------------------
 *
 * Location: dryrun-api/src/types/candidate.ts
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type ProfileSource = "github" | "manual";

/** How usable this profile is as interview material. */
export type DataQuality = "rich" | "moderate" | "thin" | "empty";

export type Confidence = "high" | "medium" | "low";

export type SeniorityLevel = "junior" | "mid" | "senior" | "unknown";

export type TechCategory =
  | "language"
  | "framework"
  | "ui"
  | "state"
  | "data"
  | "orm"
  | "auth"
  | "api"
  | "testing"
  | "validation"
  | "build"
  | "infra"
  | "tooling";

/**
 * Where a given conclusion came from.
 * This is what powers the "Why this question?" feature.
 */
export interface Evidence {
  /** repository name, e.g. "anivault" */
  repo: string;
  /** e.g. "listed in package.json dependencies" */
  reason: string;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface CandidateIdentity {
  /** GitHub username — also the primary key in the database */
  login: string;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  profileUrl: string;
  followers: number;
  following: number;
  publicRepos: number;
  /** ISO 8601 */
  createdAt: string | null;
}

/** Used when source === 'manual' (empty GitHub account, or demo fallback). */
export interface ManualInput {
  role: string;
  skills: string[];
  yearsOfExperience: number | null;
  jobDescription: string | null;
}

// ---------------------------------------------------------------------------
// Languages and stack
// ---------------------------------------------------------------------------

export interface LanguageStat {
  name: string;
  bytes: number;
  /** 0–100, rounded to one decimal place */
  percentage: number;
  repoCount: number;
}

export interface DetectedTech {
  /** display name, e.g. "Prisma" rather than "@prisma/client" */
  name: string;
  category: TechCategory;
  confidence: Confidence;
  repoCount: number;
  evidence: Evidence[];
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface RepoSummary {
  name: string;
  description: string | null;
  url: string;
  primaryLanguage: string | null;
  topics: string[];
  stars: number;
  forks: number;
  isFork: boolean;
  isArchived: boolean;
  sizeKb: number;
  /** ISO 8601 */
  createdAt: string;
  pushedAt: string;

  hasReadme: boolean;
  /** first ~500 characters — raw prompt material, not for display */
  readmeExcerpt: string | null;
  /** flat list from package.json (dependencies + devDependencies) */
  dependencies: string[];
}

// ---------------------------------------------------------------------------
// Gaps — the part that separates this from a plain GitHub viewer
// ---------------------------------------------------------------------------

export type GapArea =
  | "testing"
  | "ci-cd"
  | "containerization"
  | "documentation"
  | "type-safety"
  | "backend"
  | "database"
  | "collaboration"
  | "accessibility";

export interface DetectedGap {
  area: GapArea;
  /** UI label, e.g. "Automated testing" */
  label: string;
  /** human-readable explanation, shown on the profile page */
  reason: string;
  /** question seed for the LLM — do not surface before the interview starts */
  interviewAngle: string;
  severity: "info" | "notable" | "significant";
  /** false when the area was never actually inspected, only assumed absent */
  inspected: boolean;
}

// ---------------------------------------------------------------------------
// Signals and estimates
// ---------------------------------------------------------------------------

export interface ExperienceSignals {
  totalPublicRepos: number;
  originalRepos: number;
  forkedRepos: number;
  /** repositories pushed to within the last 12 months */
  activeLastYear: number;
  totalStars: number;

  usesTypeScript: boolean;
  hasTests: boolean;
  hasCI: boolean;
  hasDocker: boolean;

  /** 0–1, share of repositories carrying a usable README */
  readmeCoverage: number;

  mostRecentPush: string | null;
  accountAgeYears: number | null;
}

export interface SeniorityEstimate {
  level: SeniorityLevel;
  confidence: Confidence;
  /** bullet reasons, shown in the UI and passed to the prompt */
  rationale: string[];
}

// ---------------------------------------------------------------------------
// Final shape
// ---------------------------------------------------------------------------

export interface CandidateProfile {
  /** bump when the shape changes — matters because this is stored as Json */
  schemaVersion: 1;
  source: ProfileSource;
  /** ISO 8601 */
  fetchedAt: string;
  dataQuality: DataQuality;

  identity: CandidateIdentity;
  manualInput?: ManualInput;

  languages: LanguageStat[];
  stack: DetectedTech[];
  gaps: DetectedGap[];
  signals: ExperienceSignals;
  seniority: SeniorityEstimate;

  /** selected repositories read in full (README + package.json) */
  highlightRepos: RepoSummary[];

  /** 2–3 sentences, ready to drop into a system prompt */
  summary: string;
}

// ---------------------------------------------------------------------------
// Supporting types for the API route
// ---------------------------------------------------------------------------

export type ProfileErrorCode =
  | "USER_NOT_FOUND"
  | "RATE_LIMITED"
  | "NO_PUBLIC_REPOS"
  | "UPSTREAM_ERROR";

export interface ProfileError {
  code: ProfileErrorCode;
  message: string;
  /** unix timestamp, only present for RATE_LIMITED */
  retryAt?: number;
}

export type ProfileResponse =
  | { ok: true; data: CandidateProfile }
  | { ok: false; error: ProfileError };
