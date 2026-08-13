/**
 * Stage 3 held-out validation, ported from held_out.py, with the M6.4
 * teeth: escape rate (novel held-out findings ÷ total held-out findings)
 * and, at the rigorous tier, a severity-1 finding the panel missed
 * entirely BLOCKS the ship (in the parent it was informational only).
 *
 * The held-out model is excluded from Stages 1–2 in code; every
 * consultation is logged to holdout_ledger.yaml with exhaustion warnings —
 * each iteration tuned against its feedback erodes its independence.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { buildMessages, buildSchemaInstruction } from "./prompts.js";
import { sequenceRatio } from "./seqmatch.js";
import { validatedCall } from "./validation.js";
import type { DocumentModel } from "./manifest.js";
import type { ChatMessage } from "../providers/types.js";
import type { ModelClient } from "../providers/registry.js";
import type { Pack } from "../pack/types.js";

export const FUZZY_THRESHOLD = 0.85;

/** Code-level enforcement that the held-out model never reviews in Stage 1–2. */
export function verifyHeldOutExclusion(args: {
  heldOutId: string;
  reviewerIds: string[];
  synthesizerId: string;
  drafterId?: string | null;
}): void {
  if (args.reviewerIds.includes(args.heldOutId)) {
    throw new Error(
      `Held-out model ${args.heldOutId} appears in the reviewer list. ` +
        `It must be excluded from Stages 1-2.`,
    );
  }
  if (args.synthesizerId === args.heldOutId) {
    throw new Error(
      `Held-out model ${args.heldOutId} is configured as the synthesizer. ` +
        `It must be excluded from Stages 1-2.`,
    );
  }
  if (args.drafterId != null && args.drafterId === args.heldOutId) {
    throw new Error(
      `Held-out model ${args.heldOutId} is configured as the drafter. ` +
        `It must be excluded from drafting and Stages 1-2.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Holdout ledger (exhaustion tracking)
// ---------------------------------------------------------------------------

interface LedgerEntry {
  timestamp: string;
  model: string;
  doc_sha256: string | null;
  verdict: string;
  run_dir: string;
}

export function recordHoldoutUse(args: {
  ledgerPath: string;
  model: string;
  docSha256: string | null;
  verdict: string;
  runDir: string;
  onWarning?: (msg: string) => void;
}): void {
  const warn = args.onWarning ?? (() => {});
  let entries: LedgerEntry[] = [];
  if (fs.existsSync(args.ledgerPath)) {
    entries = (parseYaml(fs.readFileSync(args.ledgerPath, "utf-8")) as LedgerEntry[]) ?? [];
  }
  entries.push({
    timestamp: new Date().toISOString(),
    model: args.model,
    doc_sha256: args.docSha256,
    verdict: args.verdict,
    run_dir: args.runDir,
  });
  fs.mkdirSync(path.dirname(args.ledgerPath), { recursive: true });
  fs.writeFileSync(args.ledgerPath, stringifyYaml(entries), "utf-8");

  const sameModelUses = entries.filter((e) => e.model === args.model).length;
  const sameDocUses = entries.filter(
    (e) => args.docSha256 !== null && e.doc_sha256 === args.docSha256,
  ).length;
  if (sameDocUses > 1) {
    warn(
      `Held-out model already validated this exact document version ` +
        `(${sameDocUses} times) — re-running adds no information.`,
    );
  }
  if (sameModelUses >= 3) {
    warn(
      `HOLDOUT EXHAUSTION: ${args.model} has now been consulted ${sameModelUses} ` +
        `times across document revisions. Each iteration tuned against its ` +
        `feedback erodes its independence. Rotate in a fresh held-out model ` +
        `(different vendor) for the final validation.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stage 3 run
// ---------------------------------------------------------------------------

export async function runStage3(args: {
  /** null only when callFn is provided (no-network test path). */
  client: ModelClient | null;
  pack: Pack;
  systemPrompt: string;
  stage3Documents: DocumentModel[];
  temperature: number;
  onWarning?: (msg: string) => void;
  callFn?: (messages: ChatMessage[]) => Promise<Record<string, unknown> | null>;
}): Promise<Record<string, unknown> | null> {
  const messages = buildMessages({
    systemPrompt: args.systemPrompt,
    personaOverlay:
      "You are an independent held-out validator. Review the document " +
      "without any specific persona bias. Focus on identifying issues " +
      "that other reviewers may have missed.",
    documents: args.stage3Documents,
    schema: args.pack.reviewSchema,
    canonicalUnits: args.pack.canonicalUnits.length > 0 ? args.pack.canonicalUnits : null,
    unitField: args.pack.unitField,
  });
  if (args.callFn) return args.callFn(messages);
  return validatedCall(args.client!, messages, args.pack.reviewSchema, {
    temperature: args.temperature,
    persona: "held_out_validator",
    onWarning: args.onWarning ?? (() => {}),
  });
}

// ---------------------------------------------------------------------------
// Weakness extraction + comparison
// ---------------------------------------------------------------------------

/** Collect free-text weaknesses from a pack review instance (both shapes). */
export function extractReviewWeaknesses(
  review: Record<string, unknown>,
  pack: Pack,
): string[] {
  const weaknesses: string[] = [];
  const units = review[pack.unitListField];
  for (const unit of Array.isArray(units) ? (units as Record<string, unknown>[]) : []) {
    const list = unit["weaknesses"];
    for (const w of Array.isArray(list) ? list : []) weaknesses.push(String(w));
  }
  const findings = review["findings"];
  for (const f of Array.isArray(findings) ? (findings as Record<string, unknown>[]) : []) {
    const desc = f["description"];
    if (desc) weaknesses.push(String(desc));
  }
  return weaknesses;
}

export function fuzzyMatchWeakness(
  description: string,
  knownDescriptions: Set<string>,
  threshold = FUZZY_THRESHOLD,
): boolean {
  const descLower = description.toLowerCase().trim();
  for (const known of knownDescriptions) {
    if (sequenceRatio(descLower, known) >= threshold) return true;
  }
  return false;
}

const AdjudicationSchema = z.object({
  verdicts: z.array(
    z.object({
      held_out_weakness: z.string(),
      matches_known_issue: z.boolean(),
      matched_description: z.string().default(""),
    }),
  ),
});

export interface HeldOutComparison {
  status: "agrees" | "found_new_issues";
  newIssues: string[];
  /** M6.4 escape rate: novel held-out findings ÷ total held-out findings. */
  escapeRate: number | null;
  /** Sev-1 findings from the held-out review that match nothing the panel found. */
  missedSevOne: string[];
  method: "semantic" | "lexical";
}

/**
 * Compare held-out weaknesses against synthesis weaknesses: semantic
 * adjudication via one cheap synthesizer-model call, lexical
 * SequenceMatcher fallback (which over-reports novelty — flagged as such).
 */
export async function compareHeldOut(args: {
  heldOutReview: Record<string, unknown>;
  synthesis: Record<string, unknown>;
  pack: Pack;
  adjudicatorClient: ModelClient | null;
  onWarning?: (msg: string) => void;
  callFn?: (messages: ChatMessage[]) => Promise<z.infer<typeof AdjudicationSchema> | null>;
}): Promise<HeldOutComparison> {
  const warn = args.onWarning ?? (() => {});
  const heldOutWeaknesses = extractReviewWeaknesses(args.heldOutReview, args.pack);
  const knownRaw = args.synthesis["consensus_weaknesses"];
  const known = (Array.isArray(knownRaw) ? (knownRaw as Record<string, unknown>[]) : []).map(
    (w) => String(w["description"] ?? ""),
  );

  if (heldOutWeaknesses.length === 0) {
    return { status: "agrees", newIssues: [], escapeRate: 0, missedSevOne: [], method: "semantic" };
  }

  let newIssues: string[] | null = null;
  let method: "semantic" | "lexical" = "semantic";

  if (known.length > 0 && (args.adjudicatorClient !== null || args.callFn)) {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You compare lists of editorial-review findings. Two findings " +
          "match when they identify the SAME underlying issue, even if " +
          "worded differently. Different issues about the same part of the " +
          "document do NOT match.",
      },
      {
        role: "user",
        content:
          "KNOWN ISSUES (from the main review synthesis):\n" +
          known.map((d) => `- ${d}`).join("\n") +
          "\n\nHELD-OUT VALIDATOR ISSUES:\n" +
          heldOutWeaknesses.map((w) => `- ${w}`).join("\n") +
          "\n\nFor EACH held-out issue, decide whether it matches any known issue." +
          buildSchemaInstruction(AdjudicationSchema),
      },
    ];
    const adjudication = args.callFn
      ? await args.callFn(messages)
      : await validatedCall(args.adjudicatorClient!, messages, AdjudicationSchema, {
          temperature: 0.0,
          persona: "held_out_adjudicator",
          onWarning: warn,
        });
    if (adjudication !== null) {
      newIssues = adjudication.verdicts
        .filter((v) => !v.matches_known_issue)
        .map((v) => v.held_out_weakness);
    }
  }

  if (newIssues === null) {
    warn(
      "Falling back to lexical (SequenceMatcher) held-out comparison — treat " +
        "'found_new_issues' with skepticism: lexical matching over-reports novelty.",
    );
    method = "lexical";
    const knownLower = new Set(known.map((d) => d.toLowerCase().trim()));
    newIssues = heldOutWeaknesses.filter((w) => !fuzzyMatchWeakness(w, knownLower));
  }

  // --- M6.4: escape rate + missed severity-1 findings ---
  const escapeRate =
    heldOutWeaknesses.length > 0 ? newIssues.length / heldOutWeaknesses.length : null;
  const newIssueSet = new Set(newIssues.map((w) => w.toLowerCase().trim()));
  const findings = args.heldOutReview["findings"];
  const missedSevOne = (Array.isArray(findings) ? (findings as Record<string, unknown>[]) : [])
    .filter(
      (f) =>
        f["severity"] === 1 &&
        newIssueSet.has(String(f["description"] ?? "").toLowerCase().trim()),
    )
    .map((f) => String(f["description"] ?? ""));

  return {
    status: newIssues.length > 0 ? "found_new_issues" : "agrees",
    newIssues,
    escapeRate,
    missedSevOne,
    method,
  };
}

/** Human-triage artifact — the binary status is a summary, not a substitute. */
export function writeHeldOutTriage(runDir: string, comparison: HeldOutComparison): string {
  const lines = ["# Held-Out Validator — New Issues Triage\n"];
  if (comparison.newIssues.length > 0) {
    lines.push(
      "The held-out model raised the following issues that the main review " +
        "synthesis did not. Each one is either (a) a real gap the reviewer " +
        "ensemble missed — evidence of overfitting — or (b) held-out model " +
        "noise. A human must decide which.\n",
    );
    for (const issue of comparison.newIssues) lines.push(`- [ ] ${issue}`);
    if (comparison.escapeRate !== null) {
      lines.push(
        `\nEscape rate: ${(comparison.escapeRate * 100).toFixed(0)}% ` +
          `(${comparison.newIssues.length} novel of ` +
          `${Math.round(comparison.newIssues.length / comparison.escapeRate)} held-out findings). ` +
          "A rising escape rate alongside a rising composite is measurable overfitting.",
      );
    }
  } else {
    lines.push(
      "No new issues: everything the held-out model flagged was already in " +
        "the synthesis.\n",
    );
  }
  const triagePath = path.join(runDir, "held_out_new_issues.md");
  fs.writeFileSync(triagePath, lines.join("\n") + "\n", "utf-8");
  return triagePath;
}
