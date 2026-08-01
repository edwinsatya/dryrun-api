/**
 * Groq — the fallback provider.
 *
 * The endpoint is OpenAI-compatible, so this adapter stays deliberately thin:
 * the system prompt is just the first message and the response is one field.
 */

import {
  DEFAULT_PARAMS,
  LlmError,
  modelFor,
  type AdapterResult,
  type ChatRequest,
  type TokenUsage,
} from "./types.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

interface GroqResponse {
  choices?: {
    /** reasoning models return their chain of thought beside the answer */
    message?: { content?: string; reasoning?: string };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

function usageOf(usage: GroqResponse["usage"]): TokenUsage | null {
  if (!usage) return null;
  return {
    prompt: usage.prompt_tokens ?? null,
    completion: usage.completion_tokens ?? null,
    total: usage.total_tokens ?? null,
  };
}

export async function callGroq(request: ChatRequest): Promise<AdapterResult> {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    throw new LlmError("NO_API_KEY", "GROQ_API_KEY is not set.", {
      retryable: false,
    });
  }

  // Groq has no responseSchema equivalent, so a structured request is emulated:
  // json_object guarantees syntactically valid JSON, and the shape is carried
  // in the system prompt. The caller still validates — that is what keeps the
  // fallback as strong as the primary at the moment it is actually needed.
  const system = request.schema
    ? `${request.system}\n\nReturn a single JSON object matching this schema exactly:\n${JSON.stringify(
        request.schema,
        null,
        2,
      )}`
    : request.system;

  const send = (jsonMode: boolean) =>
    fetch(ENDPOINT, {
      method: "POST",
      signal: request.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: request.model ?? modelFor("groq"),
        messages: [{ role: "system", content: system }, ...request.messages],
        temperature: request.temperature ?? DEFAULT_PARAMS.temperature,
        top_p: request.topP ?? DEFAULT_PARAMS.topP,
        max_tokens: request.maxTokens ?? DEFAULT_PARAMS.maxTokens,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });

  const wantsJson = Boolean(request.schema);

  let response: Response;
  try {
    response = await send(wantsJson);

    /*
     * json_object is validated server-side, so a model slip returns 400
     * json_validate_failed instead of text. Llama slips in ways no repair can
     * undo — an unquoted string value, for instance — so the ladder is:
     *
     *   1. json_object            the constrained ask
     *   2. json_object again      a fresh sample; the fault is usually a
     *                             one-off, and the constraint still catches
     *                             the malformations that matter
     *   3. no constraint          last resort, fenced prose that
     *                             extractJson can usually salvage
     *
     * Dropping the constraint immediately was worse: it converts a caught
     * error into malformed output that reaches the parser.
     */
    if (!response.ok && response.status === 400 && wantsJson) {
      response = await send(true);
      if (!response.ok && response.status === 400) {
        response = await send(false);
      }
    }
  } catch (error) {
    // An abandoned attempt is a timeout, not an unreachable host. Reporting it
    // as the latter sends the reader looking for a network fault that is not
    // there.
    if (request.signal?.aborted) {
      throw new LlmError("TIMEOUT", "Groq did not answer in time.", {
        retryable: true,
      });
    }
    throw new LlmError("UPSTREAM_ERROR", "Could not reach Groq.", {
      retryable: true,
    });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 429) {
      throw new LlmError("RATE_LIMITED", "Groq rate limit reached.", {
        retryable: true,
        status: 429,
      });
    }
    throw new LlmError(
      "UPSTREAM_ERROR",
      `Groq responded with ${response.status}. ${detail.slice(0, 200)}`,
      { retryable: response.status >= 500, status: response.status },
    );
  }

  const data = (await response.json()) as GroqResponse;
  const choice = data.choices?.[0];
  const text = choice?.message?.content?.trim() ?? "";

  if (!text) {
    /*
     * Reasoning models (gpt-oss and friends) spend the token budget on
     * `reasoning` first and only then write `content`. Truncate them and the
     * answer is empty while the reasoning is full — indistinguishable from a
     * dead model unless the cause is named.
     */
    const reasoned = (choice?.message?.reasoning ?? "").length > 0;
    const truncated = choice?.finish_reason === "length";

    throw new LlmError(
      "EMPTY_RESPONSE",
      reasoned && truncated
        ? "Groq returned only reasoning: the token budget was spent before the answer. Raise maxTokens for this model."
        : "Groq returned no text.",
      { retryable: true },
    );
  }

  if (choice?.finish_reason && choice.finish_reason !== "stop") {
    console.warn(
      `[llm] ${request.model ?? modelFor("groq")} finished with ${choice.finish_reason}, not stop — the reply may be incomplete`,
    );
  }

  return {
    text,
    usage: usageOf(data.usage),
    finishReason: choice?.finish_reason ?? null,
  };
}
