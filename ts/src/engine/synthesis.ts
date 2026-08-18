/**
 * Stage 2 cross-model synthesis, ported from synthesis.py.
 *
 * One call to the synthesis model with all Stage-1 reviews as input.
 * Agreement statistics are computed in code and PATCHED OVER the LLM
 * output; reviewer counts are sanity-clamped; ranked-fix priority scores
 * are recomputed in code. LLM arithmetic is never trusted.
 */

import type { z } from "zod";

import { computeAgreement, type AgreementPackView } from "./agreement.js";
import { DOC_DELIMITER, hardenSystemPrompt } from "./prompts.js";
import { recomputeRankedFixes } from "./scoring.js";
import { validatedCall } from "./validation.js";
import type { DocumentModel } from "./manifest.js";
import type { ReviewResult } from "./pipeline.js";
import type { ChatMessage } from "../providers/types.js";
import type { ModelClient } from "../providers/registry.js";
import { buildSchemaInstruction } from "./prompts.js";

function formatReviewsForPrompt(results: ReviewResult[]): string {
  const parts: string[] = [];
  for (const r of results) {
    if (r.review === null) continue;
    const label = `REVIEW: model=${r.model} persona=${r.persona} run=${r.runNumber}`;
    parts.push(`${label}\n${JSON.stringify(r.review, null, 2)}`);
  }
  return parts.join("\n" + "=".repeat(60) + "\n");
}

export function buildSynthesisMessages(args: {
  systemPrompt: string;
  synthesisPrompt: string;
  results: ReviewResult[];
  documents: DocumentModel[];
  schema: z.ZodType;
}): ChatMessage[] {
  const parts: string[] = [];
  parts.push("SYNTHESIS INSTRUCTIONS:\n" + args.synthesisPrompt);
  parts.push(DOC_DELIMITER + "STAGE 1 REVIEWS" + DOC_DELIMITER + formatReviewsForPrompt(args.results));
  if (args.documents.length > 0) {
    parts.push(DOC_DELIMITER + "REFERENCE DOCUMENTS" + DOC_DELIMITER);
    for (const doc of args.documents) {
      parts.push(`DOCUMENT: ${doc.name}\nROLE: ${doc.role}\n` + "-".repeat(40) + "\n" + doc.content);
    }
  }
  parts.push(buildSchemaInstruction(args.schema));
  return [
    { role: "system", content: hardenSystemPrompt(args.systemPrompt) },
    { role: "user", content: parts.join(DOC_DELIMITER) },
  ];
}

/**
 * The prose instruction used when strict JSON has defeated the synthesizer.
 * Section headings are fixed so the report has a predictable shape, and the
 * model is told explicitly not to invent numbers: every score, statistic and
 * gate result on the page is computed in code from the raw reviews, and
 * anything numeric the model emitted here would be decoration at best and a
 * contradiction at worst.
 */
export const SYNTHESIS_MARKDOWN_INSTRUCTION = `
Write the synthesis as prose Markdown. Do NOT return JSON.

Use exactly these headings, in this order, each with content:

## Overall assessment
## Blocking findings
## Ranked fixes
## Disagreements
## What the panel may have missed

Rules:
- Do NOT state scores, ratings, percentages, agreement statistics, or any
  other number presented as a measurement. They are computed separately and
  yours would conflict with them.
- Attribute findings to the persona and model that raised them.
- Under "Disagreements", give both positions and who held each.
- Under "Ranked fixes", order by importance and say why, in words.
`.trim();

/**
 * The same context as the structured call, with the schema instruction
 * replaced by the prose instruction. Built from the same inputs so the
 * fallback sees exactly what the failed call saw.
 */
export function buildSynthesisFallbackMessages(args: {
  systemPrompt: string;
  synthesisPrompt: string;
  results: ReviewResult[];
  documents: DocumentModel[];
}): ChatMessage[] {
  const parts: string[] = [];
  parts.push("SYNTHESIS INSTRUCTIONS:\n" + args.synthesisPrompt);
  parts.push(DOC_DELIMITER + "STAGE 1 REVIEWS" + DOC_DELIMITER + formatReviewsForPrompt(args.results));
  if (args.documents.length > 0) {
    parts.push(DOC_DELIMITER + "REFERENCE DOCUMENTS" + DOC_DELIMITER);
    for (const doc of args.documents) {
      parts.push(`DOCUMENT: ${doc.name}\nROLE: ${doc.role}\n` + "-".repeat(40) + "\n" + doc.content);
    }
  }
  parts.push(SYNTHESIS_MARKDOWN_INSTRUCTION);
  return [
    { role: "system", content: hardenSystemPrompt(args.systemPrompt) },
    { role: "user", content: parts.join(DOC_DELIMITER) },
  ];
}

export interface Stage2Args {
  results: ReviewResult[];
  agreementPack: AgreementPackView;
  synthesisSchema: z.ZodType<Record<string, unknown>>;
  systemPrompt: string;
  synthesisPrompt: string;
  stage2Documents: DocumentModel[];
  /** null only when callFn is provided (no-network test path). */
  client: ModelClient | null;
  temperature: number;
  expectedReviews: number;
  /** M5: quick tier turns agreement statistics off. */
  agreementStats: boolean;
  /**
   * What to do when the structured call yields nothing. "markdown" makes one
   * further unvalidated call for prose. Never affects Stage 1.
   */
  synthesisFallback?: "none" | "markdown";
  onWarning?: (msg: string) => void;
  /** Injectable for tests. */
  callFn?: (messages: ChatMessage[]) => Promise<Record<string, unknown> | null>;
  /** Injectable for tests: the unvalidated prose call. */
  fallbackCallFn?: (messages: ChatMessage[]) => Promise<string | null>;
}

export interface Stage2Result {
  synthesis: Record<string, unknown> | null;
  /**
   * Prose synthesis from the markdown fallback, or null. Non-null ONLY when
   * `synthesis` is null — the two are alternatives, never both. Never parsed
   * for numbers; it is narrative text and nothing downstream reads it.
   */
  synthesisMarkdown: string | null;
  agreement: Record<string, number>;
  missingPersonas: string[];
}

export async function runStage2(args: Stage2Args): Promise<Stage2Result> {
  const warn = args.onWarning ?? (() => {});
  const successful = args.results.filter((r) => r.review !== null);
  if (successful.length === 0) {
    warn("No successful Stage 1 reviews — cannot synthesize");
    return { synthesis: null, synthesisMarkdown: null, agreement: {}, missingPersonas: [] };
  }
  if (successful.length < args.expectedReviews * 0.5) {
    warn(
      `Only ${successful.length}/${args.expectedReviews} reviews succeeded — ` +
        `synthesis may be unreliable`,
    );
  }

  // --- Agreement statistics: computed in code, never by the LLM ---
  const reviews = successful.map((r) => r.review!);
  const personas = successful.map((r) => r.persona);
  const agreement = args.agreementStats
    ? computeAgreement(reviews, args.agreementPack, personas)
    : {};

  const messages = buildSynthesisMessages({
    systemPrompt: args.systemPrompt,
    synthesisPrompt: args.synthesisPrompt,
    results: successful,
    documents: args.stage2Documents,
    schema: args.synthesisSchema,
  });

  const synthesis = args.callFn
    ? await args.callFn(messages)
    : await validatedCall(args.client!, messages, args.synthesisSchema, {
        temperature: args.temperature,
        persona: "synthesis",
        onWarning: warn,
      });

  if (synthesis === null) {
    warn("Stage 2 synthesis call failed validation");
    if ((args.synthesisFallback ?? "none") !== "markdown") {
      return { synthesis: null, synthesisMarkdown: null, agreement, missingPersonas: [] };
    }
    const markdown = await runSynthesisMarkdownFallback(args, successful, warn);
    return { synthesis: null, synthesisMarkdown: markdown, agreement, missingPersonas: [] };
  }

  // --- Patch computed stats over whatever the LLM claimed ---
  synthesis["inter_rater_agreement"] = agreement;

  // --- Sanity-clamp LLM-reported reviewer counts ---
  const nReviews = successful.length;
  const weaknesses = synthesis["consensus_weaknesses"];
  if (Array.isArray(weaknesses)) {
    for (const w of weaknesses as Record<string, unknown>[]) {
      const count = w["reviewer_count"];
      if (typeof count === "number" && count > nReviews) {
        warn(
          `Clamping impossible reviewer_count ${count} -> ${nReviews} for ` +
            `weakness: ${String(w["description"] ?? "").slice(0, 60)}`,
        );
        w["reviewer_count"] = nReviews;
      }
    }
  }

  // --- Recompute + sort ranked fixes (LLM arithmetic never trusted) ---
  recomputeRankedFixes(synthesis);

  return { synthesis, synthesisMarkdown: null, agreement, missingPersonas: [] };
}

/**
 * One unvalidated prose call, used only after the structured call has
 * already failed. Deliberately NOT schema-validated and never parsed: it
 * exists so a human gets a narrative when a weak synthesizer cannot produce
 * schema-valid JSON. A failure here is not fatal — the run keeps its
 * code-computed scores, gates and statistics either way.
 */
async function runSynthesisMarkdownFallback(
  args: Stage2Args,
  successful: ReviewResult[],
  warn: (msg: string) => void,
): Promise<string | null> {
  const messages = buildSynthesisFallbackMessages({
    systemPrompt: args.systemPrompt,
    synthesisPrompt: args.synthesisPrompt,
    results: successful,
    documents: args.stage2Documents,
  });
  try {
    const text = args.fallbackCallFn
      ? await args.fallbackCallFn(messages)
      : (
          await args.client!.chat(messages, {
            temperature: args.temperature,
            jsonMode: false,
          })
        ).content;
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      warn("Stage 2 markdown fallback returned empty content — no narrative in this run");
      return null;
    }
    warn(
      "Stage 2 fell back to UNSTRUCTURED markdown synthesis. Scores, gates " +
        "and agreement statistics are unaffected (computed in code from the " +
        "raw reviews); the narrative is unvalidated prose.",
    );
    return trimmed;
  } catch (exc) {
    warn(
      `Stage 2 markdown fallback also failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
    return null;
  }
}
