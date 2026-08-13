/**
 * Prediction ledger + handoff + the outcome loop (M6.6), ported from
 * ledger.py and completed: `quorable outcome` joins real-world results back
 * onto frozen predictions — the only true ground truth in the system, and
 * the long-term data source for suggested model defaults (§5.4).
 *
 * Rows are FROZEN: a prediction row is write-once per run_id; predictions
 * made before publication must not be editable after the outcome is known.
 * Outcomes append to a row without touching the frozen fields.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { computeScores } from "./scoring.js";
import type { Pack } from "../pack/types.js";

export const PREDICTIONS_FILENAME = "predictions.yaml";

export class LedgerFrozenError extends Error {
  override name = "LedgerFrozenError";
}

export interface PredictionRow {
  file_id: string;
  run_id: string;
  target: string;
  composite: number | null;
  per_dimension: Record<string, number>;
  per_persona_verdict: Record<string, string>;
  hypothesis: string;
  timestamp: string;
  outcome?: { result: string; recorded_at: string }[];
}

/** Load validated raw reviews + personas from a run's raw_reviews dir. */
export function loadRawReviews(
  rawDir: string,
  pack: Pack,
): { reviews: Record<string, unknown>[]; personas: string[] } {
  const reviews: Record<string, unknown>[] = [];
  const personas: string[] = [];
  if (!fs.existsSync(rawDir)) return { reviews, personas };
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
    let persona = String(review["persona"] ?? "");
    if (!persona) {
      const stem = file.replace(/\.json$/, "").split("_run")[0] ?? "";
      persona = stem.split("_").pop() ?? "unknown";
    }
    reviews.push(review);
    personas.push(persona);
  }
  return { reviews, personas };
}

/** Modal verdict (pack.verdictField) per persona. */
export function perPersonaVerdicts(
  reviews: Record<string, unknown>[],
  personas: string[],
  pack: Pack,
): Record<string, string> {
  const byPersona = new Map<string, string[]>();
  reviews.forEach((review, i) => {
    const verdict = review[pack.verdictField];
    if (verdict === null || verdict === undefined) return;
    const persona = personas[i]!;
    const list = byPersona.get(persona);
    if (list) list.push(String(verdict));
    else byPersona.set(persona, [String(verdict)]);
  });
  const out: Record<string, string> = {};
  for (const [persona, verdicts] of byPersona) {
    // Modal value, first-seen tie-break (Counter.most_common parity).
    const counts = new Map<string, number>();
    for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = "";
    let bestCount = -1;
    for (const [v, c] of counts) {
      if (c > bestCount) {
        best = v;
        bestCount = c;
      }
    }
    out[persona] = best;
  }
  return out;
}

/** Build the predictions row for a completed review run directory. */
export function buildPredictionRow(args: {
  runDir: string;
  pack: Pack;
  hypothesis?: string;
}): PredictionRow {
  const metadataPath = path.join(args.runDir, "run_metadata.yaml");
  const metadata = fs.existsSync(metadataPath)
    ? (parseYaml(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>)
    : {};
  const { reviews, personas } = loadRawReviews(
    path.join(args.runDir, "raw_reviews"),
    args.pack,
  );
  // Same persona-exclusion semantics as the ship gate — the frozen
  // composite is the number the gate actually evaluated.
  const { composite, perDimension } = computeScores(reviews, args.pack, personas);
  const target = String(metadata["target"] ?? "");
  const hashes = (metadata["hashes"] ?? {}) as Record<string, unknown>;
  const primaryHash = String(hashes[args.pack.primaryDocName] ?? "").slice(0, 12);
  return {
    file_id: primaryHash
      ? `${path.basename(target) || args.pack.primaryDocName}_${primaryHash}`
      : args.pack.primaryDocName,
    run_id: String(metadata["run_id"] ?? path.basename(args.runDir)),
    target,
    composite,
    per_dimension: perDimension,
    per_persona_verdict: perPersonaVerdicts(reviews, personas, args.pack),
    hypothesis: args.hypothesis ?? "",
    timestamp: new Date().toISOString(),
  };
}

function loadLedger(ledgerPath: string): PredictionRow[] {
  if (!fs.existsSync(ledgerPath)) return [];
  return (parseYaml(fs.readFileSync(ledgerPath, "utf-8")) as PredictionRow[]) ?? [];
}

function saveLedger(ledgerPath: string, rows: PredictionRow[]): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, stringifyYaml(rows), "utf-8");
}

/** Append the row, refusing to overwrite an existing run_id (freeze). */
export function freezePrediction(row: PredictionRow, ledgerPath: string): string {
  const rows = loadLedger(ledgerPath);
  if (rows.some((r) => r.run_id === row.run_id)) {
    throw new LedgerFrozenError(
      `${PREDICTIONS_FILENAME} already has a frozen row for run ${row.run_id} — ` +
        `predictions are write-once. Delete the row manually only if you are ` +
        `certain it was recorded in error.`,
    );
  }
  rows.push(row);
  saveLedger(ledgerPath, rows);
  return ledgerPath;
}

/**
 * M6.6 — record what actually happened. Appends to the row's outcome list
 * without touching frozen prediction fields. Even n=10 reveals whether the
 * composite correlates with anything real.
 */
export function recordOutcome(args: {
  ledgerPath: string;
  runId: string;
  result: string;
}): PredictionRow {
  const rows = loadLedger(args.ledgerPath);
  const row = rows.find((r) => r.run_id === args.runId);
  if (!row) {
    const available = rows.map((r) => r.run_id).join(", ") || "(none)";
    throw new Error(
      `No frozen prediction for run '${args.runId}'. Run \`quorable handoff\` ` +
        `first. Frozen runs: ${available}`,
    );
  }
  row.outcome = row.outcome ?? [];
  row.outcome.push({ result: args.result, recorded_at: new Date().toISOString() });
  saveLedger(args.ledgerPath, rows);
  return row;
}

/** Copy the run's deliverables into the handoff destination directory. */
export function emitHandoff(args: { runDir: string; destDir: string }): string[] {
  const outDir = path.join(args.destDir, path.basename(args.runDir));
  fs.mkdirSync(outDir, { recursive: true });
  const emitted: string[] = [];
  for (const name of [
    "synthesis.json",
    "synthesis_report.md",
    "held_out_validation.json",
    "held_out_new_issues.md",
    "gates.json",
    "validation_tasks.json",
    "cold_read.json",
    "run_metadata.yaml",
  ]) {
    const src = path.join(args.runDir, name);
    if (fs.existsSync(src)) {
      const dst = path.join(outDir, name);
      fs.copyFileSync(src, dst);
      emitted.push(dst);
    }
  }
  return emitted;
}
