/**
 * Run diff, ported from diff.py: compares two review runs — new/resolved
 * weaknesses, per-unit score deltas from raw reviews, held-out status, and
 * fix counts.
 */

import fs from "node:fs";
import path from "node:path";

import { unitScoreForDimension } from "./agreement.js";
import { pythonRound } from "./pyformat.js";
import type { Pack } from "../pack/types.js";

export interface ScoreDelta {
  unit: string;
  dimension: string;
  scoreA: number;
  scoreB: number;
}

export interface DiffResult {
  runAId: string;
  runBId: string;
  newWeaknesses: string[];
  resolvedWeaknesses: string[];
  scoreDeltas: ScoreDelta[];
  statusA: string;
  statusB: string;
  fixCountA: number;
  fixCountB: number;
  weaknessCountA: number;
  weaknessCountB: number;
}

function loadSynthesis(runDir: string): Record<string, unknown> {
  const p = path.join(runDir, "synthesis.json");
  if (!fs.existsSync(p)) {
    // A run whose synthesizer fell back to prose has no structured synthesis
    // to diff. Say which run and why, rather than "No synthesis.json".
    const report = path.join(runDir, "synthesis_report.md");
    const fellBack =
      fs.existsSync(report) &&
      fs.readFileSync(report, "utf-8").includes("## Synthesis (unstructured fallback)");
    if (fellBack) {
      throw new Error(
        `${runDir} has no synthesis.json: that run's synthesizer fell back to ` +
          `unstructured markdown, so there is no structured synthesis to diff. ` +
          `Re-run it with a synthesizer that returns schema-valid JSON ` +
          `(pipeline.synthesis_fallback: none will fail loudly instead).`,
      );
    }
    throw new Error(`No synthesis.json in ${runDir}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

/** Average scores per unit from raw review JSONs: {unit: {dimension: avg}}. */
export function extractUnitScores(pack: Pack, runDir: string): Record<string, Record<string, number>> {
  const rawDir = path.join(runDir, "raw_reviews");
  const scores: Record<string, Record<string, number>> = {};
  if (!fs.existsSync(rawDir)) return scores;

  const accum: Record<string, Record<string, number[]>> = {};
  for (const file of fs.readdirSync(rawDir).sort()) {
    if (!file.endsWith(".json")) continue;
    let review: Record<string, unknown>;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(rawDir, file), "utf-8"));
      const parsed = pack.reviewSchema.safeParse(data);
      if (!parsed.success) continue;
      review = parsed.data;
    } catch {
      continue;
    }
    const units = review[pack.unitListField];
    for (const unit of Array.isArray(units) ? (units as Record<string, unknown>[]) : []) {
      const unitName = String(unit[pack.unitField] ?? "");
      accum[unitName] ??= Object.fromEntries(pack.scoreDimensions.map((d) => [d, []]));
      for (const dim of pack.scoreDimensions) {
        const value = unitScoreForDimension(unit, dim, {
          unitField: pack.unitField,
          unitScoreField: pack.unitScoreField,
          keywordRules: pack.unitKeywordRules,
        });
        if (value !== null) accum[unitName]![dim]!.push(value);
      }
    }
  }
  for (const [unitName, dims] of Object.entries(accum)) {
    scores[unitName] = {};
    for (const [dim, vals] of Object.entries(dims)) {
      if (vals.length > 0) {
        scores[unitName]![dim] = pythonRound(vals.reduce((a, b) => a + b, 0) / vals.length, 2);
      }
    }
  }
  return scores;
}

export function compareRuns(args: { runDirA: string; runDirB: string; pack: Pack }): DiffResult {
  const synthA = loadSynthesis(args.runDirA);
  const synthB = loadSynthesis(args.runDirB);

  const descs = (s: Record<string, unknown>): Set<string> =>
    new Set(
      ((s["consensus_weaknesses"] ?? []) as Record<string, unknown>[]).map((w) =>
        String(w["description"] ?? ""),
      ),
    );
  const descsA = descs(synthA);
  const descsB = descs(synthB);

  const scoresA = extractUnitScores(args.pack, args.runDirA);
  const scoresB = extractUnitScores(args.pack, args.runDirB);
  const scoreDeltas: ScoreDelta[] = [];
  const allUnits = [...new Set([...Object.keys(scoresA), ...Object.keys(scoresB)])].sort();
  for (const unit of allUnits) {
    const dimsA = scoresA[unit] ?? {};
    const dimsB = scoresB[unit] ?? {};
    const allDims = [...new Set([...Object.keys(dimsA), ...Object.keys(dimsB)])].sort();
    for (const dim of allDims) {
      const valA = dimsA[dim] ?? 0;
      const valB = dimsB[dim] ?? 0;
      if (valA !== valB) {
        scoreDeltas.push({ unit, dimension: dim, scoreA: valA, scoreB: valB });
      }
    }
  }

  return {
    runAId: path.basename(args.runDirA),
    runBId: path.basename(args.runDirB),
    newWeaknesses: [...descsB].filter((d) => !descsA.has(d)).sort(),
    resolvedWeaknesses: [...descsA].filter((d) => !descsB.has(d)).sort(),
    scoreDeltas,
    statusA: String(synthA["held_out_validator_status"] ?? "not_yet_run"),
    statusB: String(synthB["held_out_validator_status"] ?? "not_yet_run"),
    fixCountA: ((synthA["ranked_fixes"] ?? []) as unknown[]).length,
    fixCountB: ((synthB["ranked_fixes"] ?? []) as unknown[]).length,
    weaknessCountA: descsA.size,
    weaknessCountB: descsB.size,
  };
}

export function formatDiff(result: DiffResult): string {
  const lines: string[] = [];
  lines.push(`Run Diff: ${result.runAId} → ${result.runBId}\n`);
  lines.push(`Weaknesses: ${result.weaknessCountA} → ${result.weaknessCountB}`);
  lines.push(`Ranked fixes: ${result.fixCountA} → ${result.fixCountB}`);
  lines.push(`Held-out status: ${result.statusA} → ${result.statusB}`);
  lines.push("");
  if (result.newWeaknesses.length > 0) {
    lines.push(`New weaknesses (${result.newWeaknesses.length}):`);
    for (const w of result.newWeaknesses) lines.push(`  + ${w}`);
    lines.push("");
  }
  if (result.resolvedWeaknesses.length > 0) {
    lines.push(`Resolved weaknesses (${result.resolvedWeaknesses.length}):`);
    for (const w of result.resolvedWeaknesses) lines.push(`  - ${w}`);
    lines.push("");
  }
  if (result.scoreDeltas.length > 0) {
    lines.push("Score changes:");
    for (const sd of result.scoreDeltas) {
      const delta = sd.scoreB - sd.scoreA;
      const direction = delta > 0 ? "+" : "";
      lines.push(
        `  ${sd.unit} (${sd.dimension}): ${sd.scoreA.toFixed(1)} → ` +
          `${sd.scoreB.toFixed(1)} (${direction}${delta.toFixed(1)})`,
      );
    }
    lines.push("");
  }
  if (
    result.newWeaknesses.length === 0 &&
    result.resolvedWeaknesses.length === 0 &&
    result.scoreDeltas.length === 0
  ) {
    lines.push("No significant differences found.");
  }
  return lines.join("\n");
}
