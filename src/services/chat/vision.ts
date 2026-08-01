/**
 * Reading an image, for the assistant only.
 *
 * Deliberately outside the provider chain in services/llm. That chain is what
 * the interview runs on, and this is an open surface a stranger can point at
 * with a file. Keeping vision on its own path means a vision failure has no
 * route into the scored path: nothing here throws LlmError, nothing here
 * touches the circuit breaker, and every failure returns a reason the widget
 * can render while text chat carries on.
 *
 * On the bucket: measured, qwen3.6-27b's 8,000 TPM is its own. Spending it
 * does not move gpt-oss-120b's remaining tokens, which is what the interview
 * now runs on. The cap below is therefore not protecting the interview from
 * starvation — it cannot starve it — but bounding what an open endpoint can
 * spend, and keeping the widget's own capability available across a day rather
 * than exhausted in the first minute.
 */

import { kvGet, kvIncrement } from "../../utils/redis.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** The one Groq model in our list that accepts image content. */
const VISION_MODEL = "qwen/qwen3.6-27b";

/**
 * Vision requests allowed per day, server-wide.
 *
 * 60, from the measurements. One image costs a flat 1,301 prompt tokens
 * whatever its size, plus the completion ceiling below — call it 1,900
 * reserved against an 8,000 TPM bucket, so roughly four images a minute is the
 * hard ceiling regardless of any cap. 60 a day is ~6% of the model's 1,000
 * daily requests, which leaves the quota essentially untouched, while being
 * more image questions than this app will genuinely field in a day. A scripted
 * abuse loop hits the wall in about fifteen seconds and gets a clear message
 * rather than a quota this app then has to live without.
 */
const DAILY_VISION_LIMIT = 60;

/**
 * The completion ceiling for a vision reply.
 *
 * This is a real TPM lever, unlike resolution: Groq reserves max_tokens
 * against the bucket up front, so asking for 2,048 costs 2,048 whether or not
 * the model uses them. 600 is ample for describing an image in a chat reply.
 */
const MAX_COMPLETION_TOKENS = 600;

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * The counter lives in Redis, for the same reason the rate limiter's does.
 *
 * A per-process counter would have made "60 a day" mean "60 per container",
 * and containers are created on demand — so the cap would have been whatever
 * traffic decided it was, while reporting a tidy 60 on /api/chat/budget. Of
 * the two guards that fail open this is the quieter one: nothing about a
 * missing usage cap is visible until the quota it protects is gone.
 *
 * One key, not one per caller: this is a server-wide daily budget, and the
 * per-IP limiting that stops one visitor monopolising it is rateLimit's job.
 */
const VISION_KEY = "vision:daily";

export interface VisionBudget {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: number;
}

export async function visionBudget(): Promise<VisionBudget> {
  const used = (await kvGet<number>(VISION_KEY)) ?? 0;
  return {
    used,
    limit: DAILY_VISION_LIMIT,
    remaining: Math.max(0, DAILY_VISION_LIMIT - used),
    resetsAt: Date.now() + DAY_MS,
  };
}

/**
 * Qwen narrates its reasoning inside <think> tags before answering.
 *
 * That is working as designed for the model and useless in a chat bubble, so
 * it is removed here rather than in the UI: the reasoning should not travel
 * over the wire at all. An unclosed tag is handled too — a reply truncated
 * mid-thought would otherwise render as raw reasoning with no answer.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

export type VisionOutcome =
  | { ok: true; description: string; model: string }
  | { ok: false; reason: string };

/**
 * Describe an image, or explain why not.
 *
 * Never throws. Every path returns a sentence the widget can show, because the
 * contract with the rest of the app is that vision degrades on its own and
 * takes nothing else down with it.
 */
export async function describeImage(
  imageUrl: string,
  question: string,
  signal?: AbortSignal,
): Promise<VisionOutcome> {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return { ok: false, reason: "Image reading is not configured on this server." };
  }

  /*
   * Counted on attempt, not on success — a failing loop still spends the
   * upstream quota, so counting only successes would leave the cap guarding
   * the one case that costs nothing.
   *
   * Incremented before the call rather than after it, so two requests arriving
   * together cannot both read 59 and both proceed. An unreachable store
   * returns null and the request is allowed: consistent with the rate limiter,
   * and the degradation is logged there once.
   */
  const window = await kvIncrement(VISION_KEY, DAY_MS);

  if (window && window.count > DAILY_VISION_LIMIT) {
    return {
      ok: false,
      reason:
        "The daily limit for reading images has been reached. Text chat still works, and image reading resets tomorrow.",
    };
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: MAX_COMPLETION_TOKENS,
        temperature: 0.3,
        /*
         * Qwen is a reasoning model and thinks before it answers. Left alone
         * it spent 571 of a 600-token budget inside <think>, never closed the
         * tag, and returned a reply that was pure reasoning with no answer in
         * it — indistinguishable, from outside, from a model that saw nothing.
         *
         * "none" is one of only two values this model accepts. Turning
         * reasoning off is right on both counts here: describing a picture
         * needs no deliberation, and the tokens it was spending were charged
         * against a bucket this feature is supposed to be frugal with.
         */
        reasoning_effort: "none",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `${question}\n\nDescribe what this image shows, in enough detail that ` +
                  `someone who cannot see it could discuss it. If it contains code, ` +
                  `read the code out. Answer directly, with no preamble.`,
              },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return {
          ok: false,
          reason:
            "Image reading is briefly rate limited. Text chat still works — try the image again in a minute.",
        };
      }
      return { ok: false, reason: "That image could not be read just now." };
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const description = stripThinking(raw);

    if (!description) {
      // Reasoning that never reached an answer is a different fault from an
      // image the model could not read, and pointing at the image would send
      // someone off to re-crop a screenshot that was never the problem.
      return {
        ok: false,
        reason: raw.trim()
          ? "The image model spent its budget thinking and did not answer. Try attaching it again."
          : "Nothing could be made out in that image.",
      };
    }

    return { ok: true, description, model: VISION_MODEL };
  } catch {
    return { ok: false, reason: "That image could not be read just now." };
  }
}
