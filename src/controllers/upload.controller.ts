/**
 * The two halves of an attachment, now that bytes no longer pass through here.
 *
 *   POST /api/chat/upload/sign      before: a ticket the browser uploads with
 *   POST /api/chat/upload/complete  after:  what that upload turned into
 *
 * The browser does the upload itself, straight to Cloudinary. Neither endpoint
 * accepts a file, which is what lets this run inside a 4.5MB function body
 * limit while still allowing a 20MB voice recording.
 *
 * The second endpoint is where the work happens: audio becomes a transcript,
 * a document becomes text, an image becomes a description. All three return
 * the same shape the chat endpoint already expects, so the change stops at
 * this file — engine.ts, prompts.ts and context.ts never knew about bytes.
 */

import type { Request, Response } from "express";

import { describeImage } from "../services/chat/vision.js";
import {
  extractDocumentFromUrl,
  UnreadableDocumentError,
} from "../services/upload/documents.js";
import {
  ACCEPTED_SUMMARY,
  SIZE_LIMITS,
  type AttachmentKind,
} from "../services/upload/mime.js";
import {
  createUploadTicket,
  deleteUpload,
  SignatureError,
  verifyUpload,
} from "../services/upload/signature.js";
import { transcribe } from "../services/upload/transcribe.js";
import { LlmError } from "../services/llm/index.js";

type UploadErrorCode =
  | "BAD_REQUEST"
  | "UNSUPPORTED_MEDIA"
  | "TOO_LARGE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR";

const STATUS: Record<UploadErrorCode, number> = {
  BAD_REQUEST: 400,
  UNSUPPORTED_MEDIA: 415,
  TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
};

function fail(response: Response, code: UploadErrorCode, message: string): void {
  response.status(STATUS[code]).json({ ok: false, error: { code, message } });
}

function body(request: Request): Record<string, unknown> {
  const raw = request.body;
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : {};
}

function toKind(value: unknown): AttachmentKind | null {
  return value === "image" || value === "audio" || value === "document"
    ? value
    : null;
}

/**
 * Hand out a ticket for one upload.
 *
 * The kind is the only thing the caller chooses, and it selects a preset:
 * folder, allowed formats, and for images the resize-and-strip transformation.
 * Nothing in the constraint set is caller-supplied, because every item in the
 * signed payload is a constraint and a caller who could set one could lift it.
 *
 * The size ceiling travels back in `maxBytes` but is not part of the
 * signature — Cloudinary will not sign it. It is advisory to the widget and
 * enforced for real in postCompleteUpload.
 */
export function postSignUpload(request: Request, response: Response): void {
  const kind = toKind(body(request).kind);

  if (!kind) {
    fail(
      response,
      "BAD_REQUEST",
      `Say what kind of file this is. Accepted: ${ACCEPTED_SUMMARY}.`,
    );
    return;
  }

  try {
    response.status(200).json({
      ok: true,
      data: createUploadTicket(kind, SIZE_LIMITS[kind]),
    });
  } catch (error) {
    console.error("[chat/upload/sign]", error);
    fail(
      response,
      "UPSTREAM_ERROR",
      error instanceof SignatureError
        ? error.message
        : "Attachments are unavailable right now.",
    );
  }
}

/** What the widget renders and what the chat call is given. */
interface CompletedUpload {
  kind: AttachmentKind;
  filename: string;
  text: string | null;
  note: string | null;
  url?: string;
  truncated?: boolean;
}

export async function postCompleteUpload(
  request: Request,
  response: Response,
): Promise<void> {
  const raw = body(request);
  const kind = toKind(raw.kind);

  if (!kind) {
    fail(response, "BAD_REQUEST", "That attachment has no type.");
    return;
  }

  const url = typeof raw.url === "string" ? raw.url : "";
  const format = typeof raw.format === "string" ? raw.format : undefined;
  const bytes = typeof raw.bytes === "number" ? raw.bytes : Number.NaN;
  const publicId = typeof raw.publicId === "string" ? raw.publicId : "";
  const filename =
    typeof raw.filename === "string"
      ? raw.filename.slice(0, 200)
      : "attachment";

  let verified;
  try {
    // Checks the URL is one this application issued a signature for, then
    // re-checks format and size from what Cloudinary reported. Both matter:
    // the first stops us fetching a stranger's URL, the second stops a real
    // upload being described to us as something it is not.
    verified = verifyUpload({ url, format, bytes }, kind, SIZE_LIMITS[kind]);
  } catch (error) {
    const message =
      error instanceof SignatureError ? error.message : "That attachment was rejected.";

    // Cloudinary stored it before we could refuse it — see the note on
    // max_file_size in signature.ts. Take it back out.
    if (publicId) await deleteUpload(publicId, kind);

    fail(
      response,
      message.includes("limit") ? "TOO_LARGE" : "UNSUPPORTED_MEDIA",
      message,
    );
    return;
  }

  try {
    if (kind === "audio") {
      const transcript = await transcribe(verified.url);
      const result: CompletedUpload = {
        kind,
        filename,
        text: transcript.text,
        note: null,
      };
      response.status(200).json({ ok: true, data: result });
      return;
    }

    if (kind === "document") {
      const extracted = await extractDocumentFromUrl(
        verified.url,
        SIZE_LIMITS.document,
      );
      const result: CompletedUpload = {
        kind,
        filename,
        text: extracted.text,
        note: null,
        truncated: extracted.truncated,
      };
      response.status(200).json({ ok: true, data: result });
      return;
    }

    // Images: Cloudinary has already resized, re-encoded and stripped metadata
    // on the way in, so all that remains is reading it. A vision failure is
    // not an upload failure — the image is attached either way, and the note
    // carries the reason so text chat continues around it.
    const vision = await describeImage(
      verified.url,
      "Someone attached this image to a chat message.",
    );

    const result: CompletedUpload = {
      kind,
      filename,
      text: vision.ok ? vision.description : null,
      note: vision.ok ? null : vision.reason,
      url: verified.url,
    };
    response.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error("[chat/upload/complete]", error);

    if (error instanceof UnreadableDocumentError) {
      fail(response, "BAD_REQUEST", error.message);
      return;
    }

    if (error instanceof LlmError) {
      fail(
        response,
        error.code === "RATE_LIMITED" ? "RATE_LIMITED" : "UPSTREAM_ERROR",
        error.code === "RATE_LIMITED"
          ? "Transcription is rate limited right now. Wait a moment and try again."
          : error.message,
      );
      return;
    }

    fail(response, "UPSTREAM_ERROR", "That attachment could not be processed.");
  }
}
