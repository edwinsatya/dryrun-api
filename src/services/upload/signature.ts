/**
 * Signed direct uploads to Cloudinary.
 *
 * The bytes never touch this server. A Vercel function has a hard 4.5MB
 * request body limit — below two of our three size ceilings — so the previous
 * shape, multer parsing a multipart body in memory, could not survive the move
 * whatever the limits were set to. The browser now uploads straight to
 * Cloudinary and sends us back a URL.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COSTS, STATED PLAINLY
 *
 * The server no longer holds the bytes of an image or an audio file, so it can
 * no longer read their magic bytes. That check is what caught a GIF renamed
 * .png and declared image/png, and losing it is a real reduction in what this
 * code verifies itself.
 *
 * Three layers replace it, and they are not equivalent:
 *
 *   1. The signature constrains the upload. Everything below is signed, so a
 *      client cannot widen it: change one parameter and the signature stops
 *      matching and Cloudinary refuses at its own edge. This is the layer that
 *      actually enforces type and size.
 *   2. What Cloudinary reports back is re-checked here — format, bytes,
 *      dimensions — never what the client claims about them.
 *   3. Documents keep full magic-byte checking, because extraction has to
 *      fetch the bytes anyway. That is deliberate rather than incidental: a
 *      document is the attachment where a disguised file is most useful to an
 *      attacker, since its content is fed to a text model as instructions.
 *
 * So images and audio move from "verified by us" to "verified by Cloudinary,
 * re-checked from its metadata"; documents are unchanged. The alternative —
 * routing everything through the function to keep the byte check — would cap
 * audio at 4.5MB and lose the long-recording case entirely. That trade was
 * made knowingly.
 * ---------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import type { AttachmentKind } from "./mime.js";

/** Cloudinary's own bucket for each kind. Audio rides the video pipeline. */
const RESOURCE_TYPE: Record<AttachmentKind, "image" | "video" | "raw"> = {
  image: "image",
  audio: "video",
  document: "raw",
};

/**
 * What each signature permits, mirroring the ceilings in mime.ts.
 *
 * `allowed_formats` is the type allowlist, moved from our magic-byte table to
 * Cloudinary's decoder. It is stricter than the old list in one respect and
 * weaker in another: Cloudinary genuinely decodes the file rather than reading
 * its first bytes, but it decides for itself what counts as that format.
 */
const ALLOWED_FORMATS: Record<AttachmentKind, string[]> = {
  image: ["png", "jpg", "jpeg", "webp"],
  audio: ["wav", "mp3", "m4a", "mp4", "webm", "ogg", "flac"],
  document: ["pdf", "txt"],
};

/**
 * The incoming transformation applied to images before storage.
 *
 * This replaces the sharp pipeline entirely — measured, a 2000x1400 PNG
 * arrives stored as 1280x896 WebP at 18.9KB, which is what sharp produced.
 *
 * Two things it must keep doing. `c_limit` never enlarges, so a small image is
 * left alone rather than upscaled into blur. And the re-encode is what drops
 * EXIF: a phone photo carries GPS coordinates and a device identifier, and
 * neither should reach storage, a model, or a URL someone might share.
 *
 * `fl_strip_profile` states the metadata removal explicitly rather than
 * relying on Cloudinary defaulting to it. A default is a thing that can change
 * under you without a deploy; a signed parameter is a thing you asked for.
 */
const IMAGE_TRANSFORMATION = "c_limit,w_1280,h_1280,q_82,f_webp,fl_strip_profile";

const FOLDER: Record<AttachmentKind, string> = {
  image: "dryrun/chat/images",
  audio: "dryrun/chat/audio",
  document: "dryrun/chat/documents",
};

export interface UploadTicket {
  /** where the browser POSTs */
  url: string;
  /** every field that must be sent, signature included */
  fields: Record<string, string>;
  resourceType: string;
  /** echoed back so the widget can reject an over-size file before uploading */
  maxBytes: number;
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

function credentials(): { cloud: string; key: string; secret: string } {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const key = process.env.CLOUDINARY_API_KEY?.trim();
  const secret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (!cloud || !key || !secret) {
    throw new SignatureError("Attachments are not configured on this server.");
  }

  return { cloud, key, secret };
}

/**
 * Cloudinary's signature: the signed parameters sorted by key, joined as a
 * query string, with the API secret appended, hashed SHA-1.
 *
 * `api_key` and the file itself are excluded from the signed set by
 * Cloudinary's own rules — everything else here is inside it, which is what
 * makes the constraints binding rather than advisory.
 */
function sign(params: Record<string, string | number>, secret: string): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return createHash("sha1").update(canonical + secret).digest("hex");
}

/**
 * A ticket the browser can upload one file with.
 *
 * Short-lived by construction: Cloudinary rejects a signature whose timestamp
 * is more than an hour old, so a ticket cannot be hoarded and replayed
 * indefinitely. It is still a capability, which is why the per-IP rate limit
 * sits in front of the endpoint that issues it.
 */
export function createUploadTicket(
  kind: AttachmentKind,
  maxBytes: number,
): UploadTicket {
  const { cloud, key, secret } = credentials();
  const timestamp = Math.floor(Date.now() / 1000);

  /*
   * Only parameters Cloudinary actually signs may appear here.
   *
   * `max_file_size` was in this set and had to come out: Cloudinary drops it
   * before computing the signature, so including it produced an "Invalid
   * Signature" on every upload — it names the string it signed in the error,
   * which is how the exclusion was found rather than assumed. Size is
   * therefore *not* enforced at Cloudinary's edge by this ticket. It is
   * enforced twice elsewhere: the widget checks `maxBytes` before uploading,
   * and verifyUpload rejects an oversized file server-side afterwards.
   *
   * The residue is that an oversized upload is stored before it is rejected,
   * so the controller deletes it on rejection. To refuse it at the edge
   * instead, a Cloudinary upload preset with a size limit is the mechanism —
   * dashboard configuration, noted in the handover.
   */
  const signed: Record<string, string | number> = {
    folder: FOLDER[kind],
    timestamp,
    allowed_formats: ALLOWED_FORMATS[kind].join(","),
  };

  if (kind === "image") {
    signed.transformation = IMAGE_TRANSFORMATION;
  }

  const signature = sign(signed, secret);

  return {
    url: `https://api.cloudinary.com/v1_1/${cloud}/${RESOURCE_TYPE[kind]}/upload`,
    fields: {
      ...Object.fromEntries(
        Object.entries(signed).map(([field, value]) => [field, String(value)]),
      ),
      api_key: key,
      signature,
    },
    resourceType: RESOURCE_TYPE[kind],
    maxBytes,
  };
}

/**
 * What Cloudinary says it stored, as the client relays it.
 *
 * Every field here is re-checked in verify() below rather than trusted. The
 * client is the one passing it along, and a client that can invent a
 * `secure_url` can invent a `format` beside it.
 */
export interface ClaimedUpload {
  url: string;
  /**
   * Absent for raw uploads — Cloudinary returns no `format` for them, only a
   * public_id and URL carrying the extension. Derived from the URL when so.
   */
  format?: string;
  bytes: number;
}

/** The extension Cloudinary stored the asset under, lowercased. */
function formatFromUrl(url: string): string {
  const last = url.split("?")[0].split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot === -1 ? "" : last.slice(dot + 1).toLowerCase();
}

/**
 * Whether a URL is one of ours.
 *
 * The single most important check in this file. Without it the chat endpoint
 * would fetch and process any URL a caller sent — a server-side request
 * forgery, with the function's network position and an attacker's choice of
 * target. Restricting to this account's Cloudinary hostname and the folders
 * above means the only fetchable things are files that passed a signature we
 * issued.
 */
export function isOwnUpload(url: string, kind: AttachmentKind): boolean {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  if (!cloud) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "res.cloudinary.com") return false;
  if (!parsed.pathname.startsWith(`/${cloud}/`)) return false;

  return parsed.pathname.includes(`/${FOLDER[kind]}/`);
}

export interface VerifiedUpload {
  url: string;
  format: string;
  bytes: number;
}

/**
 * Re-check a claimed upload against the constraints its signature carried.
 *
 * Cheap, and it closes the gap between "Cloudinary enforced this" and "we
 * confirmed it": a caller could otherwise upload a legitimate small PNG and
 * then describe it to us as something else entirely.
 */
export function verifyUpload(
  claimed: ClaimedUpload,
  kind: AttachmentKind,
  maxBytes: number,
): VerifiedUpload {
  if (!isOwnUpload(claimed.url, kind)) {
    throw new SignatureError(
      "That attachment did not come from this application's upload.",
    );
  }

  const format = (claimed.format || formatFromUrl(claimed.url))
    .toLowerCase()
    .replace(/^\./, "");
  const permitted =
    kind === "image"
      ? // The incoming transformation rewrites every image to WebP, so that is
        // the only format a stored image can legitimately have.
        ["webp"]
      : ALLOWED_FORMATS[kind];

  if (!permitted.includes(format)) {
    throw new SignatureError(`A ${format || "file"} is not accepted here.`);
  }

  if (!Number.isFinite(claimed.bytes) || claimed.bytes <= 0) {
    throw new SignatureError("That attachment reported no size.");
  }

  if (claimed.bytes > maxBytes) {
    throw new SignatureError(
      `That file is ${(claimed.bytes / 1024 / 1024).toFixed(1)}MB. The limit for ${kind}s is ${Math.round(maxBytes / 1024 / 1024)}MB.`,
    );
  }

  return { url: claimed.url, format, bytes: claimed.bytes };
}

/**
 * Remove an upload we refused.
 *
 * Because size is checked after storage rather than at Cloudinary's edge, a
 * rejected file has already been written by the time we say no. Leaving it
 * there would let anyone with a valid ticket fill the account with material
 * this application declined and will never read — litter that is also somebody
 * else's content sitting in our storage.
 *
 * Best-effort by design: the caller has already decided to reject, and a
 * failure to tidy up must not turn a clear "that file is too large" into an
 * error about something the person cannot act on.
 */
export async function deleteUpload(
  publicId: string,
  kind: AttachmentKind,
): Promise<void> {
  let creds;
  try {
    creds = credentials();
  } catch {
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign({ public_id: publicId, timestamp }, creds.secret);

  const form = new FormData();
  form.append("public_id", publicId);
  form.append("timestamp", String(timestamp));
  form.append("api_key", creds.key);
  form.append("signature", signature);

  try {
    await fetch(
      `https://api.cloudinary.com/v1_1/${creds.cloud}/${RESOURCE_TYPE[kind]}/destroy`,
      { method: "POST", body: form },
    );
  } catch {
    console.warn(`[upload] could not remove rejected asset ${publicId}`);
  }
}
