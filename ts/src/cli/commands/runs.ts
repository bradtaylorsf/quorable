/**
 * Run-artifact commands: validate (Stage 3), golden, diff, handoff,
 * outcome, render.
 */

import fs from "node:fs";
import path from "node:path";

import type { Command } from "commander";
import { parse as parseYaml } from "yaml";

import { resolveContext } from "../context.js";
import { homePaths } from "../../config/home.js";
import { compareRuns, formatDiff } from "../../engine/diff.js";
import {
  evaluateDiscrimination,
  formatGoldenReport,
  goldenFailed,
  loadGoldenManifest,
  runMechanicalCase,
  type CaseOutcome,
} from "../../engine/golden.js";
import {
  compareHeldOut,
  recordHoldoutUse,
  runStage3,
  verifyHeldOutExclusion,
  writeHeldOutTriage,
} from "../../engine/heldOut.js";
import {
  buildPredictionRow,
  emitHandoff,
  freezePrediction,
  LedgerFrozenError,
  PREDICTIONS_FILENAME,
  recordOutcome,
} from "../../engine/ledger.js";
import { allGatesPassed, type GateResult } from "../../engine/gates.js";
import { loadRawReviews } from "../../engine/ledger.js";
import { checkShipGates } from "../../engine/scoring.js";
import { readValidationTasks, validationTaskShipReasons } from "../../engine/validationTasks.js";
import { generateSynthesisReport } from "../../engine/reports.js";
import { documentFromText } from "../../engine/parsers.js";
import { CostTracker } from "../../engine/costs.js";
import { ModelClient } from "../../providers/registry.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Read run_metadata.yaml to recover the target document of a run dir. */
function runTarget(runDir: string): string {
  const metaPath = path.join(runDir, "run_metadata.yaml");
  if (!fs.existsSync(metaPath)) {
    fail(`${runDir} has no run_metadata.yaml — is it a quorable output directory?`);
  }
  const meta = parseYaml(fs.readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
  const target = String(meta["target"] ?? "");
  if (!target) fail(`${metaPath} records no target document.`);
  return target;
}

export function registerRunCommands(program: Command): void {
  // --- validate (Stage 3 held-out, outside the loop) ------------------------
  program
    .command("validate <run-dir>")
    .description("Run held-out validation (Stage 3) against an existing review run")
    .action(async (runDirArg: string) => {
      const runDir = path.resolve(runDirArg);
      const target = runTarget(runDir);
      if (!fs.existsSync(target)) {
        fail(`Target document ${target} no longer exists.`);
      }
      const ctx = resolveContext(target, {});
      verifyHeldOutExclusion({
        heldOutId: ctx.config.models.held_out.id,
        reviewerIds: ctx.config.models.reviewers.filter((r) => !r.held_out).map((r) => r.id),
        synthesizerId: ctx.config.models.synthesizer.id,
        drafterId: ctx.config.models.drafter?.id ?? null,
      });
      const synthesisPath = path.join(runDir, "synthesis.json");
      if (!fs.existsSync(synthesisPath)) fail(`No synthesis.json in ${runDir}.`);
      const synthesis = JSON.parse(fs.readFileSync(synthesisPath, "utf-8")) as Record<string, unknown>;

      const tracker = new CostTracker();
      const heldOutClient = new ModelClient(
        ctx.config.models.held_out.id,
        ctx.providerSettings,
        tracker,
      );
      console.log(`Held-out model: ${ctx.config.models.held_out.id}`);
      const text = fs.readFileSync(target, "utf-8");
      const review = await runStage3({
        client: heldOutClient,
        pack: ctx.pack,
        systemPrompt: ctx.prompts.system,
        stage3Documents: [
          documentFromText(ctx.pack.primaryDocName, text, {
            role: "Primary document under review",
          }),
        ],
        temperature: ctx.config.models.held_out.temperature,
        onWarning: (m) => console.error(m),
      });
      if (review === null) fail("Stage 3 validation failed.");
      fs.writeFileSync(
        path.join(runDir, "held_out_validation.json"),
        JSON.stringify(review, null, 2),
        "utf-8",
      );
      const comparison = await compareHeldOut({
        heldOutReview: review,
        synthesis,
        pack: ctx.pack,
        adjudicatorClient: new ModelClient(
          ctx.config.models.synthesizer.id,
          ctx.providerSettings,
          tracker,
        ),
        onWarning: (m) => console.error(m),
      });
      writeHeldOutTriage(runDir, comparison);
      synthesis["held_out_validator_status"] = comparison.status;
      fs.writeFileSync(synthesisPath, JSON.stringify(synthesis, null, 2), "utf-8");
      recordHoldoutUse({
        ledgerPath: path.join(runDir, "holdout_ledger.yaml"),
        model: ctx.config.models.held_out.id,
        docSha256: null,
        verdict: String(review[ctx.pack.verdictField] ?? "unknown"),
        runDir,
        onWarning: (m) => console.error(m),
      });
      console.log(`Status: ${comparison.status} (${comparison.method})`);
      if (comparison.escapeRate !== null) {
        console.log(`Escape rate: ${(comparison.escapeRate * 100).toFixed(0)}%`);
      }
      console.log(`Triage: ${path.join(runDir, "held_out_new_issues.md")}`);
      console.log(`Cost: $${tracker.totalUsd.toFixed(4)}`);
    });

  // --- golden ---------------------------------------------------------------
  program
    .command("golden")
    .description("Seeded-defect recall + negative control (+ discrimination with known good/bad)")
    .option("--dir <path>", "golden directory", "./golden")
    .option("--rubric <name>", "rubric supplying the gates (default: resolved from config)")
    .action(async (opts: { dir: string; rubric?: string }) => {
      const goldenDir = path.resolve(opts.dir);
      const ctx = resolveContext(null, { rubric: opts.rubric });
      const cases = loadGoldenManifest(goldenDir);
      if (cases.length === 0) {
        console.log("Golden manifest has no cases — nothing to measure.");
        return;
      }
      const outcomes: CaseOutcome[] = cases.map((c) =>
        runMechanicalCase(c, goldenDir, ctx.pack),
      );
      const discrimination = evaluateDiscrimination(outcomes);
      const report = formatGoldenReport(outcomes, false, discrimination);
      console.log(report);
      const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "_");
      const reportPath = path.join(goldenDir, `report_${ts}.md`);
      fs.writeFileSync(reportPath, report, "utf-8");
      console.log(`Report saved to ${reportPath}`);
      if (goldenFailed(outcomes, discrimination)) {
        fail("Golden run FAILED (missed defects, false positives, or failed discrimination).");
      }
    });

  // --- diff -----------------------------------------------------------------
  program
    .command("diff <run-a> <run-b>")
    .description("Compare two review output directories")
    .action((runA: string, runB: string) => {
      const dirA = path.resolve(runA);
      const dirB = path.resolve(runB);
      const target = fs.existsSync(path.join(dirA, "run_metadata.yaml"))
        ? runTarget(dirA)
        : null;
      const ctx = resolveContext(target, {});
      console.log(
        formatDiff(compareRuns({ runDirA: dirA, runDirB: dirB, pack: ctx.pack })),
      );
    });

  // --- handoff --------------------------------------------------------------
  program
    .command("handoff <run-dir>")
    .description("Freeze the predictions row (write-once) and emit deliverables")
    .option("--hypothesis <text>", "what this version is predicted to do better", "")
    .option("--dest <dir>", "handoff destination (default: <run-dir>/handoff)")
    .action((runDirArg: string, opts: { hypothesis: string; dest?: string }) => {
      const runDir = path.resolve(runDirArg);
      const target = runTarget(runDir);
      const ctx = resolveContext(fs.existsSync(target) ? target : null, {});
      const row = buildPredictionRow({
        runDir,
        pack: ctx.pack,
        hypothesis: opts.hypothesis,
      });
      const ledgerPath = path.join(homePaths().home, PREDICTIONS_FILENAME);
      try {
        freezePrediction(row, ledgerPath);
      } catch (exc) {
        if (exc instanceof LedgerFrozenError) fail(exc.message);
        throw exc;
      }
      const dest = opts.dest ? path.resolve(opts.dest) : path.join(runDir, "handoff");
      const emitted = emitHandoff({ runDir, destDir: dest });
      console.log(`Ledger: ${ledgerPath}`);
      console.log(
        `Prediction frozen: run=${row.run_id} composite=${row.composite ?? "n/a"}`,
      );
      for (const p of emitted) console.log(`Emitted: ${p}`);
    });

  // --- outcome (M6.6 — the only true ground truth in the system) ------------
  program
    .command("outcome <run-id>")
    .description("Record what actually happened, joined onto the frozen prediction")
    .requiredOption("--result <text>", "the real-world result (published, funded, rejected, …)")
    .action((runId: string, opts: { result: string }) => {
      const ledgerPath = path.join(homePaths().home, PREDICTIONS_FILENAME);
      const row = recordOutcome({ ledgerPath, runId, result: opts.result });
      console.log(
        `Recorded outcome for ${runId} (predicted composite ` +
          `${row.composite ?? "n/a"}): ${opts.result}`,
      );
      console.log(`Ledger: ${ledgerPath} (${row.outcome?.length ?? 0} outcome(s) on this run)`);
    });

  // --- render (M9: idempotent report re-render) -----------------------------
  program
    .command("render <run-dir>")
    .description("Re-render the report and re-evaluate ship gates from artifacts on disk")
    .action((runDirArg: string) => {
      const runDir = path.resolve(runDirArg);
      const target = runTarget(runDir);
      const ctx = resolveContext(fs.existsSync(target) ? target : null, {});
      const synthesisPath = path.join(runDir, "synthesis.json");
      if (!fs.existsSync(synthesisPath)) fail(`No synthesis.json in ${runDir}.`);
      const synthesis = JSON.parse(fs.readFileSync(synthesisPath, "utf-8")) as Record<string, unknown>;
      const { reviews, personas } = loadRawReviews(path.join(runDir, "raw_reviews"), ctx.pack);
      const gatesPath = path.join(runDir, "gates.json");
      const gateResults: Record<string, GateResult> = fs.existsSync(gatesPath)
        ? (JSON.parse(fs.readFileSync(gatesPath, "utf-8")) as Record<string, GateResult>)
        : {};
      const tasks = readValidationTasks(runDir);
      const meta = parseYaml(
        fs.readFileSync(path.join(runDir, "run_metadata.yaml"), "utf-8"),
      ) as Record<string, unknown>;
      const rigorName = String(meta["rigor"] ?? "standard");

      const shipCheck = checkShipGates({
        synthesis,
        reviews,
        gateResults,
        pack: ctx.pack,
        personas,
      });
      const extra = validationTaskShipReasons(tasks, {
        blockOnOpen: rigorName === "rigorous",
      });
      const finalCheck = {
        ok: shipCheck.ok && extra.length === 0,
        reasons: [...shipCheck.reasons, ...extra],
        composite: shipCheck.composite,
        perDimension: shipCheck.perDimension,
      };
      const coldReadPath = path.join(runDir, "cold_read.json");
      const report = generateSynthesisReport({
        synthesis,
        shipCheck: finalCheck,
        personaCoverage: null,
        agreementFlags: null,
        coldRead: fs.existsSync(coldReadPath)
          ? JSON.parse(fs.readFileSync(coldReadPath, "utf-8"))
          : null,
        differentiation: null,
        heldOutComparison: null,
        validationTasks: tasks,
        panelWarnings: [],
      });
      fs.writeFileSync(path.join(runDir, "synthesis_report.md"), report, "utf-8");
      console.log(`Re-rendered ${path.join(runDir, "synthesis_report.md")}`);
      console.log(
        finalCheck.ok
          ? `Verdict: SHIP (composite ${finalCheck.composite ?? "n/a"})`
          : `Verdict: NOT SHIPPABLE — ${finalCheck.reasons.join("; ")}`,
      );
      if (!allGatesPassed(gateResults)) {
        console.log("Note: mechanical gates on record show failures.");
      }
    });
}
