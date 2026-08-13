/**
 * The cold reader (M6.1) — runs at EVERY rigor tier.
 *
 * One reviewer per run receives the document with NO rubric, no context
 * pack, no persona overlay: "you are the intended reader; react." Any
 * finding it produces that maps to no rubric dimension is a RUBRIC GAP —
 * the only signal in the system not conditioned on the author's priors.
 */

import { z } from "zod";

import { INJECTION_GUARD, buildSchemaInstruction } from "./prompts.js";
import { validatedCall } from "./validation.js";
import type { ModelClient } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";

export const ColdReactionSchema = z.object({
  reaction: z.string(),
  location: z.string().default(""),
  severity: z.number().int().min(1).max(5).default(3),
  /**
   * The reviewer's own guess at which rubric dimension (if any) covers this
   * reaction — but the cold reader never sees the rubric, so this is filled
   * by the MAPPING step below, not the cold read itself.
   */
  maps_to_dimension: z.string().nullable().default(null),
});

export const ColdReadSchema = z.object({
  overall_impression: z.string(),
  would_finish_reading: z.boolean(),
  reactions: z.array(ColdReactionSchema).default([]),
});

export type ColdRead = z.infer<typeof ColdReadSchema>;

/** The cold-read system prompt deliberately excludes rubric and context. */
export function buildColdReadMessages(
  coldReaderPrompt: string,
  documentText: string,
): ChatMessage[] {
  return [
    { role: "system", content: coldReaderPrompt + INJECTION_GUARD },
    {
      role: "user",
      content:
        `<document name="document">\n${documentText}\n</document>` +
        buildSchemaInstruction(ColdReadSchema),
    },
  ];
}

export async function runColdRead(args: {
  /** null only when callFn is provided (no-network test path). */
  client: ModelClient | null;
  coldReaderPrompt: string;
  documentText: string;
  temperature?: number;
  onWarning?: (msg: string) => void;
  callFn?: (messages: ChatMessage[]) => Promise<ColdRead | null>;
}): Promise<ColdRead | null> {
  const messages = buildColdReadMessages(args.coldReaderPrompt, args.documentText);
  if (args.callFn) return args.callFn(messages);
  return validatedCall(args.client!, messages, ColdReadSchema, {
    temperature: args.temperature ?? 0.6,
    persona: "cold_reader",
    onWarning: args.onWarning ?? (() => {}),
  });
}

const MappingSchema = z.object({
  mappings: z.array(
    z.object({
      reaction_index: z.number().int().min(0),
      dimension: z.string().nullable(),
    }),
  ),
});

/**
 * Map cold-read reactions onto rubric dimensions with one cheap call.
 * Reactions that map to NO dimension are rubric gaps. Falls back to
 * marking everything unmapped (all gaps surfaced, none hidden) if the
 * mapping call fails.
 */
export async function mapReactionsToDimensions(args: {
  /** null only when callFn is provided (no-network test path). */
  client: ModelClient | null;
  coldRead: ColdRead;
  dimensions: Record<string, string>;
  onWarning?: (msg: string) => void;
  callFn?: (messages: ChatMessage[]) => Promise<z.infer<typeof MappingSchema> | null>;
}): Promise<ColdRead> {
  if (args.coldRead.reactions.length === 0) return args.coldRead;
  const dimensionList = Object.entries(args.dimensions)
    .map(([name, desc]) => `- ${name}: ${desc || "(no description)"}`)
    .join("\n");
  const reactionList = args.coldRead.reactions
    .map((r, i) => `${i}. ${r.reaction} (at: ${r.location || "unspecified"})`)
    .join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You classify reader reactions against a scoring rubric. For each " +
        "reaction, name the ONE rubric dimension that covers it, or null if " +
        "no dimension covers it. Be strict: a reaction only maps when the " +
        "dimension would actually have caught it.",
    },
    {
      role: "user",
      content:
        `RUBRIC DIMENSIONS:\n${dimensionList}\n\nREADER REACTIONS:\n${reactionList}` +
        buildSchemaInstruction(MappingSchema),
    },
  ];
  const mapping = args.callFn
    ? await args.callFn(messages)
    : await validatedCall(args.client!, messages, MappingSchema, {
        temperature: 0.0,
        persona: "cold_read_mapper",
        onWarning: args.onWarning ?? (() => {}),
      });
  if (mapping === null) {
    args.onWarning?.(
      "Cold-read dimension mapping failed — treating every reaction as unmapped " +
        "(gaps surfaced, none hidden)",
    );
    return args.coldRead;
  }
  const byIndex = new Map(mapping.mappings.map((m) => [m.reaction_index, m.dimension]));
  const dimensionNames = new Set(Object.keys(args.dimensions));
  return {
    ...args.coldRead,
    reactions: args.coldRead.reactions.map((r, i) => {
      const dim = byIndex.get(i) ?? null;
      return { ...r, maps_to_dimension: dim !== null && dimensionNames.has(dim) ? dim : null };
    }),
  };
}

/** Reactions covering no rubric dimension — the rubric-gap report. */
export function rubricGaps(coldRead: ColdRead): ColdRead["reactions"] {
  return coldRead.reactions.filter((r) => r.maps_to_dimension === null);
}
