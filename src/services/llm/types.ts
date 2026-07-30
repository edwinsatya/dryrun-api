/**
 * Provider-agnostic chat types.
 *
 * Server-only. GEMINI_API_KEY and GROQ_API_KEY are read in the provider
 * modules; nothing in this directory may be imported from a 'use client' file.
 */

export type Provider = "gemini" | "groq";

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
}

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

/** What a provider adapter hands back. */
export interface AdapterResult {
  text: string;
  usage: TokenUsage | null;
}

export interface ChatResult {
  text: string;
  /** which provider actually answered — the fallback may have taken over */
  provider: Provider;
  model: string;
  /** total upstream attempts across every provider tried */
  attempts: number;
  usage: TokenUsage | null;
}

export type LlmErrorCode =
  | "RATE_LIMITED"
  | "NO_API_KEY"
  | "UPSTREAM_ERROR"
  | "EMPTY_RESPONSE";

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
