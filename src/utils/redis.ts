/**
 * Upstash Redis over its REST API.
 *
 * Written against REST rather than a TCP client on purpose. A serverless
 * invocation has no stable lifetime to hold a connection across, and a pooled
 * socket that outlives the container it was opened in is a leak nobody sees
 * until the connection limit is reached. REST is one HTTPS request that ends
 * when the call ends, which is the shape this runtime actually has.
 *
 * Hand-rolled for the same reason mime.ts is: the surface used here is six
 * commands, and what matters most about this module is not its coverage of
 * Redis but its behaviour when Redis is unreachable — which is the part a
 * general-purpose client would decide for us.
 *
 * ---------------------------------------------------------------------------
 * THE RULE: every function here degrades rather than throws.
 *
 * This store backs a cache, a circuit breaker, a rate limiter and a usage cap.
 * Not one of those is worth failing a request over. A read that cannot reach
 * Redis reports a miss; a write that cannot reach Redis is dropped. The caller
 * then does the safe thing for its own case — refetch the profile, treat the
 * circuit as closed, let the request through — and the degradation is logged
 * so it is visible rather than inferred.
 * ---------------------------------------------------------------------------
 */

/**
 * How long a Redis call may take before it is abandoned.
 *
 * Deliberately small. This sits in front of work that costs seconds, so a
 * store that has become slow must not be allowed to spend the function's
 * budget: past two seconds, going straight to GitHub or straight to the model
 * is faster than continuing to wait for the thing meant to save time.
 */
const TIMEOUT_MS = 2_000;

type Command = (string | number)[];

interface RestReply {
  result?: unknown;
  error?: string;
}

function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

/** Whether an external store is configured at all. */
export function redisConfigured(): boolean {
  return credentials() !== null;
}

/*
 * One warning per process, not one per call.
 *
 * A store outage would otherwise print a line for every request, burying the
 * first occurrence — the one that says when it started — under thousands of
 * copies of itself.
 */
let warned = false;

function degrade(context: string, detail: unknown): null {
  if (!warned) {
    warned = true;
    const message =
      detail instanceof Error ? detail.message : String(detail ?? "unknown");
    console.warn(
      `[redis] unavailable during ${context} — falling through to the uncached path: ${message.slice(0, 160)}`,
    );
  }
  return null;
}

/**
 * Run one or more commands in a single round-trip.
 *
 * Returns null when the store could not answer, which every caller treats as
 * "no information" rather than as an error.
 */
async function pipeline(commands: Command[]): Promise<unknown[] | null> {
  const creds = credentials();
  if (!creds) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${creds.url}/pipeline`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });

    if (!response.ok) {
      return degrade("request", `HTTP ${response.status}`) as null;
    }

    const replies = (await response.json()) as RestReply[];
    if (!Array.isArray(replies)) return degrade("request", "unexpected body");

    // A command-level error is still a degradation, not a thrown request.
    const failed = replies.find((reply) => reply.error);
    if (failed) return degrade("command", failed.error);

    // A successful call means the store is back; let it warn again next time.
    warned = false;
    return replies.map((reply) => reply.result ?? null);
  } catch (error) {
    return degrade("connection", error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A JSON value, or undefined for both "absent" and "unreachable".
 *
 * Collapsing those two into one result is intentional: every caller's correct
 * response to them is identical — do the work that the cache would have saved.
 * Distinguishing them at the call site would only invite handling that the
 * degradation rule already answers.
 */
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const replies = await pipeline([["GET", key]]);
  const raw = replies?.[0];
  if (typeof raw !== "string") return undefined;

  try {
    return JSON.parse(raw) as T;
  } catch {
    // Written by an older shape, or truncated. Treat as absent and let it
    // be rewritten rather than handing a caller something unparseable.
    return undefined;
  }
}

export async function kvSet(
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  // PX rather than EX: the TTLs here are declared in milliseconds and rounding
  // a sub-second failure TTL up to a second would quietly change it.
  await pipeline([["SET", key, JSON.stringify(value), "PX", Math.max(1, Math.round(ttlMs))]]);
}

export async function kvDel(key: string): Promise<void> {
  await pipeline([["DEL", key]]);
}

/**
 * Increment a counter and return its value, setting the expiry on first write.
 *
 * The pipeline is what makes this usable as a limiter: INCR and PEXPIRE travel
 * together, so a counter cannot be created by one invocation and left without
 * an expiry because a second one raced it. PEXPIRE NX only sets the expiry
 * when there is not one already, which keeps the window fixed from its first
 * request rather than sliding forward on every hit.
 *
 * Returns null when the store is unreachable — the caller decides whether the
 * safe answer is to allow or to deny.
 */
export async function kvIncrement(
  key: string,
  windowMs: number,
): Promise<{ count: number; ttlMs: number } | null> {
  const replies = await pipeline([
    ["INCR", key],
    ["PEXPIRE", key, Math.max(1, Math.round(windowMs)), "NX"],
    ["PTTL", key],
  ]);

  if (!replies) return null;

  const count = typeof replies[0] === "number" ? replies[0] : null;
  if (count === null) return null;

  const ttl = typeof replies[2] === "number" ? replies[2] : windowMs;
  // -1 (no expiry) and -2 (missing) both mean "assume a full window".
  return { count, ttlMs: ttl < 0 ? windowMs : ttl };
}

/** Liveness for /health. Distinguishes "not configured" from "not answering". */
export async function redisHealth(): Promise<{
  configured: boolean;
  ok: boolean;
  ms: number;
}> {
  if (!redisConfigured()) return { configured: false, ok: false, ms: 0 };

  const started = Date.now();
  const replies = await pipeline([["PING"]]);
  return { configured: true, ok: replies !== null, ms: Date.now() - started };
}
