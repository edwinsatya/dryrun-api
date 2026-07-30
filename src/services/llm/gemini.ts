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
  try {
    let response;
    try {
      response = await send(true);
    } catch (error) {
      // thinkingBudget is not accepted by every model in this family — some
      // reject it outright with 400. Losing the whole call over a tuning knob
      // would be the wrong trade, so drop it and try once more.
      if (error instanceof ApiError && error.status === 400) {
        response = await send(false);
      } else {
        throw error;
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
    const finish = response.candidates?.[0]?.finishReason;
    if (finish === FinishReason.MAX_TOKENS) {
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

  return { text: trimmed, usage };
}
