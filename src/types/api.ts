/**
 * The HTTP boundary.
 *
 * Everything in this file describes something that crosses the wire between
 * dryrun-api and the Next frontend. It exists so both ends can be read against
 * one description rather than against each other's implementations.
 *
 * The response envelopes themselves are unchanged from the Next route handlers
 * they replace — `ProfileResponse` in types/candidate.ts and
 * `InterviewResponse<T>` in services/interview/types.ts are still the shapes
 * that go out. That is deliberate: the split moved where the code runs, not
 * what it says, so the client's error handling did not have to be reinvented.
 *
 * Mirrored, in part, at dryrun/src/lib/api.ts. See the note in candidate.ts.
 */

import type { InterviewParams } from "../services/interview/params.js";
import type { ProviderHealth } from "../services/llm/health.js";
import type { Assessment, ExchangeTurn } from "../services/interview/types.js";

// ---------------------------------------------------------------------------
// Request bodies
//
// Every field is declared optional-ish in practice: these describe what a
// well-behaved client sends, not what the server trusts. Controllers re-read
// each value off an untyped body and coerce it, because a body is text until
// something checks it.
// ---------------------------------------------------------------------------

/** Common to all four interview calls. The username moved from the path to the
 *  body when the routes flattened to POST /api/interview/<verb>. */
export interface InterviewRequestBase {
  username: string;
  params?: Partial<InterviewParams>;
}

export interface QuestionRequest extends InterviewRequestBase {
  /** 0-based position in the eight-topic plan */
  index: number;
  history?: { topic: string; question: string; answer: string }[];
  /** true when the same topic is being asked again for comparison */
  rerun?: boolean;
}

export interface ScoreRequest extends InterviewRequestBase {
  index: number;
  question: string;
  answer: string;
}

export interface FollowUpRequest extends InterviewRequestBase {
  index: number;
  question: string;
  answer: string;
  assessment: Assessment;
  turns: ExchangeTurn[];
  message: string;
}

export interface SummaryRequest extends InterviewRequestBase {
  results: { topic: string; score: number; verdict: string }[];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * GET /health.
 *
 * `ok` means the primary answered. The fallback covering for it is survivable
 * — that is `degraded` — but it is not health, and the keepalive cron should
 * be able to tell the two apart without parsing the provider list.
 */
export interface HealthResponse {
  ok: boolean;
  degraded: boolean;
  /** seconds since the process started, for the keepalive cron */
  uptimeSeconds: number;
  /** cached profiles currently live */
  cachedProfiles: number;
  providers: ProviderHealth[];
}
