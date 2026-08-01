/**
 * Provider-agnostic chat types.
 *
 * Server-only. GEMINI_API_KEY and GROQ_API_KEY are read in the provider
 * modules; nothing in this directory may be imported from a 'use client' file.
 */

export type Provider = "gemini" | "groq";

/**
 * The chain: primary first, then the fallback.
 *
 * Groq leads because the quotas are not close. gpt-oss-120b allows 1,000
 * requests a day; gemini-3-flash-preview allows 20 — one interview is 17+
 * calls, so a Gemini-first chain spends its whole day on a single session and
 * every visitor after that lands on a degraded app. Gemini stays as the
 * fallback, where 20 high-quality calls a day are worth having.
 *
 * The single source of truth for order. /health reads it too, so "primary"
 * there means the same thing it means here.
 */
export const PROVIDER_ORDER: Provider[] = ["groq", "gemini"];

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * A provider-agnostic description of the shape a reply must take.
 *
 * Deliberately not the SDK's `Schema` type: Gemini maps this onto its native
 * structured-output support, Groq has no schema support and emulates it, and
 * neither detail belongs in index.ts. An OpenAPI-ish subset is all either
 * provider can honour anyway.
 */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object";

export interface JsonSchema {
  type: JsonSchemaType;
  description?: string;
  nullable?: boolean;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  /** Gemini honours this; it keeps field order stable in the output. */
  propertyOrdering?: string[];
  minimum?: number;
  maximum?: number;
}

/**
 * Sampling parameters are driven by the parameter panel, read per request.
 * A caller that omits one gets DEFAULT_PARAMS for it.
 */
export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  provider?: Provider;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** When set, the reply must be a JSON object of this shape. */
  schema?: JsonSchema;
  /** Ceiling for one upstream attempt. Defaults to ATTEMPT_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Set by the chain, not by callers. Adapters must pass it to the transport
   * so an abandoned attempt closes its socket instead of running on unwatched.
   */
  signal?: AbortSignal;
  /**
   * What this call belongs to — a username for an interview, a client key for
   * the assistant. The circuit breaker counts consecutive primary failures
   * against this string, so one caller's dead primary does not condemn
   * everyone else's, and an unscoped call cannot trip the breaker at all.
   */
  scope?: string;
}

/**
 * Aborts `promise` when `signal` fires.
 *
 * The underlying request is cancelled by the signal itself; this only stops
 * the *caller* waiting on a provider that has stopped being worth waiting for.
 */
function withDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new LlmError("TIMEOUT", message, { retryable: true }));

    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export { withDeadline };

/**
 * Token counts as the provider reported them. Every field is nullable because
 * reporting is a courtesy, not a guarantee: a provider that omits the block, or
 * omits a field inside it, must read as "not reported" rather than as zero.
 */
export interface TokenUsage {
  prompt: number | null;
  completion: number | null;
  total: number | null;
}

/**
 * What a provider adapter hands back.
 *
 * `finishReason` is carried because its absence is how a broken model stays
 * broken quietly: a reply truncated at the token ceiling and a reply the model
 * chose to end are the same string to everything downstream.
 */
export interface AdapterResult {
  text: string;
  usage: TokenUsage | null;
  /** the provider's own word for why generation stopped, when it gives one */
  finishReason?: string | null;
}

/**
 * Internal to the service — CallRecord, not this, is what crosses the wire.
 * Adding a field here costs the client nothing.
 */
export interface ChatResult {
  text: string;
  /** which provider actually answered — the fallback may have taken over */
  provider: Provider;
  model: string;
  /** total upstream attempts across every provider tried */
  attempts: number;
  usage: TokenUsage | null;
  finishReason?: string | null;
}

export type LlmErrorCode =
  | "RATE_LIMITED"
  | "NO_API_KEY"
  | "UPSTREAM_ERROR"
  | "EMPTY_RESPONSE"
  | "TIMEOUT";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** true when another provider is worth trying */
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: LlmErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number } = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export const DEFAULT_PARAMS = {
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 1000,
} as const;

/**
 * How long one attempt may run before it is abandoned.
 *
 * Measured, not guessed. On the current primary a question call returns in
 * ~1s; on gemini-3-flash-preview it was 7.5–10.0s at the default 1000-token
 * ceiling. The panel allows up to 2048, which roughly doubles the worst
 * realistic generation to ~20s.
 *
 * 20s, sized to fit the platform rather than the model. Vercel's function
 * ceiling is 60s on the Hobby plan, and a chain that outlives its function is
 * not a slow chain — it is killed mid-flight, which returns a platform timeout
 * instead of the readable error envelope every failure path here exists to
 * produce. Both numbers here are therefore chosen to be correct on either
 * plan, not to use up whatever the current one allows.
 */
export const ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * How long the whole chain may run, across every provider and retry.
 *
 * Per-attempt timeouts alone still multiply: three attempts at 20s is 60s,
 * which is the whole function. A healthy call costs ~1s, so 38s buys a full
 * retry plus a fallback attempt at real latency several times over, and leaves
 * ~22s of the 60s ceiling for cold start, store round-trips and writing the
 * response. The pathological path stays far under the 71s that prompted this.
 */
export const CHAIN_BUDGET_MS = 38_000;

/**
 * Time held back from a provider while another one is still untried.
 *
 * A slow primary must not be able to spend the fallback's turn. Measured on a
 * primary that stalls: two 21s attempts consumed the whole budget and the
 * request failed outright, while the fallback that would have answered it in
 * 2s was never called. 12s is a generous window for a provider that has been
 * answering in 1–2s, and it is only ever withheld while a fallback remains.
 */
export const FALLBACK_RESERVE_MS = 12_000;

/**
 * The shortest attempt worth starting.
 *
 * Below this the call cannot realistically finish, so spending the remaining
 * budget on it only delays reaching a provider that could have answered.
 */
export const MIN_VIABLE_ATTEMPT_MS = 5_000;

/**
 * Defaults only — the live values come from GEMINI_MODEL and GROQ_MODEL.
 *
 * Preview models carry quotas Google adjusts often and can be withdrawn at
 * short notice, so the id must be changeable without a code edit.
 * gemini-2.5-flash is already gone this way: the Developer API returns 404
 * "no longer available to new users" for it and for 2.5-flash-lite.
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  gemini: "gemini-3-flash-preview",
  groq: "llama-3.3-70b-versatile",
};

const MODEL_ENV: Record<Provider, string> = {
  gemini: "GEMINI_MODEL",
  groq: "GROQ_MODEL",
};

/** The model id in force for a provider, env first. */
export function modelFor(provider: Provider): string {
  return process.env[MODEL_ENV[provider]]?.trim() || DEFAULT_MODELS[provider];
}
