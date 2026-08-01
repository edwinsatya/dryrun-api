/**
 * Google Gemini — the primary provider, via the official @google/genai SDK.
 *
 * The SDK is an implementation detail of this file: index.ts never imports it,
 * and the provider-agnostic JsonSchema is translated here into the SDK's own
 * Schema/Type shape.
 *
 * Developer API path — API key only. No Vertex AI, no project id, no gcloud.
 */

import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  Type,
  type Schema,
} from "@google/genai";

import {
  DEFAULT_PARAMS,
  LlmError,
  modelFor,
  type AdapterResult,
  type ChatRequest,
  type JsonSchema,
  type JsonSchemaType,
  type TokenUsage,
} from "./types.js";

const TYPE_MAP: Record<JsonSchemaType, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

function toSdkSchema(schema: JsonSchema): Schema {
  const out: Schema = { type: TYPE_MAP[schema.type] };

  if (schema.description) out.description = schema.description;
  if (schema.nullable) out.nullable = true;
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;
  if (schema.items) out.items = toSdkSchema(schema.items);
  if (schema.required) out.required = schema.required;
  if (schema.propertyOrdering) out.propertyOrdering = schema.propertyOrdering;

  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        toSdkSchema(value),
      ]),
    );
  }

  return out;
}

/**
 * Models known to reject `thinkingConfig`, learned at the first 400.
 *
 * Process-lifetime memo, deliberately not a hardcoded list: which models
 * accept the knob is a property of the API on the day, and a stale allowlist
 * would either re-introduce the wasted round-trip or suppress the control on a
 * model that now supports it.
 *
 * Left in memory when the cache, breaker, rate limiter and vision cap all
 * moved to Redis, and the reason is worth stating because "some state moved
 * and some did not" otherwise looks like an oversight. This one is a
 * performance memo, not a guard: its worst case under serverless is one wasted
 * 400 per container, and it degrades toward *more correctness*, never less.
 * Moving it would put a network round-trip in front of every Gemini call to
 * save at most one round-trip per container — a straight loss. The same
 * applies to the cached SDK client below.
 */
const rejectsThinkingControl = new Set<string>();

/** One client per key; constructing it per request is pure overhead. */
let cached: { key: string; client: GoogleGenAI } | null = null;

function clientFor(key: string): GoogleGenAI {
  if (cached?.key !== key) {
    cached = { key, client: new GoogleGenAI({ apiKey: key }) };
  }
  return cached.client;
}

function usageOf(
  meta:
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined,
): TokenUsage | null {
  if (!meta) return null;
  return {
    prompt: meta.promptTokenCount ?? null,
    completion: meta.candidatesTokenCount ?? null,
    total: meta.totalTokenCount ?? null,
  };
}

export async function callGemini(request: ChatRequest): Promise<AdapterResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // Retryable in the sense that the *other* provider is worth trying.
    throw new LlmError("NO_API_KEY", "GEMINI_API_KEY is not set.", {
      retryable: true,
    });
  }

  const model = request.model ?? modelFor("gemini");
  const client = clientFor(key);

  /*
   * Gemma models are served by this same API but do not accept a system
   * instruction. Passing one does not error — it silently consumes the whole
   * output budget and returns MAX_TOKENS with no text, which looks exactly
   * like a broken key. Folding the system text into the first user turn is the
   * documented way to carry it.
   */
  const supportsSystemInstruction = !/^gemma/i.test(model);

  const contents = request.messages.map((message, index) => ({
    // The SDK names the assistant role "model".
    role: message.role === "assistant" ? "model" : "user",
    parts: [
      {
        text:
          !supportsSystemInstruction && index === 0
            ? `${request.system}\n\n---\n\n${message.content}`
            : message.content,
      },
    ],
  }));

  const send = (withThinkingControl: boolean) =>
    client.models.generateContent({
      model,
      contents,
      config: {
        ...(supportsSystemInstruction
          ? { systemInstruction: request.system }
          : {}),
        ...(request.signal ? { abortSignal: request.signal } : {}),
        temperature: request.temperature ?? DEFAULT_PARAMS.temperature,
        topP: request.topP ?? DEFAULT_PARAMS.topP,
        maxOutputTokens: request.maxTokens ?? DEFAULT_PARAMS.maxTokens,
        // Flash models think by default and charge those tokens against
        // maxOutputTokens, which at our budget truncates the answer mid-JSON.
        // Off, so the budget buys real output.
        ...(withThinkingControl
          ? { thinkingConfig: { thinkingBudget: 0 } }
          : {}),
        ...(request.schema
          ? {
              responseMimeType: "application/json",
              responseSchema: toSdkSchema(request.schema),
            }
          : {}),
      },
    });

  let text: string | undefined;
  let usage: TokenUsage | null = null;
  let finishReason: FinishReason | undefined;
  try {
    let response;
    if (rejectsThinkingControl.has(model)) {
      response = await send(false);
    } else {
      try {
        response = await send(true);
      } catch (error) {
        /*
         * thinkingBudget is not accepted by every model in this family — the
         * Gemma models reject it outright with 400. Losing the whole call over
         * a tuning knob would be the wrong trade, so drop it and try once more
         * — but remember, because paying a guaranteed 400 on every subsequent
         * call doubles the request count for that model and buys nothing.
         */
        if (error instanceof ApiError && error.status === 400) {
          rejectsThinkingControl.add(model);
          console.warn(
            `[llm] ${model} rejects thinkingConfig; retrying without it and skipping it from now on`,
          );
          response = await send(false);
        } else {
          throw error;
        }
      }
    }

    text = response.text;
    usage = usageOf(response.usageMetadata);

    /*
     * A truncated reply is not a successful one. Cut a JSON object off
     * mid-string and the text is non-empty but unparseable, so treating it as
     * success means the caller burns both parse attempts on the same broken
     * provider and never reaches the healthy fallback. Raise it instead, and
     * let the retry-and-fallover ladder do its job.
     */
    finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new LlmError(
        "EMPTY_RESPONSE",
        `Gemini hit the output limit before finishing (model ${model}). The reply is truncated.`,
        { retryable: true },
      );
    }
  } catch (error) {
    if (error instanceof LlmError) throw error;

    if (error instanceof ApiError) {
      if (error.status === 429) {
        throw new LlmError("RATE_LIMITED", "Gemini rate limit reached.", {
          retryable: true,
          status: 429,
        });
      }
      throw new LlmError(
        "UPSTREAM_ERROR",
        `Gemini responded with ${error.status}. ${error.message.slice(0, 200)}`,
        { retryable: error.status >= 500, status: error.status },
      );
    }

    throw new LlmError(
      "UPSTREAM_ERROR",
      error instanceof Error ? error.message : "Could not reach Gemini.",
      { retryable: true },
    );
  }

  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    // Safety blocks and token-cap truncation both land here.
    throw new LlmError("EMPTY_RESPONSE", "Gemini returned no text.", {
      retryable: true,
    });
  }

  // A reply that stopped for any reason other than "the model was done" is
  // still returned — it may well be usable — but it does not pass unremarked.
  if (finishReason && finishReason !== FinishReason.STOP) {
    console.warn(
      `[llm] ${model} finished with ${finishReason}, not STOP — the reply may be incomplete`,
    );
  }

  return { text: trimmed, usage, finishReason: finishReason ?? null };
}
