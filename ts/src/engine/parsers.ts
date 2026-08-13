/**
 * Document parsers → DocumentModel, ported from parsers.py (M8 widens the
 * format set: markdown/txt, YAML, PDF via the official MuPDF WASM package,
 * and .docx via raw XML text extraction).
 *
 * The never-truncate-primary rule is kept: the primary document fails
 * loudly at the 200K character cap; everything else truncates with a
 * marker.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { DocumentModel, ManifestEntry } from "./manifest.js";

export const MAX_CHARS = 200_000;

export class PrimaryDocTooLargeError extends Error {
  override name = "PrimaryDocTooLargeError";
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function enforceCharLimit(
  content: string,
  name: string,
  primaryDocName: string | null,
): string {
  if (content.length <= MAX_CHARS) return content;
  if (primaryDocName !== null && name === primaryDocName) {
    throw new PrimaryDocTooLargeError(
      `Primary document '${name}' is ${content.length.toLocaleString("en-US")} chars, ` +
        `exceeding the ${MAX_CHARS.toLocaleString("en-US")} char hard limit. This is ` +
        `not allowed — the primary document must never be truncated. ` +
        `(Long documents go through runtime unit discovery instead.)`,
    );
  }
  return content.slice(0, MAX_CHARS) + "\n\n[… TRUNCATED at 200,000 characters …]";
}

// ---------------------------------------------------------------------------
// Format-specific parsers
// ---------------------------------------------------------------------------

async function parsePdf(filePath: string): Promise<[string, number]> {
  // Dynamic import: mupdf WASM is heavy; only load when a PDF is actually parsed.
  const mupdf = await import("mupdf");
  const data = fs.readFileSync(filePath);
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  const pageCount = doc.countPages();
  const pages: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const structured = JSON.parse(page.toStructuredText().asJSON()) as {
      blocks?: { lines?: { text?: string }[] }[];
    };
    const text = (structured.blocks ?? [])
      .map((b) => (b.lines ?? []).map((l) => l.text ?? "").join("\n"))
      .join("\n");
    pages.push(`[p.${i + 1}]\n${text}`);
  }
  return [pages.join("\n\n"), pageCount];
}

function parseMarkdown(filePath: string): [string, number] {
  const buf = fs.readFileSync(filePath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("latin1").decode(buf);
  }
  return [text, 1];
}

function parseYamlDoc(filePath: string): [string, number] {
  const data = parseYaml(fs.readFileSync(filePath, "utf-8"));
  return [stringifyYaml(data), 1];
}

/**
 * Minimal .docx text extraction: document.xml paragraphs → lines. No
 * styling; enough for review context (M8 — the shorts world-bible case).
 */
async function parseDocx(filePath: string): Promise<[string, number]> {
  const { default: zlib } = await import("node:zlib");
  const buf = fs.readFileSync(filePath);
  const documentXml = extractZipEntry(buf, "word/document.xml", zlib);
  if (documentXml === null) {
    throw new Error(`Not a valid .docx (no word/document.xml): ${filePath}`);
  }
  const xml = documentXml.toString("utf-8");
  const paragraphs: string[] = [];
  for (const pMatch of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const runs = [...pMatch[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1]!)
      .join("");
    paragraphs.push(decodeXmlEntities(runs));
  }
  return [paragraphs.join("\n"), 1];
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Tiny ZIP reader: find one entry via the end-of-central-directory record. */
function extractZipEntry(
  buf: Buffer,
  entryName: string,
  zlib: typeof import("node:zlib"),
): Buffer | null {
  // Locate EOCD (no comment or short comment assumed).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf-8");
    if (name === entryName) {
      const localOffset = buf.readUInt32LE(offset + 42);
      const method = buf.readUInt16LE(offset + 10);
      const compSize = buf.readUInt32LE(offset + 20);
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function parseDocument(
  entry: ManifestEntry,
  opts: { primaryDocName?: string | null } = {},
): Promise<DocumentModel> {
  const primaryDocName = opts.primaryDocName ?? null;
  if (!fs.existsSync(entry.path)) {
    throw new Error(`Document not found: ${entry.path}`);
  }

  let rawContent: string;
  let pageCount: number;
  switch (entry.format) {
    case "pdf":
      [rawContent, pageCount] = await parsePdf(entry.path);
      break;
    case "markdown":
      [rawContent, pageCount] = parseMarkdown(entry.path);
      break;
    case "yaml":
      [rawContent, pageCount] = parseYamlDoc(entry.path);
      break;
    case "docx":
      [rawContent, pageCount] = await parseDocx(entry.path);
      break;
    default:
      throw new Error(`Unknown document format '${entry.format}' for ${entry.name}`);
  }

  const content = enforceCharLimit(rawContent, entry.name, primaryDocName);
  return {
    name: entry.name,
    role: entry.role,
    tier: entry.tier,
    content,
    pageCount,
    charCount: content.length,
    sha256: sha256Text(content),
    truncated: rawContent.length > MAX_CHARS,
  };
}

/** Build a DocumentModel from in-memory text (revision loop, unit review). */
export function documentFromText(
  name: string,
  text: string,
  opts: { role?: string; tier?: number } = {},
): DocumentModel {
  return {
    name,
    role: opts.role ?? "",
    tier: opts.tier ?? 1,
    content: text,
    pageCount: 1,
    charCount: text.length,
    sha256: sha256Text(text),
    truncated: false,
  };
}

/** Parse every manifest entry that exists; loader errors surface as warnings. */
export async function prepareDocuments(
  entries: ManifestEntry[],
  opts: { primaryDocName?: string | null; onWarning?: (msg: string) => void } = {},
): Promise<Record<string, DocumentModel>> {
  const documents: Record<string, DocumentModel> = {};
  for (const entry of entries) {
    if (!fs.existsSync(entry.path)) continue;
    try {
      documents[entry.name] = await parseDocument(entry, {
        primaryDocName: opts.primaryDocName ?? null,
      });
    } catch (exc) {
      if (exc instanceof PrimaryDocTooLargeError) throw exc;
      opts.onWarning?.(
        `Failed to parse ${entry.name}: ${exc instanceof Error ? exc.message : exc}`,
      );
    }
  }
  return documents;
}
