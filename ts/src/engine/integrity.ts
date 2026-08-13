/**
 * Blind-spot integrity metrics (M6.2 / M6.3).
 *
 * Two-sided agreement: LOW flags "genuinely contested" (< 0.4, as in the
 * parent); HIGH flags suspicious uniformity (all defined stats >= 0.9) —
 * near-perfect agreement across the board usually means redundant personas
 * or correlated raters, not quality.
 *
 * Persona differentiation: pairwise overlap of what each persona actually
 * FOUND (unit + dimension coverage + finding locations). Two personas above
 * ~70% overlap ⇒ one is decorative.
 */

import {
  HIGH_AGREEMENT_THRESHOLD,
  LOW_AGREEMENT_THRESHOLD,
  getContestedDimensions,
  isSuspiciouslyUniform,
  normalizeUnitName,
  unitScoreForDimension,
  type KeywordRule,
} from "./agreement.js";
import { pythonRound } from "./pyformat.js";

type Review = Record<string, unknown>;

export interface AgreementFlags {
  contested: string[];
  suspiciouslyUniform: boolean;
  lowThreshold: number;
  highThreshold: number;
}

export function twoSidedAgreementFlags(agreement: Record<string, number>): AgreementFlags {
  return {
    contested: getContestedDimensions(agreement),
    suspiciouslyUniform: isSuspiciouslyUniform(agreement),
    lowThreshold: LOW_AGREEMENT_THRESHOLD,
    highThreshold: HIGH_AGREEMENT_THRESHOLD,
  };
}

export const DIFFERENTIATION_OVERLAP_THRESHOLD = 0.7;

export interface PersonaOverlap {
  personaA: string;
  personaB: string;
  overlap: number;
  decorative: boolean;
}

export interface DifferentiationOptions {
  scoreDimensions: string[];
  unitField: string;
  unitListField: string;
  unitScoreField: string | null;
  keywordRules: KeywordRule[];
  dimensionScales: Record<string, [number, number]>;
}

/**
 * What did this persona actually find? The coverage set is:
 * - (unit, dimension) pairs the persona scored at or below the scale
 *   midpoint (it flagged a problem there), plus
 * - normalized finding locations.
 */
export function personaCoverageSet(
  reviews: Review[],
  opts: DifferentiationOptions,
): Set<string> {
  const coverage = new Set<string>();
  for (const review of reviews) {
    const units = review[opts.unitListField];
    for (const unit of Array.isArray(units) ? (units as Review[]) : []) {
      const unitName = normalizeUnitName(
        String(unit[opts.unitField] ?? ""),
        opts.keywordRules,
      );
      for (const dim of opts.scoreDimensions) {
        const value = unitScoreForDimension(unit, dim, {
          unitField: opts.unitField,
          unitScoreField: opts.unitScoreField,
          keywordRules: opts.keywordRules,
        });
        if (value === null) continue;
        const [lo, hi] = opts.dimensionScales[dim] ?? [1, 10];
        const midpoint = (lo + hi) / 2;
        if (value <= midpoint) coverage.add(`score:${unitName}:${dim}`);
      }
    }
    const findings = review["findings"];
    for (const f of Array.isArray(findings) ? (findings as Review[]) : []) {
      const location = normalizeUnitName(String(f["location"] ?? ""), opts.keywordRules);
      if (location) coverage.add(`finding:${location}`);
    }
  }
  return coverage;
}

/**
 * Pairwise persona overlap: |A ∩ B| / min(|A|, |B|). Deterministic, free
 * (arithmetic on collected data). Pairs above the threshold are reported
 * as decorative — one of the two is not earning its seat.
 */
export function personaDifferentiation(
  reviewsByPersona: Record<string, Review[]>,
  opts: DifferentiationOptions,
): PersonaOverlap[] {
  const personas = Object.keys(reviewsByPersona).sort();
  const coverage = new Map<string, Set<string>>(
    personas.map((p) => [p, personaCoverageSet(reviewsByPersona[p]!, opts)]),
  );
  const overlaps: PersonaOverlap[] = [];
  for (let i = 0; i < personas.length; i++) {
    for (let j = i + 1; j < personas.length; j++) {
      const a = coverage.get(personas[i]!)!;
      const b = coverage.get(personas[j]!)!;
      const smaller = Math.min(a.size, b.size);
      let intersection = 0;
      for (const item of a) if (b.has(item)) intersection += 1;
      const overlap = smaller === 0 ? 0 : intersection / smaller;
      overlaps.push({
        personaA: personas[i]!,
        personaB: personas[j]!,
        overlap: pythonRound(overlap, 4),
        decorative: overlap > DIFFERENTIATION_OVERLAP_THRESHOLD,
      });
    }
  }
  return overlaps;
}
