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
  onWarning?: (msg: string) => void;
  /** Injectable for tests. */
  callFn?: (messages: ChatMessage[]) => Promise<Record<string, unknown> | null>;
}

export interface Stage2Result {
  synthesis: Record<string, unknown> | null;
  agreement: Record<string, number>;
  missingPersonas: string[];
}

export async function runStage2(args: Stage2Args): Promise<Stage2Result> {
  const warn = args.onWarning ?? (() => {});
  const successful = args.results.filter((r) => r.review !== null);
  if (successful.length === 0) {
    warn("No successful Stage 1 reviews — cannot synthesize");
    return { synthesis: null, agreement: {}, missingPersonas: [] };
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
    return { synthesis: null, agreement, missingPersonas: [] };
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

  return { synthesis, agreement, missingPersonas: [] };
}
