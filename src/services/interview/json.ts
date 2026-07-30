/**
 * Defensive JSON handling for model output.
 *
 * Gemini enforces the schema natively, so on the primary path this is close to
 * a no-op. It earns its keep on the Groq fallback, which can only be asked for
 * "some JSON object" — exactly the moment when a weaker path would hurt most.
 * Models wrap JSON in markdown fences, prepend "Here is the JSON:", or emit a
 * trailing comma; none of that is worth failing a question over.
 */

import type { InterviewParams } from "./params.js";
import type { CallRecord } from "./types.js";
import { chat, LlmError, type ChatMessage } from "../llm/index.js";
import type { JsonSchema, Provider } from "../llm/types.js";

export function extractJson<T>(raw: string): T | null {
  let text = raw.trim();

  // ```json … ``` or ``` … ```
  text = text
    .replace(/^```(?:json)?[ \t]*\r?\n?/i, "")
    .replace(/\r?\n?```$/i, "")
    .trim();

  // Anything the model said around the object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  const candidate = text.slice(start, end + 1);

  try {
    return JSON.parse(candidate) as T;
  } catch {
    // One common malformation worth surviving: a trailing comma.
    try {
      return JSON.parse(candidate.replace(/,(\s*[}\]])/g, "$1")) as T;
    } catch {
      return null;
    }
  }
}

/** Thrown when the model's output could not be read after a retry. */
export class UnreadableResponseError extends Error {
  constructor(message = "Could not read the model's response.") {
    super(message);
    this.name = "UnreadableResponseError";
  }
}

const STRICTER = `
Your previous reply could not be parsed. Reply with the raw JSON object only.
Start your reply with { and end it with }. No code fences, no commentary.`;

/**
 * One model call that must yield valid, shape-checked JSON.
 * `validate` narrows the parsed value; returning null rejects it.
 *
 * Returns the record of the call alongside the data. It describes the attempt
 * that actually succeeded — so on the retry path it carries the rewritten
 * system prompt and whichever provider answered, not the ones first asked for.
 */
export async function jsonCall<T>(options: {
  /** which of the four calls this is, for the inspector */
  label: string;
  system: string;
  messages: ChatMessage[];
  schema: JsonSchema;
  validate: (value: unknown) => T | null;
  params: InterviewParams;
}): Promise<{ data: T; call: CallRecord }> {
  const started = Date.now();
  let attempts = 0;

  const attempt = async (system: string, provider = options.params.provider) => {
    const result = await chat({
      system,
      messages: options.messages,
      schema: options.schema,
      temperature: options.params.temperature,
      topP: options.params.topP,
      maxTokens: options.params.maxTokens,
      provider,
    });
    attempts += result.attempts;

    const parsed = extractJson<unknown>(result.text);
    const validated = parsed === null ? null : options.validate(parsed);

    return {
      validated,
      call: {
        label: options.label,
        system,
        params: options.params,
        provider: result.provider,
        model: result.model,
        attempts,
        // Everything the caller waited through, retries and backoff included.
        latencyMs: Date.now() - started,
        usage: result.usage,
      } satisfies CallRecord,
    };
  };

  const first = await attempt(options.system);
  if (first.validated !== null) {
    return { data: first.validated, call: first.call };
  }

  /*
   * Retry once, more bluntly — and ask the *other* provider first. A model
   * that cannot hold the shape once will usually fail the same way twice, so
   * repeating the request to the same one mostly buys a second identical
   * failure. A rate limit here is a rate limit, not a parse failure, so let
   * LlmError propagate untouched.
   */
  const other: Provider = first.call.provider === "gemini" ? "groq" : "gemini";
  const second = await attempt(options.system + STRICTER, other);
  if (second.validated !== null) {
    return { data: second.validated, call: second.call };
  }

  throw new UnreadableResponseError();
}

export { LlmError };
