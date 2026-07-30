/**
 * The four interview calls.
 *
 * This file holds everything the Next route handlers used to: reading an
 * untyped body, coercing each field, calling the engine, and turning the two
 * possible outcomes into HTTP. The `ok`/`failed` pair below came from
 * lib/interview/session.ts, which could not keep them once it stopped being
 * allowed to import a framework.
 *
 * Username moved from the path to the body when the routes flattened, and is
 * the only shape change across the split. Everything else — the request
 * fields, the response envelope, the status codes — is what it was.
 */

import type { Request, Response } from "express";

import {
  continueExchange,
  generateQuestion,
  generateStudyPlan,
  scoreAnswer,
  type HistoryEntry,
} from "../services/interview/engine.js";
import { UnreadableResponseError } from "../services/interview/json.js";
import { coerceInterviewParams } from "../services/interview/params.js";
import {
  loadSession,
  requireString,
  SessionError,
  topicAt,
} from "../services/interview/session.js";
import {
  MAX_EXCHANGES,
  type Assessment,
  type CallRecord,
  type ExchangeTurn,
  type InterviewError,
  type InterviewResponse,
} from "../services/interview/types.js";
import { LlmError } from "../services/llm/index.js";

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

const STATUS: Record<InterviewError["code"], number> = {
  RATE_LIMITED: 429,
  UNREADABLE: 502,
  UPSTREAM_ERROR: 502,
  USER_NOT_FOUND: 404,
};

/**
 * The record travels with every successful reply — the prompt inspector is
 * only worth anything if it describes the call that actually happened, and
 * this is the last place that still knows.
 */
function ok<T>(response: Response, data: T, call: CallRecord): void {
  response.status(200).json({
    ok: true,
    data,
    provider: call.provider,
    call,
  } satisfies InterviewResponse<T>);
}

/**
 * Every failure the interview screen can encounter, turned into copy it can
 * render. A 429 after both providers is an ordinary outcome on free tiers, not
 * a crash, and says so.
 */
function failed(response: Response, error: unknown): void {
  let payload: InterviewError;

  if (error instanceof SessionError) {
    payload = error.error;
  } else if (error instanceof UnreadableResponseError) {
    payload = {
      code: "UNREADABLE",
      message: "Could not read the model's response. Retry this question.",
    };
  } else if (error instanceof LlmError) {
    payload =
      error.code === "RATE_LIMITED"
        ? {
            code: "RATE_LIMITED",
            message:
              "Rate limit reached on both providers. Wait a moment and retry.",
          }
        : {
            code: "UPSTREAM_ERROR",
            message: "The model did not respond. Retry this question.",
          };
  } else {
    payload = {
      code: "UPSTREAM_ERROR",
      message: "Something failed on the way to the model. Retry this question.",
    };
  }

  // Full detail to the server log; only the readable line to the client.
  console.error("[interview]", error);

  response
    .status(STATUS[payload.code])
    .json({ ok: false, error: payload } satisfies InterviewResponse<never>);
}

// ---------------------------------------------------------------------------
// Body readers
// ---------------------------------------------------------------------------

function body(request: Request): Record<string, unknown> {
  const raw = request.body;
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : {};
}

/** Prior turns, so question N can react to what came before it. */
function toHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.topic !== "string" ||
      typeof raw.question !== "string" ||
      typeof raw.answer !== "string"
    ) {
      return [];
    }
    return [{ topic: raw.topic, question: raw.question, answer: raw.answer }];
  });
}

function toAssessment(value: unknown): Assessment {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

  return {
    score: typeof raw.score === "number" ? raw.score : 0,
    verdict: typeof raw.verdict === "string" ? raw.verdict : "",
    strengths: Array.isArray(raw.strengths)
      ? raw.strengths.filter((s): s is string => typeof s === "string")
      : [],
    gaps: Array.isArray(raw.gaps)
      ? raw.gaps.filter((s): s is string => typeof s === "string")
      : [],
    followUp: typeof raw.followUp === "string" ? raw.followUp : null,
  };
}

function toTurns(value: unknown): ExchangeTurn[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    if (raw.role !== "candidate" && raw.role !== "interviewer") return [];
    if (typeof raw.text !== "string") return [];
    return [{ role: raw.role, text: raw.text }];
  });
}

interface SummaryResult {
  topic: string;
  score: number;
  verdict: string;
}

function toResults(value: unknown): SummaryResult[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    if (typeof raw.topic !== "string" || typeof raw.score !== "number") return [];
    return [
      {
        topic: raw.topic,
        score: raw.score,
        verdict: typeof raw.verdict === "string" ? raw.verdict : "",
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function postQuestion(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    const raw = body(request);
    const username = requireString(raw.username, "username");

    const { profile, plan } = await loadSession(username);
    const topic = topicAt(plan, raw.index);

    // Whatever the panel sent is re-clamped here: the client writes these into
    // a URL, and a URL is a text field.
    const params = coerceInterviewParams(raw.params);
    const rerun = raw.rerun === true;

    const result = await generateQuestion(
      profile,
      topic,
      toHistory(raw.history),
      params,
      rerun ? "Question (re-run)" : "Question",
    );

    ok(
      response,
      {
        ...result.data,
        // The evidence chain travels with the question — it is what the
        // "Why this question?" toggle renders.
        topicId: topic.id,
        index: topic.index,
        sourceType: topic.sourceType,
        sourceRef: topic.sourceRef,
        evidence: topic.evidence,
      },
      result.call,
    );
  } catch (error) {
    failed(response, error);
  }
}

export async function postScore(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    const raw = body(request);
    const username = requireString(raw.username, "username");
    const question = requireString(raw.question, "question");
    const answer = requireString(raw.answer, "answer");

    const { profile, plan } = await loadSession(username);
    const topic = topicAt(plan, raw.index);

    const result = await scoreAnswer(
      profile,
      topic,
      question,
      answer,
      coerceInterviewParams(raw.params),
    );

    ok(response, result.data, result.call);
  } catch (error) {
    failed(response, error);
  }
}

export async function postFollowUp(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    const raw = body(request);
    const username = requireString(raw.username, "username");
    const question = requireString(raw.question, "question");
    const answer = requireString(raw.answer, "answer");
    const message = requireString(raw.message, "message");
    const turns = toTurns(raw.turns);

    const { profile, plan } = await loadSession(username);
    const topic = topicAt(plan, raw.index);

    // Each exchange is one candidate turn plus one reply.
    const exchangesSoFar = turns.filter((t) => t.role === "candidate").length;
    const atCap = exchangesSoFar + 1 >= MAX_EXCHANGES;

    const result = await continueExchange(
      profile,
      topic,
      question,
      answer,
      toAssessment(raw.assessment),
      turns,
      message,
      atCap,
      coerceInterviewParams(raw.params),
    );

    ok(response, { ...result.data, atCap }, result.call);
  } catch (error) {
    failed(response, error);
  }
}

export async function postSummary(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    const raw = body(request);
    const username = requireString(raw.username, "username");

    const results = toResults(raw.results);
    if (results.length === 0) {
      throw new SessionError({
        code: "UPSTREAM_ERROR",
        message: "No answered questions to summarise.",
      });
    }

    const { profile } = await loadSession(username);
    const result = await generateStudyPlan(
      profile,
      results,
      coerceInterviewParams(raw.params),
    );

    ok(response, result.data, result.call);
  } catch (error) {
    failed(response, error);
  }
}
