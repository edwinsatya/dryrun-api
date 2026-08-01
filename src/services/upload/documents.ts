/**
 * Documents in, text out.
 *
 * Raw bytes never reach the model. A PDF is a container format with fonts,
 * images and an object graph inside it; handing those to a text model wastes
 * the budget on structure nobody asked about. Extraction happens here and the
 * model sees prose.
 */

import { extractText, getDocumentProxy } from "unpdf";

import { detectType } from "./mime.js";

/**
 * How much extracted text may travel with one message.
 *
 * 12,000 characters is roughly 3,000 tokens — enough for a CV, a README or a
 * long spec section, and small enough that a document cannot crowd out the
 * profile context and the conversation it is supposed to be discussed against.
 */
export const MAX_EXTRACTED_CHARS = 12_000;

/** Said in the text itself, so the model knows the tail is missing. */
export const TRUNCATION_MARKER =
  "\n\n[… truncated: the document continues beyond what was read.]";

export class UnreadableDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableDocumentError";
  }
}

export interface ExtractedDocument {
  text: string;
  truncated: boolean;
  /** pages for a PDF, null for plain text */
  pages: number | null;
}

/**
 * Cut to the cap and say so.
 *
 * Silent truncation is the failure worth avoiding: the model answers
 * confidently about a document whose second half it never saw, and nothing in
 * the reply reveals that. The marker is inside the text so it reaches the
 * model, not only the UI.
 */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXTRACTED_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_EXTRACTED_CHARS) + TRUNCATION_MARKER,
    truncated: true,
  };
}

async function extractPdf(buffer: Buffer): Promise<ExtractedDocument> {
  let raw: string;
  let pages: number;

  try {
    const document = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(document, { mergePages: true });
    raw = Array.isArray(result.text) ? result.text.join("\n") : result.text;
    pages = result.totalPages;
  } catch {
    throw new UnreadableDocumentError(
      "That PDF could not be read. It may be encrypted or damaged.",
    );
  }

  const trimmed = raw.replace(/\s+\n/g, "\n").trim();

  /*
   * A scanned PDF is images of text: extraction succeeds and returns almost
   * nothing. Saying "no text" is honest and points at the real fix, where
   * passing the empty string on would produce an answer about a blank page.
   */
  if (trimmed.length < 20) {
    throw new UnreadableDocumentError(
      "No text could be read from that PDF — it looks like a scan or images rather than text.",
    );
  }

  const { text, truncated } = cap(trimmed);
  return { text, truncated, pages };
}

function extractPlainText(buffer: Buffer): ExtractedDocument {
  const trimmed = buffer.toString("utf8").trim();

  if (!trimmed) {
    throw new UnreadableDocumentError("That file is empty.");
  }

  const { text, truncated } = cap(trimmed);
  return { text, truncated, pages: null };
}

/**
 * How long the document fetch may take, and how much of it we will hold.
 *
 * The fetch is outbound, so the 4.5MB request-body limit does not apply — but
 * function memory and duration still do, and a URL that streams slowly must
 * not be allowed to spend the invocation.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Pull a document we uploaded and turn it into text.
 *
 * This is the one attachment kind whose bytes still reach this process, and
 * that is a deliberate consequence rather than an accident: extraction needs
 * them regardless, so the magic-byte check survives here in full. Documents
 * are also where it matters most — extracted text is fed to a model as
 * material, so a file pretending to be plain text is the attachment most worth
 * disguising.
 *
 * The caller must have established the URL is ours. `maxBytes` is enforced
 * again from the response rather than trusted from the upload record.
 */
export async function extractDocumentFromUrl(
  url: string,
  maxBytes: number,
): Promise<ExtractedDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let buffer: Buffer;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new UnreadableDocumentError("That document could not be retrieved.");
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw new UnreadableDocumentError(
        `That document is larger than the ${Math.round(maxBytes / 1024 / 1024)}MB limit.`,
      );
    }

    buffer = Buffer.from(bytes);
  } catch (error) {
    if (error instanceof UnreadableDocumentError) throw error;
    throw new UnreadableDocumentError("That document could not be retrieved.");
  } finally {
    clearTimeout(timer);
  }

  /*
   * The bytes decide what this is, not the extension Cloudinary stored it
   * under and not anything the client said. This is the check that direct
   * upload cost us for images and audio; it is kept intact here.
   */
  const detected = detectType(buffer);
  if (!detected || detected.kind !== "document") {
    throw new UnreadableDocumentError(
      "That file is not a PDF or a text document.",
    );
  }

  return detected.mime === "application/pdf"
    ? extractPdf(buffer)
    : extractPlainText(buffer);
}
