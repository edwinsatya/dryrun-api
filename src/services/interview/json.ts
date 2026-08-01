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

/**
 * The index just past the object that opens at `start`, or -1 if it never
 * closes.
 *
 * Brace counting has to know about strings, because a brace inside a string
 * value is not structure — `{"q":"use {} here"}` closes at the last brace, not
 * the first one that balances the count.
 */
function endOfObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

/**
 * The first complete JSON object in the model's reply, or null.
 *
 * The rule that matters is what this *refuses*. It used to slice from the
 * first `{` to the last `}`, which meant a reply containing one good object
 * followed by anything else parsed as the good object and the rest vanished.
 * That is the worst possible behaviour for a degenerate model: a run that
 * repeats itself, or stops mid-thought and starts again, looked from the
 * outside exactly like a clean answer. The truncation was invisible, so
 * nothing retried and nothing was logged.
 *
 * So: find the first object that actually balances, and reject when structure
 * follows it. Trailing prose is still forgiven — "…and that's the JSON" is a
 * model being chatty, not a model degenerating — but a second `{` means the
 * reply is not one object, and the caller is told rather than shown the first
 * one. Rejecting returns null, which is the existing signal for unreadable:
 * jsonCall retries once and then throws UnreadableResponseError.
 */
export function extractJson<T>(raw: string): T | null {
  let text = raw.trim();

  // ```json … ``` or ``` … ```
  text = text
    .replace(/^```(?:json)?[ \t]*\r?\n?/i, "")
    .replace(/\r?\n?```$/i, "")
    .trim();

  // Anything the model said before the object.
  const start = text.indexOf("{");
  if (start === -1) return null;

  // Never closed: the reply was cut off mid-object. Unreadable, not salvage.
  const end = endOfObject(text, start);
  if (end === -1) return null;

  const candidate = text.slice(start, end);
  const rest = text.slice(end);

  // Any structure after a complete object — a repetition, a second answer, or
  // stray closers — means this reply is not the one object it was asked for.
  // Prose is still forgiven; braces are not.
  if (/[{}]/.test(rest)) return null;

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
  /** The candidate's login — one interview is one circuit-breaker scope. */
  scope?: string;
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
      scope: options.scope,
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
