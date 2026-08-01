/**
 * The one entry point for every model call.
 *
 * Free tiers rate-limit aggressively, so a 429 is an ordinary operating
 * condition here, not an exception: the primary gets one retry, and if it is
 * still refusing, the request falls through to the secondary. Only when both
 * are exhausted does this throw, and the thrown error is typed so the route
 * handler can render a readable state.
 *
 * Three things bound the cost of a bad minute, because an unbounded chain is
 * how one dead model turned a single question into 71 seconds of waiting:
 *
 *   per-attempt timeout   no single call may hang
 *   chain budget          the attempts may not add up to a hang either
 *   circuit breaker       a primary that has failed twice for one caller is
 *                         skipped for the rest of that caller's session,
 *                         rather than re-proven wrong on every question
 */

import { callGemini } from "./gemini.js";
import { callGroq } from "./groq.js";
import {
  ATTEMPT_TIMEOUT_MS,
  CHAIN_BUDGET_MS,
  FALLBACK_RESERVE_MS,
  MIN_VIABLE_ATTEMPT_MS,
  PROVIDER_ORDER,
  LlmError,
  modelFor,
  withDeadline,
  type AdapterResult,
  type ChatRequest,
  type ChatResult,
  type Provider,
} from "./types.js";

import { kvDel, kvGet, kvSet } from "../../utils/redis.js";

export * from "./types.js";

/**
 * Attempts before moving on.
 *
 * The primary gets one retry, because a transient blip is worth one more ask
 * and nothing beyond that: a model that cannot answer twice is not going to
 * answer on the third try, and the old budget of three-per-provider meant six
 * upstream calls for one logical call. The fallback gets a single attempt —
 * it is already the second opinion.
 */
const PRIMARY_ATTEMPTS = 2;
const FALLBACK_ATTEMPTS = 1;

/** Backoff between the primary's two attempts, plus jitter. */
const BACKOFF_MS = 400;

/**
 * Consecutive primary failures before the primary is skipped for a scope.
 *
 * Two, because one logical call already contains a retry: reaching two means
 * the primary has failed four upstream attempts in a row. Waiting for a third
 * would spend another full chain budget to learn what the first two said, and
 * an eight-question interview would pay that on every question.
 */
const BREAKER_THRESHOLD = 2;

/** A scope is one session's worth of calls; it expires with the profile cache. */
const BREAKER_TTL_MS = 60 * 60 * 1000;

/*
 * The breaker lives in Redis, not in this process.
 *
 * It was a Map, and under serverless that made it decorative: every
 * invocation began with the circuit closed, so a primary that had already
 * failed twice was asked again on the next question, and again on the one
 * after. The whole point of the breaker — stop paying for a provider that has
 * proven it is down — cannot be served by state that dies with the request
 * that learned it.
 *
 * Nothing about the semantics changed: still N consecutive failures, still
 * scoped, still an hour, still closed by any success. Only the storage moved.
 */
function breakerKey(scope: string, provider: Provider): string {
  return `breaker:${scope}:${provider}`;
}

/**
 * True when this provider has already failed enough for this scope.
 *
 * An unreachable store answers "not tripped", which keeps the failure open
 * rather than closed: the worst case is that a dead provider is tried again,
 * which is the behaviour before the breaker existed. The alternative — assume
 * tripped — would skip a healthy primary because a cache was down.
 */
async function isTripped(
  scope: string | undefined,
  provider: Provider,
): Promise<boolean> {
  if (!scope) return false;
  const failures = await kvGet<number>(breakerKey(scope, provider));
  return (failures ?? 0) >= BREAKER_THRESHOLD;
}

async function recordFailure(
  scope: string | undefined,
  provider: Provider,
): Promise<void> {
  if (!scope) return;

  const key = breakerKey(scope, provider);
  const consecutiveFailures = ((await kvGet<number>(key)) ?? 0) + 1;
  await kvSet(key, consecutiveFailures, BREAKER_TTL_MS);

  if (consecutiveFailures === BREAKER_THRESHOLD) {
    console.warn(
      `[llm] circuit open for ${provider} (${modelFor(provider)}) on scope "${scope}" — ${consecutiveFailures} consecutive failures; skipping it for this session`,
    );
  }
}

/** A success is the only thing that closes the circuit again. */
async function recordSuccess(
  scope: string | undefined,
  provider: Provider,
): Promise<void> {
  if (!scope) return;
  await kvDel(breakerKey(scope, provider));
}

const ADAPTERS: Record<
  Provider,
  (request: ChatRequest) => Promise<AdapterResult>
> = {
  gemini: callGemini,
  groq: callGroq,
};

/** Primary first, then the fallback. Declared in types.ts; /health reads it too. */
const ORDER = PROVIDER_ORDER;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  return new LlmError(
    "UPSTREAM_ERROR",
    error instanceof Error ? error.message : "Unknown provider failure.",
    { retryable: true },
  );
}

/** Milliseconds left in the chain budget, floored at zero. */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** A duration a reader can act on — "8s" is useful, a rounded-off "0s" is not. */
function describeMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * One attempt, abandoned at whichever comes first: the per-attempt ceiling or
 * what is left of the chain budget. The signal is handed to the adapter so the
 * socket closes too — a timeout that only stops the waiting still leaves the
 * request running.
 */
async function attemptOnce(
  provider: Provider,
  request: ChatRequest,
  deadline: number,
  reserve: number,
): Promise<AdapterResult> {
  const ceiling = request.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const budget = Math.min(ceiling, remaining(deadline) - reserve);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);

  try {
    return await withDeadline(
      ADAPTERS[provider]({ ...request, provider, signal: controller.signal }),
      controller.signal,
      `${provider} (${modelFor(provider)}) did not answer within ${describeMs(budget)}.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function attemptProvider(
  provider: Provider,
  request: ChatRequest,
  startingAttempt: number,
  maxAttempts: number,
  deadline: number,
  /** withheld so a provider still to come is guaranteed a turn */
  reserve: number,
): Promise<AdapterResult & { attempts: number }> {
  let attempts = startingAttempt;
  let last: LlmError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Starting an attempt too short to finish only delays the real error, and
    // spends time the next provider could have used answering.
    if (remaining(deadline) - reserve < MIN_VIABLE_ATTEMPT_MS) {
      last =
        last ??
        new LlmError("TIMEOUT", "The chain ran out of time.", {
          retryable: true,
        });
      break;
    }

    attempts += 1;
    try {
      const result = await attemptOnce(provider, request, deadline, reserve);
      return { ...result, attempts };
    } catch (error) {
      last = toLlmError(error);

      // A missing key or a request we malformed will not improve on retry.
      if (!last.retryable) break;
      if (last.code === "NO_API_KEY") break;

      const isLastAttempt = attempt === maxAttempts - 1;
      if (!isLastAttempt) {
        const jitter = Math.random() * 150;
        const backoff = BACKOFF_MS * 2 ** attempt + jitter;
        // Never sleep past the deadline — the nap would eat the next attempt.
        await sleep(Math.min(backoff, remaining(deadline)));
      }
    }
  }

  throw Object.assign(last ?? toLlmError(null), { attempts });
}

export async function chat(request: ChatRequest): Promise<ChatResult> {
  // An explicit provider still gets the other one as a fallback.
  const preferred = request.provider ?? ORDER[0];
  const ordered = [preferred, ...ORDER.filter((p) => p !== preferred)];
  const startedAt = Date.now();
  const deadline = startedAt + CHAIN_BUDGET_MS;

  /*
   * A tripped provider is skipped, not removed: if every provider in the chain
   * is tripped the breaker has stopped being a shortcut and started being an
   * outage, so the order is restored and they are tried anyway. Refusing to
   * call anyone is never better than calling someone who might have recovered.
   */
  const tripped = await Promise.all(
    ordered.map((provider) => isTripped(request.scope, provider)),
  );
  const open = ordered.filter((_, index) => !tripped[index]);
  const order = open.length > 0 ? open : ordered;

  for (const skipped of ordered.filter((p) => !order.includes(p))) {
    console.warn(
      `[llm] skipping ${skipped} (${modelFor(skipped)}) — circuit open for scope "${request.scope}"`,
    );
  }

  let attempts = 0;
  const failures: LlmError[] = [];

  for (const [position, provider] of order.entries()) {
    const maxAttempts =
      provider === preferred ? PRIMARY_ATTEMPTS : FALLBACK_ATTEMPTS;
    // The last provider in the chain has nobody to save time for.
    const isLast = position === order.length - 1;
    const reserve = isLast ? 0 : FALLBACK_RESERVE_MS;

    try {
      const result = await attemptProvider(
        provider,
        request,
        attempts,
        maxAttempts,
        deadline,
        reserve,
      );
      await recordSuccess(request.scope, provider);

      /*
       * One line per model call, alongside the one per HTTP request.
       * The Gemma incident was invisible for as long as it was because
       * nothing on the success path ever said which model answered, how long
       * it took, or why it stopped — the only evidence was a slow page.
       */
      console.log(
        `[llm] ${provider} ${modelFor(provider)} ${describeMs(Date.now() - startedAt)} attempts=${result.attempts} finish=${result.finishReason ?? "?"} tokens=${result.usage?.completion ?? "?"}/${result.usage?.total ?? "?"}`,
      );

      if (provider !== preferred) {
        console.warn(
          `[llm] answered by fallback ${provider} (${modelFor(provider)}); ${preferred} did not respond`,
        );
      }
      return {
        text: result.text,
        provider,
        // Only honour a caller's model override for the provider they asked for.
        model:
          provider === preferred && request.model
            ? request.model
            : modelFor(provider),
        attempts: result.attempts,
        usage: result.usage,
        finishReason: result.finishReason ?? null,
      };
    } catch (error) {
      const failure = toLlmError(error);
      failures.push(failure);
      const before = attempts;
      attempts =
        (error as LlmError & { attempts?: number }).attempts ?? attempts;
      // What this provider actually cost, not what it was allowed to cost — a
      // non-retryable 404 stops after one, and logging the budget instead
      // invents attempts that never happened.
      const used = Math.max(1, attempts - before);
      await recordFailure(request.scope, provider);

      // A silently absorbed primary failure is the dangerous case: from the
      // outside a dead Gemini is indistinguishable from success, and a whole
      // session can run on the fallback unnoticed. Say so, loudly.
      const next = order[order.indexOf(provider) + 1];
      if (next) {
        console.warn(
          `[llm] ${provider} (${modelFor(provider)}) failed after ${used} attempt(s) — ${failure.code}: ${failure.message.slice(0, 200)} — falling back to ${next} (${modelFor(next)})`,
        );
      }
    }
  }

  // Both providers are out. Rate limiting anywhere in the chain wins the
  // reported code — it is the actionable one, and "wait and retry" is true
  // advice even if the fallback failed for a different reason.
  const rateLimited = failures.find((f) => f.code === "RATE_LIMITED");
  const reported = rateLimited ?? failures[failures.length - 1];

  throw new LlmError(
    reported?.code ?? "UPSTREAM_ERROR",
    failures.map((f) => f.message).join(" / ") || "No provider could answer.",
    { status: reported?.status },
  );
}
