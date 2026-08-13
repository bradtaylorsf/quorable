/**
 * Composite scoring + ship-gate evaluation, ported from the Python loop.py.
 *
 * Statistical-honesty posture carried verbatim from the parents:
 * - The composite and per-dimension floors are computed IN CODE from the raw
 *   Stage-1 reviews, never read from the synthesis model's output.
 * - `blockingFindings` (the product-truth guard) receives BOTH the synthesis
 *   and the raw reviews, so a blocker present in a raw review still blocks
 *   even when the synthesis LLM silently drops it. It is a gate, never an
 *   averaged score.
 * - Red-team personas (compositeExcludePersonas) score low BY DESIGN: they
 *   are excluded from the composite and dimension floors but count
 *   everywhere else (findings, blocking gates, synthesis input, agreement).
 */

import { unitScoreForDimension, type KeywordRule } from "./agreement.js";
import type { GateResult } from "./gates.js";
import { pyFixed, pythonRound } from "./pyformat.js";

type Review = Record<string, unknown>;
type Synthesis = Record<string, unknown>;

export type BlockingFindingsFn = (
  synthesis: Synthesis | null,
  reviews: Review[],
) => string[];

export interface ShipGatesConfig {
  compositeMin: number;
  dimensionMin: number;
  blockingFindings: BlockingFindingsFn | null;
  weights: Record<string, number> | null;
  compositeExcludePersonas: string[];
}

export interface ScoringPackView {
  scoreDimensions: string[];
  unitField: string;
  unitListField: string;
  unitScoreField: string | null;
  unitKeywordRules: KeywordRule[];
  shipGates: ShipGatesConfig;
}

export interface ScoreSummary {
  composite: number | null;
  perDimension: Record<string, number>;
}

/** Compute (composite, per-dimension means) from Stage 1 reviews. */
export function computeScores(
  reviews: Review[],
  pack: ScoringPackView,
  personas?: string[] | null,
): ScoreSummary {
  const excluded = new Set(pack.shipGates.compositeExcludePersonas);

  const personaOf = (index: number, review: Review): string => {
    if (personas != null && index < personas.length) return personas[index]!;
    return String(review["persona"] ?? "");
  };

  const scoredReviews = reviews.filter((review, i) => !excluded.has(personaOf(i, review)));

  const perDimension: Record<string, number> = {};
  for (const dim of pack.scoreDimensions) {
    const values: number[] = [];
    for (const review of scoredReviews) {
      const units = review[pack.unitListField];
      for (const unit of Array.isArray(units) ? (units as Record<string, unknown>[]) : []) {
        const value = unitScoreForDimension(unit, dim, {
          unitField: pack.unitField,
          unitScoreField: pack.unitScoreField,
          keywordRules: pack.unitKeywordRules,
        });
        if (value !== null) values.push(value);
      }
    }
    if (values.length > 0) {
      perDimension[dim] = pythonRound(values.reduce((a, b) => a + b, 0) / values.length, 4);
    }
  }

  if (Object.keys(perDimension).length === 0) {
    return { composite: null, perDimension: {} };
  }

  const weights =
    pack.shipGates.weights ??
    Object.fromEntries(Object.keys(perDimension).map((d) => [d, 1.0]));
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [dim, mean] of Object.entries(perDimension)) {
    const w = weights[dim] ?? (pack.shipGates.weights ? 0.0 : 1.0);
    weightedSum += mean * w;
    weightTotal += w;
  }
  const composite = weightTotal ? pythonRound(weightedSum / weightTotal, 4) : null;
  return { composite, perDimension };
}

export interface ShipCheckResult {
  ok: boolean;
  reasons: string[];
  composite: number | null;
  perDimension: Record<string, number>;
}

/**
 * Evaluate the pack's ship gates. Any blocking finding fails shipping
 * regardless of how good the composite looks.
 */
export function checkShipGates(args: {
  synthesis: Synthesis | null;
  reviews: Review[];
  gateResults: Record<string, GateResult>;
  pack: ScoringPackView;
  personas?: string[] | null;
}): ShipCheckResult {
  const { synthesis, reviews, gateResults, pack, personas } = args;
  const reasons: string[] = [];
  const { composite, perDimension } = computeScores(reviews, pack, personas);

  if (synthesis === null) {
    reasons.push("no synthesis output");
  }

  const failedGates = Object.entries(gateResults)
    .filter(([, r]) => !r.passed)
    .map(([name]) => name);
  if (failedGates.length > 0) {
    reasons.push(`mechanical gates failed: ${failedGates.join(", ")}`);
  }

  if (composite === null) {
    reasons.push("no scores extracted from reviews");
  } else {
    if (composite < pack.shipGates.compositeMin) {
      reasons.push(
        `composite ${pyFixed(composite, 2)} < min ${pyFixed(pack.shipGates.compositeMin, 2)}`,
      );
    }
    const low = Object.entries(perDimension)
      .filter(([, m]) => m < pack.shipGates.dimensionMin)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (low.length > 0) {
      reasons.push(
        `dimensions below min ${pyFixed(pack.shipGates.dimensionMin, 2)}: ` +
          low.map(([d, m]) => `${d}=${pyFixed(m, 2)}`).join(", "),
      );
    }
  }

  if (pack.shipGates.blockingFindings !== null) {
    let blocking: string[];
    try {
      blocking = pack.shipGates.blockingFindings(synthesis, reviews) ?? [];
    } catch (exc) {
      blocking = [`blocking_findings gate crashed: ${exc instanceof Error ? exc.message : exc}`];
    }
    if (blocking.length > 0) {
      reasons.push("blocking findings: " + blocking.map(String).join("; "));
    }
  }

  return { ok: reasons.length === 0, reasons, composite, perDimension };
}

/**
 * Recompute priority scores in code and sort ranked_fixes descending.
 * priority = (impact^2 * consensus) / (1 + ease). The synthesis model is
 * asked to compute this too, but its arithmetic is overwritten here.
 */
export function recomputeRankedFixes(synthesis: Synthesis): void {
  const fixes = synthesis["ranked_fixes"];
  if (!Array.isArray(fixes) || fixes.length === 0) return;
  for (const fix of fixes as Record<string, unknown>[]) {
    const impact = fix["impact"];
    const ease = fix["ease"];
    const consensus = fix["consensus"];
    if (
      typeof impact !== "number" ||
      typeof ease !== "number" ||
      typeof consensus !== "number"
    ) {
      continue;
    }
    fix["priority_score"] = priorityScore(impact, ease, consensus);
  }
  (fixes as Record<string, unknown>[]).sort(
    (a, b) => Number(b["priority_score"] ?? 0) - Number(a["priority_score"] ?? 0),
  );
}

/** The canonical priority formula: (impact^2 * consensus) / (1 + ease). */
export function priorityScore(impact: number, ease: number, consensus: number): number {
  return pythonRound((impact ** 2) * consensus / (1 + ease), 4);
}

/**
 * Named built-in blocking finders (rubric YAML `ship.blocking` values —
 * "named built-in, not a lambda"). Blockers are computed from RAW reviews
 * first; synthesis-level criticals are additive.
 */
export const BLOCKING_BUILTINS: Record<string, BlockingFindingsFn> = {
  severity_1_findings: (synthesis, reviews) => {
    const out: string[] = [];
    for (const review of reviews) {
      const findings = review["findings"];
      if (!Array.isArray(findings)) continue;
      for (const f of findings as Record<string, unknown>[]) {
        if (f["severity"] === 1) out.push(String(f["description"] ?? ""));
      }
    }
    if (synthesis !== null) {
      const weaknesses = synthesis["consensus_weaknesses"];
      if (Array.isArray(weaknesses)) {
        for (const w of weaknesses as Record<string, unknown>[]) {
          if (w["severity"] === "critical") out.push(String(w["description"] ?? ""));
        }
      }
    }
    return out;
  },
};
