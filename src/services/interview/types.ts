/**
 * Shapes shared between the route handlers and the interview screen.
 * Types only — safe to import from a client component.
 */

import type { InterviewParams } from "./params.js";
import type { PlannedTopic } from "./plan.js";
import type { Provider, TokenUsage } from "../llm/types.js";

/**
 * What one model call actually was.
 *
 * The whole value of this record is that it is a record: it describes the call
 * that happened, not the configuration currently on screen. Everything in it is
 * captured at the moment of the successful attempt — including the system
 * prompt, which the retry path rewrites, and the provider, which the fallback
 * can change out from under the requested one.
 */
export interface CallRecord {
  /** which of the four calls this was */
  label: string;
  /** the system prompt exactly as sent */
  system: string;
  /** the parameters as requested */
  params: InterviewParams;
  /** the provider that answered, which is not always the one asked for */
  provider: Provider;
  model: string;
  attempts: number;
  /** wall-clock across every attempt the caller waited through */
  latencyMs: number;
  usage: TokenUsage | null;
}

export interface GeneratedQuestion {
  topic: string;
  question: string;
  /** one sentence, why this was asked */
  rationale: string;
}

export interface Assessment {
  /** 0–10 */
  score: number;
  verdict: string;
  strengths: string[];
  gaps: string[];
  /** a sharper question, or null */
  followUp: string | null;
}

export interface ExchangeTurn {
  role: "candidate" | "interviewer";
  text: string;
}

export interface FollowUpReply {
  /** unconstrained prose — the conversation itself */
  text: string;
  /** non-null only when the interviewer conceded and moved the score */
  revisedScore: number | null;
  /** why it moved; always present when revisedScore is */
  revisionReason: string | null;
}

export interface StudyPlan {
  /** 3–5 concrete next steps */
  steps: string[];
}

/** Per-question state held in React memory for the length of the session. */
export interface QuestionState {
  plan: PlannedTopic;
  question: GeneratedQuestion | null;
  answer: string;
  assessment: Assessment | null;
  /** the score before any revision, kept so the change can be shown */
  originalScore: number | null;
  exchange: ExchangeTurn[];
  submitted: boolean;
}

export type InterviewErrorCode =
  | "RATE_LIMITED"
  | "UNREADABLE"
  | "UPSTREAM_ERROR"
  | "USER_NOT_FOUND";

export interface InterviewError {
  code: InterviewErrorCode;
  message: string;
}

export type InterviewResponse<T> =
  | { ok: true; data: T; provider: Provider; call: CallRecord }
  | { ok: false; error: InterviewError };

/** Exchanges allowed per question before the candidate is invited to move on. */
export const MAX_EXCHANGES = 5;
