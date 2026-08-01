/**
 * Audio in, text out.
 *
 * The chat model never sees audio. Whisper runs first and the transcript is
 * what travels onward, which is not only a limitation worked around — it is
 * the cheaper and more inspectable path. A transcript can be shown to the
 * person who recorded it, corrected, and logged; a waveform cannot.
 *
 * On keeping the audio: the recording now lands in Cloudinary before it is
 * transcribed, which is a change worth being honest about. Previously the
 * bytes were discarded the moment the transcript came back; now they persist
 * in storage because that is the only way the transcriber can reach them
 * without passing through a 4.5MB function body.
 *
 * The original reasoning still holds — nothing replays audio, the widget
 * renders the transcript, chat state is memory-only — so the stored file has
 * no reader. It should therefore not be kept indefinitely, and the handover
 * notes a Cloudinary auto-delete rule on the audio folder as the way to say
 * so. That is a configuration step, not a code one, which is exactly why it
 * needs writing down rather than assuming.
 */

import { LlmError } from "../llm/types.js";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Whisper large v3 turbo, on its own quota.
 *
 * Deliberately not the model the chat runs on: transcription bills against a
 * separate bucket (2,000 requests and 7,200 audio-seconds a day) that the
 * interview never touches, so speech cannot consume the scored path's budget.
 */
const MODEL = "whisper-large-v3-turbo";

export interface Transcript {
  text: string;
  model: string;
}

/**
 * Transcribe audio that already lives at a URL.
 *
 * The endpoint takes a `url` instead of a file, and Groq fetches it itself —
 * verified against a real Cloudinary URL before this was written. That is what
 * makes the 4.5MB function body limit irrelevant to audio: the bytes travel
 * browser → Cloudinary → Groq and never enter this process at all, so a long
 * recording costs the same here as a short one.
 *
 * The caller must have checked the URL is one of ours. Handing a caller's
 * arbitrary URL to a third party to fetch would be request forgery with extra
 * steps — see isOwnUpload in signature.ts.
 */
export async function transcribe(
  audioUrl: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    throw new LlmError("NO_API_KEY", "GROQ_API_KEY is not set.", {
      retryable: false,
    });
  }

  const form = new FormData();
  form.append("url", audioUrl);
  form.append("model", MODEL);
  form.append("response_format", "json");

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal,
    });
  } catch {
    if (signal?.aborted) {
      throw new LlmError("TIMEOUT", "Transcription did not finish in time.", {
        retryable: true,
      });
    }
    throw new LlmError("UPSTREAM_ERROR", "Could not reach the transcriber.", {
      retryable: true,
    });
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new LlmError("RATE_LIMITED", "Transcription limit reached.", {
        retryable: true,
        status: 429,
      });
    }
    const detail = await response.text().catch(() => "");
    throw new LlmError(
      "UPSTREAM_ERROR",
      `Transcription failed with ${response.status}. ${detail.slice(0, 160)}`,
      { retryable: response.status >= 500, status: response.status },
    );
  }

  const data = (await response.json()) as { text?: string };
  const text = data.text?.trim() ?? "";

  // Silence transcribes to an empty string, which is a real outcome worth
  // naming rather than passing on as a blank attachment.
  if (!text) {
    throw new LlmError(
      "EMPTY_RESPONSE",
      "No speech could be heard in that recording.",
      { retryable: false },
    );
  }

  return { text, model: MODEL };
}
