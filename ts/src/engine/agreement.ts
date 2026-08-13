/**
 * Inter-rater agreement statistics — Fleiss' kappa and ICC(1,1).
 *
 * Direct port of the Python engine's agreement.py; the math is verbatim from
 * the legal parent and pinned by fixtures/parity/*.json. Statistics are
 * always computed here in code and patched over whatever a synthesis model
 * claims — LLM arithmetic is never trusted.
 *
 * Reviews are plain objects (validated pack review-schema instances) read by
 * convention: a `unitListField` array of per-unit objects carrying the unit
 * name (`unitField`), one numeric attribute per score dimension (attribute
 * style) or a single `unitScoreField` number (unit-major style), and the
 * categorical verdict (`verdictField`, falling back to the review level).
 */

import { pythonRound } from "./pyformat.js";

/** ICC below this threshold flags a dimension as "genuinely contested." */
export const LOW_AGREEMENT_THRESHOLD = 0.4;

/**
 * Two-sided reporting (M6.2): near-perfect agreement across the board is
 * itself a warning — it usually means redundant personas or correlated
 * raters, not quality.
 */
export const HIGH_AGREEMENT_THRESHOLD = 0.9;

export type KeywordRule = readonly [keyword: string, canonical: string];

export interface AgreementPackView {
  scoreDimensions: string[];
  verdictField: string;
  verdictCategories: string[];
  unitField: string;
  unitListField: string;
  unitScoreField: string | null;
  unitKeywordRules: KeywordRule[];
}

type Review = Record<string, unknown>;

/** Reduce a free-text unit name to a stable alignment key. */
export function normalizeUnitName(name: string, keywordRules: KeywordRule[] = []): string {
  let key = name.toLowerCase().trim();
  key = key.replace(/^[0-9]+[.)]?\s*/, "");
  for (const [keyword, canonical] of keywordRules) {
    if (key.includes(keyword)) return canonical;
  }
  key = key.replace(/\(.*?\)/g, "");
  key = key.replace(/[^a-z0-9 ]/g, "");
  return key.replace(/\s+/g, " ").trim();
}

function iterUnits(review: Review, unitListField: string): Record<string, unknown>[] {
  const units = review[unitListField];
  return Array.isArray(units) ? (units as Record<string, unknown>[]) : [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function fleissKappa(
  reviews: Review[],
  opts: {
    verdictField: string;
    verdictCategories: string[];
    unitField: string;
    unitListField?: string;
    keywordRules?: KeywordRule[];
  },
): number {
  const unitListField = opts.unitListField ?? "unit_reviews";
  const keywordRules = opts.keywordRules ?? [];
  const n = reviews.length;
  if (n < 2) return NaN;

  // Per-unit rating matrix keyed on NORMALIZED unit names (insertion order).
  const unitVerdicts = new Map<string, string[]>();
  for (const review of reviews) {
    for (const unit of iterUnits(review, unitListField)) {
      const verdict = unit[opts.verdictField];
      if (verdict === null || verdict === undefined) continue;
      const key = normalizeUnitName(String(unit[opts.unitField] ?? ""), keywordRules);
      const list = unitVerdicts.get(key);
      if (list) list.push(String(verdict));
      else unitVerdicts.set(key, [String(verdict)]);
    }
  }

  let subjects = [...unitVerdicts.values()].filter((v) => v.length >= 2);

  if (subjects.length === 0) {
    // Fallback: the review-level verdict as the single subject.
    const overall = reviews
      .map((r) => r[opts.verdictField])
      .filter((v) => v !== null && v !== undefined)
      .map(String);
    if (overall.length < 2) return NaN;
    subjects = [overall];
  }

  return fleissKappaFromRatings(subjects, opts.verdictCategories);
}

function fleissKappaFromRatings(subjects: string[][], categories: string[]): number {
  const k = categories.length;
  const catIndex = new Map(categories.map((c, i) => [c, i]));

  const matrix: number[][] = [];
  for (const ratings of subjects) {
    const row = new Array<number>(k).fill(0);
    for (const r of ratings) {
      const idx = catIndex.get(r);
      if (idx !== undefined) row[idx]! += 1;
    }
    matrix.push(row);
  }

  const bigN = matrix.length;
  if (bigN === 0) return NaN;

  const nPerSubject = matrix.map((row) => row.reduce((a, b) => a + b, 0));

  const pIValues: number[] = [];
  for (let i = 0; i < bigN; i++) {
    const ni = nPerSubject[i]!;
    if (ni < 2) continue;
    let s = 0;
    for (const nij of matrix[i]!) s += nij * (nij - 1);
    pIValues.push(s / (ni * (ni - 1)));
  }
  if (pIValues.length === 0) return NaN;

  const pBar = pIValues.reduce((a, b) => a + b, 0) / pIValues.length;

  let totalRatings = 0;
  for (const row of matrix) for (const v of row) totalRatings += v;
  if (totalRatings === 0) return NaN;

  const colSums = new Array<number>(k).fill(0);
  for (const row of matrix) for (let j = 0; j < k; j++) colSums[j]! += row[j]!;
  let pE = 0;
  for (const cj of colSums) {
    const pj = cj / totalRatings;
    pE += pj * pj;
  }

  if (Math.abs(pE - 1.0) < 1e-10) return NaN;

  return pythonRound((pBar - pE) / (1.0 - pE), 4);
}

/** Read one unit object's score for `dimension`, in either score shape. */
export function unitScoreForDimension(
  unit: Record<string, unknown>,
  dimension: string,
  opts: {
    unitField: string;
    unitScoreField: string | null;
    keywordRules?: KeywordRule[];
  },
): number | null {
  const keywordRules = opts.keywordRules ?? [];
  if (opts.unitScoreField === null) {
    return asNumber(unit[dimension]);
  }
  const unitName = normalizeUnitName(String(unit[opts.unitField] ?? ""), keywordRules);
  if (unitName !== normalizeUnitName(dimension, keywordRules)) return null;
  return asNumber(unit[opts.unitScoreField]);
}

function extractDimensionScores(
  reviews: Review[],
  dimension: string,
  opts: {
    unitField: string;
    unitListField: string;
    unitScoreField: string | null;
    keywordRules: KeywordRule[];
  },
): number[][] {
  const unitScores = new Map<string, number[]>();
  for (const review of reviews) {
    for (const unit of iterUnits(review, opts.unitListField)) {
      const value = unitScoreForDimension(unit, dimension, opts);
      if (value === null) continue;
      const key = normalizeUnitName(String(unit[opts.unitField] ?? ""), opts.keywordRules);
      const list = unitScores.get(key);
      if (list) list.push(value);
      else unitScores.set(key, [value]);
    }
  }
  return [...unitScores.values()];
}

/** Unit-major mode: subjects = units (dimensions), raters = reviews. */
export function extractUnitMajorSubjects(
  reviews: Review[],
  opts: {
    unitField: string;
    unitListField: string;
    unitScoreField: string;
    keywordRules?: KeywordRule[];
  },
): number[][] {
  const keywordRules = opts.keywordRules ?? [];
  const unitScores = new Map<string, number[]>();
  for (const review of reviews) {
    for (const unit of iterUnits(review, opts.unitListField)) {
      const value = asNumber(unit[opts.unitScoreField]);
      if (value === null) continue;
      const key = normalizeUnitName(String(unit[opts.unitField] ?? ""), keywordRules);
      const list = unitScores.get(key);
      if (list) list.push(value);
      else unitScores.set(key, [value]);
    }
  }
  return [...unitScores.values()];
}

/**
 * ICC(1,1) — one-way random effects, single measures.
 * Formula: (BMS - WMS) / (BMS + (k-1)*WMS).
 */
export function iccOneway(scoresBySubject: number[][]): number {
  if (scoresBySubject.length === 0) return NaN;

  const valid = scoresBySubject.filter((s) => s.length >= 2);
  if (valid.length === 0) return NaN;

  // Modal rater count, first-seen tie-break (Python Counter.most_common).
  const counts = new Map<number, number>();
  for (const s of valid) counts.set(s.length, (counts.get(s.length) ?? 0) + 1);
  let k = 0;
  let best = -1;
  for (const [length, count] of counts) {
    if (count > best) {
      best = count;
      k = length;
    }
  }
  const subjects = valid.filter((s) => s.length >= k).map((s) => s.slice(0, k));
  if (subjects.length < 2) return NaN;

  const n = subjects.length;
  let total = 0;
  for (const row of subjects) for (const v of row) total += v;
  const grandMean = total / (n * k);

  const subjectMeans = subjects.map((row) => row.reduce((a, b) => a + b, 0) / k);

  let bss = 0;
  for (const m of subjectMeans) bss += (m - grandMean) ** 2;
  bss *= k;

  let wss = 0;
  for (let i = 0; i < n; i++) {
    for (const v of subjects[i]!) wss += (v - subjectMeans[i]!) ** 2;
  }

  const bms = bss / (n - 1);
  const wms = n * (k - 1) > 0 ? wss / (n * (k - 1)) : 0.0;

  const denom = bms + (k - 1) * wms;
  if (Math.abs(denom) < 1e-10) return 0.0;

  return pythonRound((bms - wms) / denom, 4);
}

/**
 * Compute all inter-rater agreement statistics for a review set.
 *
 * Key names match the Python engine: `fleiss_kappa_verdict`, `icc_<dim>`,
 * `icc_units` (unit-major pooled), `icc_<dim>__<persona>`.
 *
 * Interpretation caveat (by design): personas are INTENDED to disagree, so
 * the pooled ICC conflates designed lens differences with genuine model
 * disagreement. The per-persona ICC — same lens, different models — is the
 * clean reliability signal.
 */
export function computeAgreement(
  reviews: Review[],
  pack: AgreementPackView,
  personas?: string[] | null,
): Record<string, number> {
  const result: Record<string, number> = {};
  const opts = {
    unitField: pack.unitField,
    unitListField: pack.unitListField,
    unitScoreField: pack.unitScoreField,
    keywordRules: pack.unitKeywordRules,
  };

  result["fleiss_kappa_verdict"] = fleissKappa(reviews, {
    verdictField: pack.verdictField,
    verdictCategories: pack.verdictCategories,
    unitField: pack.unitField,
    unitListField: pack.unitListField,
    keywordRules: pack.unitKeywordRules,
  });

  for (const dim of pack.scoreDimensions) {
    result[`icc_${dim}`] = iccOneway(extractDimensionScores(reviews, dim, opts));
  }

  if (pack.unitScoreField !== null) {
    result["icc_units"] = iccOneway(
      extractUnitMajorSubjects(reviews, {
        ...opts,
        unitScoreField: pack.unitScoreField,
      }),
    );
  }

  if (personas != null && personas.length === reviews.length) {
    const uniquePersonas = [...new Set(personas)].sort();
    for (const persona of uniquePersonas) {
      const personaReviews = reviews.filter((_, i) => personas[i] === persona);
      if (personaReviews.length < 2) continue;
      for (const dim of pack.scoreDimensions) {
        result[`icc_${dim}__${persona}`] = iccOneway(
          extractDimensionScores(personaReviews, dim, opts),
        );
      }
      if (pack.unitScoreField !== null) {
        result[`icc_units__${persona}`] = iccOneway(
          extractUnitMajorSubjects(personaReviews, {
            ...opts,
            unitScoreField: pack.unitScoreField,
          }),
        );
      }
    }
  }

  return result;
}

/** Dimension names where ICC indicates genuine disagreement. */
export function getContestedDimensions(agreement: Record<string, number>): string[] {
  const contested: string[] = [];
  for (const [key, val] of Object.entries(agreement)) {
    if (key.startsWith("icc_") && !Number.isNaN(val) && val < LOW_AGREEMENT_THRESHOLD) {
      contested.push(key.slice("icc_".length));
    }
  }
  return contested;
}

/**
 * M6.2 — the high side of two-sided agreement reporting. Returns true when
 * every defined statistic is suspiciously uniform (>= HIGH_AGREEMENT_THRESHOLD):
 * usually redundant personas or correlated raters, not quality.
 */
export function isSuspiciouslyUniform(agreement: Record<string, number>): boolean {
  const defined = Object.values(agreement).filter((v) => !Number.isNaN(v));
  if (defined.length === 0) return false;
  return defined.every((v) => v >= HIGH_AGREEMENT_THRESHOLD);
}
