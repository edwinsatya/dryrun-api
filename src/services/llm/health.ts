/**
 * Provider health.
 *
 * Exists because a dead primary is invisible from the outside: the fallback
 * answers, the page renders, and a whole session can run on the wrong provider
 * without anything looking wrong. This calls each provider directly — no
 * retries, no fallover — so the result is the truth about that one provider.
 */

import { callGemini } from "./gemini.js";
import { callGroq } from "./groq.js";
import {
  LlmError,
  modelFor,
  PROVIDER_ORDER,
  type AdapterResult,
  type ChatRequest,
  type Provider,
} from "./types.js";

export interface ProviderHealth {
  provider: Provider;
  model: string;
  ok: boolean;
  ms: number;
  /** whether the key is present at all — the most common cause of a dead path */
  keyPresent: boolean;
  error?: string;
  reply?: string;
}

/*
 * The budget is deliberately not tiny. Reasoning models spend tokens thinking
 * before they write anything, so a 16-token probe reports a perfectly healthy
 * model as dead — a health check that fails on healthy providers is worse than
 * none at all.
 */
const PROBE: ChatRequest = {
  system: "Reply with exactly one word.",
  messages: [{ role: "user", content: "Say: ready" }],
  temperature: 0,
  maxTokens: 512,
};

const ADAPTERS: Record<
  Provider,
  (request: ChatRequest) => Promise<AdapterResult>
> = {
  gemini: callGemini,
  groq: callGroq,
};

const KEYS: Record<Provider, string> = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
};

async function probe(provider: Provider): Promise<ProviderHealth> {
  const started = Date.now();
  const keyPresent = Boolean(process.env[KEYS[provider]]?.trim());

  try {
    const reply = await ADAPTERS[provider]({ ...PROBE, provider });
    return {
      provider,
      model: modelFor(provider),
      ok: true,
      ms: Date.now() - started,
      keyPresent,
      reply: reply.text.slice(0, 60),
    };
  } catch (error) {
    const message =
      error instanceof LlmError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Unknown failure.";

    return {
      provider,
      model: modelFor(provider),
      ok: false,
      ms: Date.now() - started,
      keyPresent,
      error: message.slice(0, 300),
    };
  }
}

/**
 * Both providers, in parallel. One cheap call each.
 *
 * Returned in PROVIDER_ORDER, because the caller reads `providers[0]` as the
 * primary. Hardcoding the pair here once meant the chain could be reordered
 * while /health carried on calling the old primary by that name — a health
 * check that reports the wrong provider as primary is worse than none.
 */
export async function checkProviders(): Promise<ProviderHealth[]> {
  return Promise.all(PROVIDER_ORDER.map(probe));
}
