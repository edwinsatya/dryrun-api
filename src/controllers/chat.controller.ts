/**
 * POST /api/chat.
 *
 * The envelope is the interview's — `{ ok, data }` or `{ ok, error: { code,
 * message } }` — because the client already has one way of reading a failure
 * and a second convention would be a second thing to keep in step.
 *
 * Everything a caller sends is re-read off an untyped body. In particular the
 * profile is never taken from the request: only a username is, and the context
 * is fetched server-side. See services/chat/context.ts.
 */

import type { Request, Response } from "express";

import {
  answer,
  MAX_HISTORY_TURNS,
  type Attachment,
} from "../services/chat/engine.js";
import {
  loadProfileContext,
  type ActiveQuestion,
} from "../services/chat/context.js";
import { visionBudget } from "../services/chat/vision.js";
import { LlmError, type ChatMessage } from "../services/llm/index.js";

type ChatErrorCode = "RATE_LIMITED" | "UPSTREAM_ERROR" | "BAD_REQUEST";

const STATUS: Record<ChatErrorCode, number> = {
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  BAD_REQUEST: 400,
};

function fail(response: Response, code: ChatErrorCode, message: string): void {
  response.status(STATUS[code]).json({ ok: false, error: { code, message } });
}

function body(request: Request): Record<string, unknown> {
  const raw = request.body;
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : {};
}

/** Prior turns, kept only where both fields are the shape they claim. */
function toHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    if (raw.role !== "user" && raw.role !== "assistant") return [];
    if (typeof raw.content !== "string" || !raw.content.trim()) return [];
    return [{ role: raw.role, content: raw.content }];
  });
}

/**
 * The live question, if one was sent.
 *
 * Unlike the profile, this is taken from the client — it has to be, because it
 * lives in React state on the interview screen and nowhere on the server. That
 * is acceptable precisely because it is inert: the assistant reads it to
 * discuss what is on screen, and a caller who forges it only changes what
 * their own assistant talks about. No score, no session and no stored state
 * can be reached through it.
 */
function toActiveQuestion(value: unknown): ActiveQuestion | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (typeof raw.question !== "string" || !raw.question.trim()) return null;

  return {
    index: typeof raw.index === "number" ? raw.index : 0,
    topic: typeof raw.topic === "string" ? raw.topic : "this topic",
    question: raw.question.slice(0, 2000),
    config: typeof raw.config === "string" ? raw.config.slice(0, 300) : "the session defaults",
  };
}

/** The attachment the client says it is sending back, as returned by /upload. */
function toAttachment(value: unknown): Attachment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;

  if (raw.kind !== "image" && raw.kind !== "audio" && raw.kind !== "document") {
    return undefined;
  }

  return {
    kind: raw.kind,
    filename: typeof raw.filename === "string" ? raw.filename.slice(0, 200) : null,
    // Capped again here: /upload already bounded it, but this is a separate
    // request and nothing says the two carried the same payload.
    text: typeof raw.text === "string" ? raw.text.slice(0, 16_000) : null,
    note: typeof raw.note === "string" ? raw.note.slice(0, 400) : null,
  };
}

/**
 * The circuit-breaker scope for a chat call.
 *
 * The caller's address, never the username. Scoping chat by username would let
 * a stranger's failing requests open the circuit on the candidate whose page
 * they are visiting, and that circuit is shared with the interview.
 */
function scopeFor(request: Request): string {
  return `chat:${request.ip ?? "unknown"}`;
}

export async function postChat(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    const raw = body(request);

    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    const attachment = toAttachment(raw.attachment);

    if (!message && !attachment) {
      fail(response, "BAD_REQUEST", "There was no message to answer.");
      return;
    }

    const username =
      typeof raw.username === "string" ? raw.username.trim() : "";

    /*
     * Mode is decided by whether a username resolves to a real profile, not by
     * what the client called the mode. A caller claiming "profile" without a
     * username, or with one that does not exist, gets the landing assistant —
     * which is the honest thing, since there is no context to ground answers in.
     */
    const context = username
      ? await loadProfileContext(username, toActiveQuestion(raw.activeQuestion))
      : null;

    const reply = await answer({
      message: message || "What is in this attachment?",
      history: toHistory(raw.history),
      context,
      attachment,
      scope: scopeFor(request),
    });

    response.status(200).json({
      ok: true,
      data: {
        reply: reply.text,
        mode: context ? "profile" : "landing",
        historyKept: Math.min(toHistory(raw.history).length, MAX_HISTORY_TURNS),
      },
      provider: reply.provider,
      model: reply.model,
    });
  } catch (error) {
    console.error("[chat]", error);

    if (error instanceof LlmError && error.code === "RATE_LIMITED") {
      fail(
        response,
        "RATE_LIMITED",
        "Both model providers are rate limited right now. Wait a moment and try again.",
      );
      return;
    }

    fail(
      response,
      "UPSTREAM_ERROR",
      "The assistant could not answer just now. Try again.",
    );
  }
}

/** Small enough to fold into /health later if it earns its place. */
export async function getChatBudget(
  _request: Request,
  response: Response,
): Promise<void> {
  // Awaited, obviously — but worth a note, because the un-awaited version
  // typechecked cleanly and shipped: the payload is an untyped object literal,
  // so a Promise is a perfectly valid thing to put in it, and JSON.stringify
  // renders one as `{}`. The endpoint answered 200 with an empty budget.
  response
    .status(200)
    .json({ ok: true, data: { vision: await visionBudget() } });
}
