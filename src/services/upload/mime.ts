/**
 * What a file actually is, decided by its bytes.
 *
 * The declared Content-Type and the filename are both attacker-controlled, so
 * neither decides anything here. A .png that begins with %PDF- is a PDF, and a
 * caller who says "image/png" about a 40MB video is simply wrong.
 *
 * Hand-rolled rather than a dependency: the allowlist is a dozen formats, each
 * identified by a handful of leading bytes, and `file-type` cannot recognise
 * plain text anyway — the one case here that has no signature at all and needs
 * a decode heuristic instead.
 */

export type AttachmentKind = "image" | "audio" | "document";

export interface DetectedType {
  kind: AttachmentKind;
  /** the canonical type, which may differ from what the client declared */
  mime: string;
  label: string;
}

/**
 * Per-kind size ceilings.
 *
 * Images 8MB: a modern phone screenshot or photo lands at 3–6MB, and the file
 * is downscaled server-side before it goes anywhere, so the ceiling only has
 * to survive the upload.
 *
 * Audio 20MB: Groq's transcription endpoint refuses files over 25MB on this
 * tier, so the limit sits below the one that would fail upstream. 20MB is
 * already far longer than anything anyone types a chat message about.
 *
 * Documents 10MB: a CV or README is well under 1MB; 10MB leaves room for a
 * scanned PDF while bounding how much work extraction can be asked to do.
 */
export const SIZE_LIMITS: Record<AttachmentKind, number> = {
  image: 8 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  document: 10 * 1024 * 1024,
};

interface Signature {
  kind: AttachmentKind;
  mime: string;
  label: string;
  /** bytes that must match at `offset` */
  magic: number[];
  offset?: number;
  /** a second run of bytes that must also match, for container formats */
  also?: { offset: number; magic: number[] };
}

const ascii = (text: string): number[] =>
  [...text].map((character) => character.charCodeAt(0));

const SIGNATURES: Signature[] = [
  // Images
  {
    kind: "image",
    mime: "image/png",
    label: "PNG image",
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { kind: "image", mime: "image/jpeg", label: "JPEG image", magic: [0xff, 0xd8, 0xff] },
  {
    kind: "image",
    mime: "image/webp",
    label: "WebP image",
    magic: ascii("RIFF"),
    also: { offset: 8, magic: ascii("WEBP") },
  },

  // Audio. WAV shares the RIFF container with WebP, so both check the subtype.
  {
    kind: "audio",
    mime: "audio/wav",
    label: "WAV audio",
    magic: ascii("RIFF"),
    also: { offset: 8, magic: ascii("WAVE") },
  },
  { kind: "audio", mime: "audio/mpeg", label: "MP3 audio", magic: ascii("ID3") },
  { kind: "audio", mime: "audio/mpeg", label: "MP3 audio", magic: [0xff, 0xfb] },
  { kind: "audio", mime: "audio/mpeg", label: "MP3 audio", magic: [0xff, 0xf3] },
  { kind: "audio", mime: "audio/mpeg", label: "MP3 audio", magic: [0xff, 0xf2] },
  {
    kind: "audio",
    mime: "audio/mp4",
    label: "M4A audio",
    magic: ascii("ftyp"),
    offset: 4,
  },
  // Matroska carries both audio and video; MediaRecorder produces it for voice.
  { kind: "audio", mime: "audio/webm", label: "WebM audio", magic: [0x1a, 0x45, 0xdf, 0xa3] },
  { kind: "audio", mime: "audio/ogg", label: "Ogg audio", magic: ascii("OggS") },
  { kind: "audio", mime: "audio/flac", label: "FLAC audio", magic: ascii("fLaC") },

  // Documents
  { kind: "document", mime: "application/pdf", label: "PDF document", magic: ascii("%PDF-") },
];

function matches(buffer: Buffer, magic: number[], offset = 0): boolean {
  if (buffer.length < offset + magic.length) return false;
  return magic.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Whether this looks like text a person wrote, rather than binary with no
 * signature.
 *
 * Decoded strictly as UTF-8, then rejected if it carries control characters
 * that never appear in prose. A NUL byte is the giveaway: no text file has
 * one, and most binaries have many.
 */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;

  const sample = buffer.subarray(0, 8192);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return false;
  }

  // Tab, newline and carriage return are the only control codes prose uses.
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
}

/** The file's real type, or null when it is not one we accept. */
export function detectType(buffer: Buffer): DetectedType | null {
  for (const signature of SIGNATURES) {
    if (!matches(buffer, signature.magic, signature.offset ?? 0)) continue;
    if (signature.also && !matches(buffer, signature.also.magic, signature.also.offset)) {
      continue;
    }
    return { kind: signature.kind, mime: signature.mime, label: signature.label };
  }

  if (looksLikeText(buffer)) {
    return { kind: "document", mime: "text/plain", label: "text file" };
  }

  return null;
}

/** Every format a person could reasonably try, named the way they would say it. */
export const ACCEPTED_SUMMARY =
  "PNG, JPEG or WebP images; WAV, MP3, M4A, WebM, Ogg or FLAC audio; PDF or plain text documents";
