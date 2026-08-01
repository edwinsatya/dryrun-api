/**
 * A two-layer cache, because the two layers do different jobs.
 *
 * L1 — in-flight promises, in this process.
 *   Deduplication, not caching. Two requests for the same username arriving
 *   together share one GitHub fetch instead of racing each other into two.
 *   This layer must hold a Promise, which is exactly why it cannot be Redis:
 *   a promise is a handle on work happening in *this* process and there is no
 *   serialisation of it that another invocation could await.
 *
 * L2 — resolved values, in Redis.
 *   Caching across invocations. Under serverless the process is gone moments
 *   after the response, so a memory-only cache made a hit a coincidence: the
 *   TTL described an intention rather than a guarantee, and the promise that
 *   no username is refetched within the hour was not actually being kept.
 *
 * Dropping either one loses something real. Without L1 a burst of concurrent
 * requests multiplies GitHub calls inside a single invocation, under a rate
 * limit that is already the tightest in the system. Without L2 the cache does
 * essentially nothing in production while continuing to look correct locally,
 * which is the failure this migration exists to prevent.
 */

import { kvDel, kvGet, kvSet } from "./redis.js";

export const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * L1. Keyed by the same string as L2, holding work in progress.
 *
 * Entries are removed as soon as they settle: this is not a value cache, and
 * leaving resolved promises here would reintroduce the in-memory cache that
 * L2 replaced, with a lifetime nobody declared.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** The resolved value from Redis, or undefined for absent *and* unreachable. */
export function getCached<T>(key: string): Promise<T | undefined> {
  return kvGet<T>(key);
}

export function setCached(
  key: string,
  value: unknown,
  ttlMs: number = ONE_HOUR_MS,
): Promise<void> {
  return kvSet(key, value, ttlMs);
}

export function dropCached(key: string): Promise<void> {
  inFlight.delete(key);
  return kvDel(key);
}

/**
 * Run `work` once per key for as long as it is unresolved.
 *
 * The second caller of a key in flight gets the first caller's promise rather
 * than starting its own. Settling — either way — releases the key, so a
 * failure is not remembered here; whether a failure is worth caching is a
 * question for L2, which can express it as a shorter TTL.
 */
export function dedupe<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const started = work().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, started);
  return started;
}

/** How many fetches are in flight in this process — for /health. */
export function inFlightCount(): number {
  return inFlight.size;
}
