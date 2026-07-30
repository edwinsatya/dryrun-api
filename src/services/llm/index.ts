/**
 * The one entry point for every model call.
 *
 * Free tiers rate-limit aggressively, so a 429 is an ordinary operating
 * condition here, not an exception: each provider gets three attempts with
 * exponential backoff, and if the primary is still refusing, the request falls
 * through to the secondary. Only when both are exhausted does this throw, and
 * the thrown error is typed so the route handler can render a readable state.
 */

import { callGemini } from "./gemini.js";
import { callGroq } from "./groq.js";
import {
  LlmError,
  modelFor,
  type AdapterResult,
  type ChatRequest,
  type ChatResult,
  type Provider,
} from "./types.js";

export * from "./types.js";

/** Attempts per provider before moving on. */
const MAX_ATTEMPTS = 3;
/** Backoff base; delays run 400ms, 800ms, 1600ms plus jitter. */
const BACKOFF_MS = 400;

const ADAPTERS: Record<
  Provider,
  (request: ChatRequest) => Promise<AdapterResult>
> = {
  gemini: callGemini,
  groq: callGroq,
};

/** Primary first, then the fallback. */
const ORDER: Provider[] = ["gemini", "groq"];

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

async function attemptProvider(
  provider: Provider,
  request: ChatRequest,
  startingAttempt: number,
): Promise<AdapterResult & { attempts: number }> {
  let attempts = startingAttempt;
  let last: LlmError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    attempts += 1;
    try {
      const result = await ADAPTERS[provider]({ ...request, provider });
      return { ...result, attempts };
    } catch (error) {
      last = toLlmError(error);

      // A missing key or a request we malformed will not improve on retry.
      if (!last.retryable) break;
      if (last.code === "NO_API_KEY") break;

      const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
      if (!isLastAttempt) {
        const jitter = Math.random() * 150;
        await sleep(BACKOFF_MS * 2 ** attempt + jitter);
      }
    }
  }

  throw Object.assign(last ?? toLlmError(null), { attempts });
}

export async function chat(request: ChatRequest): Promise<ChatResult> {
  // An explicit provider still gets the other one as a fallback.
  const preferred = request.provider ?? ORDER[0];
  const order = [preferred, ...ORDER.filter((p) => p !== preferred)];

  let attempts = 0;
  const failures: LlmError[] = [];

  for (const provider of order) {
    try {
      const result = await attemptProvider(provider, request, attempts);
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
      };
    } catch (error) {
      const failure = toLlmError(error);
      failures.push(failure);
      attempts =
        (error as LlmError & { attempts?: number }).attempts ?? attempts;

      // A silently absorbed primary failure is the dangerous case: from the
      // outside a dead Gemini is indistinguishable from success, and a whole
      // session can run on the fallback unnoticed. Say so, loudly.
      const next = order[order.indexOf(provider) + 1];
      if (next) {
        console.warn(
          `[llm] ${provider} (${modelFor(provider)}) failed after ${MAX_ATTEMPTS} attempts — ${failure.code}: ${failure.message.slice(0, 200)} — falling back to ${next} (${modelFor(next)})`,
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
