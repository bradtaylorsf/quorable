/**
 * Runtime unit discovery for long documents (plan §5.2).
 *
 * Naive chunk-and-summarize destroys the cross-references reviewers need;
 * the engine already thinks in units, so long documents get their units
 * discovered at runtime:
 *
 * 1. Map pass (one cheap call): structural map — units with boundaries, a
 *    synopsis per unit, and a whole-document summary.
 * 2. Unit-scoped review: each persona reviews one unit at a time with the
 *    unit's full text + global summary + neighboring synopses. Scores land
 *    per-unit exactly as with short documents.
 */

import { z } from "zod";

import { buildSchemaInstruction, INJECTION_GUARD } from "./prompts.js";
import { documentFromText } from "./parsers.js";
import { validatedCall } from "./validation.js";
import type { DocumentModel } from "./manifest.js";
import type { ChatMessage } from "../providers/types.js";
import type { ModelClient } from "../providers/registry.js";

/** Primary documents longer than this get unit discovery. */
export const UNIT_DISCOVERY_THRESHOLD_CHARS = 60_000;

export const DocumentMapSchema = z.object({
  summary: z.string(),
  units: z
    .array(
      z.object({
        name: z.string(),
        synopsis: z.string(),
        /**
         * VERBATIM first words of the unit (>= 8 words, copied exactly from
         * the document) — used to locate the unit boundary by string search.
         */
        start_quote: z.string(),
      }),
    )
    .min(2),
});

export type DocumentMap = z.infer<typeof DocumentMapSchema>;

export function buildMapMessages(documentText: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You produce structural maps of long documents for a review " +
        "harness. Split the document into its natural units (acts, " +
        "chapters, major sections) — between 3 and 12 of them. For each " +
        "unit provide a name, a one-paragraph synopsis, and start_quote: " +
        "the unit's first 8-15 words COPIED VERBATIM from the document " +
        "(the harness locates boundaries by exact string search, so " +
        "character-for-character fidelity matters). Also provide a " +
        "whole-document summary of 2-3 paragraphs." +
        INJECTION_GUARD,
    },
    {
      role: "user",
      content:
        `<document name="document">\n${documentText}\n</document>` +
        buildSchemaInstruction(DocumentMapSchema),
    },
  ];
}

export async function runMapPass(args: {
  /** null only when callFn is provided (no-network test path). */
  client: ModelClient | null;
  documentText: string;
  onWarning?: (msg: string) => void;
  callFn?: (messages: ChatMessage[]) => Promise<DocumentMap | null>;
}): Promise<DocumentMap | null> {
  const messages = buildMapMessages(args.documentText);
  if (args.callFn) return args.callFn(messages);
  return validatedCall(args.client!, messages, DocumentMapSchema, {
    temperature: 0.0,
    persona: "map_pass",
    onWarning: args.onWarning ?? (() => {}),
  });
}

export interface DiscoveredUnit {
  name: string;
  synopsis: string;
  text: string;
}

/**
 * Split the document at the map's start_quote markers. Quotes that cannot
 * be located fall back to merging into the previous unit (the text is
 * never dropped). Returns null when fewer than 2 boundaries resolve —
 * the caller should fall back to whole-document review.
 */
export function splitByMap(documentText: string, map: DocumentMap): DiscoveredUnit[] | null {
  const boundaries: { name: string; synopsis: string; index: number }[] = [];
  let searchFrom = 0;
  for (const unit of map.units) {
    const normalizedQuote = unit.start_quote.trim();
    const idx = documentText.indexOf(normalizedQuote, searchFrom);
    if (idx === -1) continue;
    boundaries.push({ name: unit.name, synopsis: unit.synopsis, index: idx });
    searchFrom = idx + normalizedQuote.length;
  }
  if (boundaries.length < 2) return null;
  // First unit starts at the top of the document regardless of its quote.
  boundaries[0]!.index = 0;
  const units: DiscoveredUnit[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i]!.index;
    const end = i + 1 < boundaries.length ? boundaries[i + 1]!.index : documentText.length;
    units.push({
      name: boundaries[i]!.name,
      synopsis: boundaries[i]!.synopsis,
      text: documentText.slice(start, end),
    });
  }
  return units;
}

/**
 * The per-unit review document set: the unit's full text, the global
 * summary, and the neighboring units' synopses (so cross-references
 * survive the scoping).
 */
export function unitReviewDocuments(
  map: DocumentMap,
  units: DiscoveredUnit[],
  unitIndex: number,
): DocumentModel[] {
  const unit = units[unitIndex]!;
  const neighborSynopses = units
    .map((u, i) =>
      i === unitIndex ? `### ${u.name} (UNDER REVIEW)` : `### ${u.name}\n${u.synopsis}`,
    )
    .join("\n\n");
  return [
    documentFromText("document_summary", map.summary, {
      role: "Whole-document summary (context for the unit under review)",
    }),
    documentFromText("unit_map", neighborSynopses, {
      role: "All units with synopses — the unit under review is marked",
    }),
    documentFromText(`unit_${unitIndex + 1}`, unit.text, {
      role: `Unit under review: ${unit.name}`,
    }),
  ];
}

/**
 * Merge per-unit reviews from the same (model, persona, run) into one
 * review object: unit_reviews concatenate; the review-level verdict is the
 * WORST category across units (categories are ordered best → worst).
 */
export function mergeUnitReviews(
  perUnit: Record<string, unknown>[],
  opts: { unitListField: string; verdictField: string; verdictCategories: string[] },
): Record<string, unknown> | null {
  const valid = perUnit.filter((r) => r !== null);
  if (valid.length === 0) return null;
  const merged: Record<string, unknown> = { ...valid[0] };
  const allUnits: unknown[] = [];
  let worstIndex = -1;
  const findings: unknown[] = [];
  const validationRequests: unknown[] = [];
  const injections: unknown[] = [];
  for (const review of valid) {
    const units = review[opts.unitListField];
    if (Array.isArray(units)) allUnits.push(...units);
    const verdict = String(review[opts.verdictField] ?? "");
    const idx = opts.verdictCategories.indexOf(verdict);
    if (idx > worstIndex) worstIndex = idx;
    for (const [key, sink] of [
      ["findings", findings],
      ["validation_requests", validationRequests],
      ["suspected_prompt_injection", injections],
    ] as const) {
      const value = review[key];
      if (Array.isArray(value)) sink.push(...value);
    }
  }
  merged[opts.unitListField] = allUnits;
  merged["findings"] = findings;
  merged["validation_requests"] = validationRequests;
  merged["suspected_prompt_injection"] = injections;
  if (worstIndex >= 0) {
    merged[opts.verdictField] = opts.verdictCategories[worstIndex];
  }
  return merged;
}
