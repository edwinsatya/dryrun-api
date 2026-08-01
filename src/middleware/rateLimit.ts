/**
 * Per-IP rate limiting for the open endpoints.
 *
 * The interview endpoints are not rate limited: reaching them costs a GitHub
 * username that must resolve to a real profile, and the flow is eight
 * questions long. The assistant has no such shape — one POST with a string in
 * it, from anyone, as often as they like — and this app has already lost a day
 * to an exhausted quota. So the limit lives here, on the new surface only.
 *
 * A fixed window per address, counted in Redis. Fixed rather than sliding
 * because a sliding window needs a sorted set and a read-modify-write per
 * request to hold an allowance this generous to a tolerance nobody would
 * notice; INCR with an expiry is one round-trip and cannot drift.
 */

import type { NextFunction, Request, Response } from "express";

import { kvIncrement } from "../utils/redis.js";

/**
 * The window and the allowance.
 *
 * 30 requests per 10 minutes. A real conversation with the assistant runs to
 * perhaps a dozen turns, so 30 leaves an engaged visitor with room to spare
 * while capping a scripted loop at three requests a minute — under which the
 * daily vision cap and the providers' own quotas are never the binding
 * constraint. Uploads share this budget rather than getting their own, because
 * an upload is strictly more expensive than a message: it costs a transcription
 * or a vision call *and* the chat call that follows it.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 30;

/*
 * The counters live in Redis.
 *
 * This was a Map, and of the six pieces of in-process state this migration
 * moved, this one and the vision cap were the dangerous pair: both fail open.
 * A cache that forgets is slow; a limiter that forgets is *absent*, and it
 * looks identical from outside — every request succeeds, nothing is logged,
 * and the first evidence is an exhausted quota. Under serverless a per-process
 * Map would have meant a fresh allowance per container, which is to say no
 * allowance at all.
 *
 * The sweep that used to prune this Map is gone with it: Redis expires keys on
 * its own, which is one of the reasons it is the right place for a window.
 */

/**
 * The caller's address.
 *
 * `req.ip` already honours trust proxy, which app.ts sets for the deployed
 * environment. The fallback keeps a direct connection from sharing one bucket
 * with everyone else when no address can be read at all.
 */
function keyFor(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}

export interface RateLimitState {
  limited: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Count this request against its window.
 *
 * When the store cannot answer, the request is allowed through. That is the
 * uncomfortable choice and it is deliberate: denying instead would turn a
 * Redis blip into a total outage of the assistant for everyone, and this
 * limiter guards a quota, not a door. redis.ts logs the degradation, so a
 * period of unenforced limiting is visible in the logs rather than silent —
 * which is the property that was actually missing before.
 */
async function consume(key: string): Promise<RateLimitState> {
  const window = await kvIncrement(key, WINDOW_MS);

  if (!window) {
    return {
      limited: false,
      remaining: MAX_REQUESTS,
      retryAfterSeconds: 0,
    };
  }

  return {
    limited: window.count > MAX_REQUESTS,
    remaining: Math.max(0, MAX_REQUESTS - window.count),
    retryAfterSeconds: Math.max(1, Math.ceil(window.ttlMs / 1000)),
  };
}

/**
 * Rejects with the same envelope the chat route uses for everything else, so
 * the widget renders it through one path rather than special-casing a status.
 */
export async function rateLimit(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const state = await consume(`ratelimit:${keyFor(request)}`);

  response.setHeader("X-RateLimit-Limit", String(MAX_REQUESTS));
  response.setHeader("X-RateLimit-Remaining", String(state.remaining));

  if (!state.limited) {
    next();
    return;
  }

  response.setHeader("Retry-After", String(state.retryAfterSeconds));
  response.status(429).json({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      message: `That is more messages than this demo allows in a short window — ${MAX_REQUESTS} per 10 minutes, to keep the free API quotas alive. Try again in ${Math.ceil(state.retryAfterSeconds / 60)} minute(s).`,
      retryAfterSeconds: state.retryAfterSeconds,
    },
  });
}
