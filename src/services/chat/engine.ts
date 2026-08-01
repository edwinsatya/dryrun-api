/**
 * One assistant reply.
 *
 * Runs on the same provider chain as the interview — the timeout, the single
 * retry, the reserve and the fallback logging are all inherited rather than
 * reimplemented, which is the point of that chain being one function.
 *
 * Two things are deliberately different. The chat scope is per-client, not per
 * candidate, so a stranger's dead session cannot open the circuit on a
 * candidate mid-interview. And no schema is requested: this reply is prose,
 * and asking for JSON would spend tokens on quoting and escaping it.
 */

import { landingSystemPrompt, profileSystemPrompt } from "./prompts.js";
import type { ProfileContext } from "./context.js";
import { chat, type ChatMessage, type ChatResult } from "../llm/index.js";

/**
 * How many prior turns travel with a message.
 *
 * Twelve — six exchanges. Long enough that "what did I just ask?" and a
 * follow-up pronoun both resolve, short enough that the prompt cannot grow
 * without bound on an endpoint anyone can post to repeatedly. Beyond six
 * exchanges a chat assistant is being used as a notepad, and the profile
 * context matters more to the answer than turn eleven does. The cap is applied
 * server-side, so a client sending two hundred turns gets the last twelve.
 */
export const MAX_HISTORY_TURNS = 12;

/** Room for a considered answer without inviting an essay. */
const MAX_REPLY_TOKENS = 700;

export interface Attachment {
  kind: "image" | "audio" | "document";
  /** filename for a document, null otherwise */
  filename?: string | null;
  /** transcript, extracted text, or the vision description */
  text?: string | null;
  /** set when an attachment could not be processed */
  note?: string | null;
}

export interface ChatReply {
  text: string;
  provider: ChatResult["provider"];
  model: string;
}

/**
 * Attachments reach the model as text, always.
 *
 * By this point audio has been transcribed, a document has been extracted and
 * an image has been described by the vision model. Folding them into the user
 * turn rather than a separate system block keeps them attached to the message
 * they arrived with, which is what makes "what does this say?" resolvable.
 */
function withAttachment(message: string, attachment?: Attachment): string {
  if (!attachment) return message;

  if (attachment.note) {
    return `${message}\n\n[The person attached ${attachment.kind === "document" ? "a document" : `${attachment.kind === "image" ? "an image" : "a recording"}`}, but it could not be read: ${attachment.note} Say so briefly and answer whatever you can.]`;
  }

  const body = attachment.text ?? "";

  switch (attachment.kind) {
    case "audio":
      return `${message}\n\n[Transcript of an attached voice recording:]\n${body}`;
    case "document":
      return `${message}\n\n[Text extracted from an attached document${attachment.filename ? ` named ${attachment.filename}` : ""}:]\n${body}`;
    case "image":
      return `${message}\n\n[Description of an attached image, read by an image model:]\n${body}`;
  }
}

export async function answer(options: {
  message: string;
  history: ChatMessage[];
  context: ProfileContext | null;
  attachment?: Attachment;
  /** per-client circuit-breaker scope, kept away from the interview's */
  scope: string;
}): Promise<ChatReply> {
  const system = options.context
    ? profileSystemPrompt(options.context)
    : landingSystemPrompt();

  // Trailing turns, not leading ones: recency is what a follow-up depends on.
  const history = options.history.slice(-MAX_HISTORY_TURNS);

  const result = await chat({
    system,
    messages: [
      ...history,
      { role: "user", content: withAttachment(options.message, options.attachment) },
    ],
    maxTokens: MAX_REPLY_TOKENS,
    temperature: 0.6,
    scope: options.scope,
  });

  return { text: result.text, provider: result.provider, model: result.model };
}
