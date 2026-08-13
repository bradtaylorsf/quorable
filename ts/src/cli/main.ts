#!/usr/bin/env node
/**
 * quorable — multi-model adversarial review councils for any document.
 *
 * `quorable review <file>` works from a clean install with only an
 * OpenRouter key: interactive council pick on a TTY (every choice echoes
 * its equivalent flags), panel run, scored synthesis report + traces +
 * validation tasks in <filename>-reviewed/.
 */

import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { registerManageCommands } from "./commands/manage.js";
import { registerRunCommands } from "./commands/runs.js";
import { allModelSpecs, resolveContext, type ReviewFlags } from "./context.js";
import { confirmCostInteractive, firstRunKeyWizard, isInteractive, runPicker } from "./picker.js";
import { effectiveKeys, storeKey } from "../config/home.js";
import { RIGOR_PRESETS, RIGOR_TIERS, type RigorTier } from "../config/schema.js";
import { refreshLivePricing } from "../engine/costs.js";
import { runReview, type ReviewOutcome } from "../engine/review.js";
import { checkModelAvailability } from "../providers/registry.js";

const program = new Command();

program
  .name("quorable")
  .description(
    "Multi-model adversarial review councils for any document — scored " +
      "synthesis with honest agreement statistics.",
  )
  .version("0.2.0");

interface ReviewCliOptions {
  council?: string;
  rubric?: string;
  rigor?: string;
  persona?: string[];
  model?: string[];
  context?: string[];
  out?: string;
  yes?: boolean;
  save?: boolean;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function ensureKeys(specs: string[], targetPath: string | null, flags: ReviewFlags): Promise<void> {
  let ctx = resolveContext(targetPath, flags);
  let problems = checkModelAvailability(specs, ctx.providerSettings);
  if (problems.length === 0) return;

  const keys = effectiveKeys();
  const noKeysAtAll = !keys.openrouter && !keys.anthropic && !keys.openai;
  if (noKeysAtAll && isInteractive()) {
    const key = await firstRunKeyWizard();
    if (key) {
      storeKey("openrouter", key);
      ctx = resolveContext(targetPath, flags);
      problems = checkModelAvailability(specs, ctx.providerSettings);
      if (problems.length === 0) return;
    }
  }
  for (const p of problems) console.error(p);
  process.exit(1);
}

async function executeReview(
  target: string,
  opts: ReviewCliOptions,
  mode: "review" | "panel",
): Promise<void> {
  if (!fs.existsSync(target)) {
    console.error(`File not found: ${target}`);
    process.exit(1);
  }
  if (opts.rigor && !(RIGOR_TIERS as readonly string[]).includes(opts.rigor)) {
    console.error(`--rigor must be one of: ${RIGOR_TIERS.join(", ")}`);
    process.exit(1);
  }

  const flags: ReviewFlags = {
    council: opts.council,
    rubric: opts.rubric,
    rigor: opts.rigor,
    personas: opts.persona,
    models: opts.model,
  };

  // Interactive picker: TTY, no explicit council, not suppressed by --yes.
  let ctx = resolveContext(target, flags);
  if (isInteractive() && !opts.council && !opts.yes) {
    const picked = await runPicker({
      roots: ctx.roots,
      defaultCouncil: ctx.config.council,
      defaultRigor: ctx.config.rigor as RigorTier,
      defaultModels: ctx.config.models.reviewers.filter((r) => !r.held_out).map((r) => r.id),
    });
    if (picked.cancelled) {
      console.error("Cancelled.");
      process.exit(0);
    }
    flags.council = picked.council;
    flags.rigor = picked.rigor;
    if (picked.personas) flags.personas = picked.personas;
    if (picked.models) flags.models = picked.models;
    ctx = resolveContext(target, flags);

    if (opts.save) {
      const projectConfig = path.join(path.dirname(path.resolve(target)), "quorable.yaml");
      const lines = [
        `council: ${picked.council}`,
        `rigor: ${picked.rigor}`,
        ...(picked.personas ? ["personas:", ...picked.personas.map((p) => `  - ${p}`)] : []),
        ...(picked.models
          ? [
              "models:",
              "  reviewers:",
              ...picked.models.map((m) => `    - id: ${m}`),
            ]
          : []),
      ];
      fs.writeFileSync(projectConfig, lines.join("\n") + "\n", "utf-8");
      console.log(`Saved choices to ${projectConfig}`);
    }
  }

  const specs = allModelSpecs(ctx.config, ctx.rigor);
  await ensureKeys(specs, target, flags);
  ctx = resolveContext(target, flags);

  // Best-effort live pricing so the pre-run estimate tracks reality.
  await refreshLivePricing(
    specs.filter((s) => !s.includes(":")),
  ).catch(() => false);

  const rigorSettings = mode === "panel" ? { ...ctx.rigor, heldOut: false } : ctx.rigor;

  const outcome: ReviewOutcome = await runReview({
    targetPath: target,
    contextDirs: (opts.context ?? []).map((d) => path.resolve(d)),
    outDir: opts.out ? path.resolve(opts.out) : null,
    pack: ctx.pack,
    personas: ctx.personas,
    personaOverlays: ctx.personaOverlays,
    config: ctx.config,
    rigor: rigorSettings,
    providerSettings: ctx.providerSettings,
    systemPrompt: ctx.prompts.system,
    synthesisPrompt: ctx.prompts.synthesis,
    coldReaderPrompt: ctx.prompts.coldReader,
    confirmCost: async (_estimate, perLoopUsd) => {
      const threshold = ctx.config.pipeline.cost_threshold;
      if (perLoopUsd <= threshold || opts.yes) return true;
      if (!isInteractive()) {
        console.error(
          `Estimated cost $${perLoopUsd.toFixed(2)} exceeds ` +
            `$${threshold.toFixed(2)} and no TTY to confirm — pass --yes to proceed.`,
        );
        return false;
      }
      return confirmCostInteractive(perLoopUsd, threshold);
    },
    onEvent: (msg) => console.error(msg),
  });

  console.log("");
  if (outcome.aborted) {
    console.error(`ABORTED: ${outcome.abortReason}`);
    console.error(`Partial artifacts: ${outcome.outDir}`);
    process.exit(1);
  }

  const check = outcome.shipCheck;
  if (mode === "review") {
    console.log(
      check.ok
        ? `Verdict: SHIP (composite ${check.composite?.toFixed(2) ?? "n/a"})`
        : `Verdict: NOT SHIPPABLE${check.composite !== null ? ` (composite ${check.composite.toFixed(2)})` : ""}`,
    );
    for (const reason of check.reasons) console.log(`  - ${reason}`);
  } else {
    console.log(
      `Panel complete (composite ${check.composite?.toFixed(2) ?? "n/a"} — informational, no ship verdict)`,
    );
  }
  console.log(`Report:  ${path.join(outcome.outDir, "synthesis_report.md")}`);
  console.log(`Traces:  ${path.join(outcome.outDir, "raw_reviews")}`);
  if (outcome.validationTasks.length > 0) {
    const open = outcome.validationTasks.filter((t) => t.status === "open").length;
    console.log(
      `Validation tasks: ${outcome.validationTasks.length} (${open} open) — ` +
        `${path.join(outcome.outDir, "validation_tasks.json")}`,
    );
  }
  console.log(`Cost:    $${outcome.totalCostUsd.toFixed(4)}`);
}

program
  .command("review <file>")
  .description("Run an adversarial review council against a document (or directory)")
  .option("--council <name>", "council to convene (skips the interactive picker)")
  .option("--rubric <name>", "override the council's rubric")
  .option("--rigor <tier>", `rigor tier: ${RIGOR_TIERS.join("|")}`)
  .option("--persona <name>", "cherry-pick persona (repeatable)", collect, [])
  .option("--model <id>", "reviewer model id, provider-qualified ok (repeatable)", collect, [])
  .option("--context <dir>", "context directory, globbed into the review (repeatable)", collect, [])
  .option("--out <dir>", "output directory (default: <filename>-reviewed/)")
  .option("-y, --yes", "no picker, no confirmations (CI mode)")
  .option("--save", "write interactive choices to the project quorable.yaml")
  .action(async (file: string, opts: ReviewCliOptions) => {
    await executeReview(resolveTarget(file), opts, "review");
  });

program
  .command("panel <file>")
  .description("Stage 1+2 only: panel + synthesis, no ship verdict (informational)")
  .option("--council <name>", "council to convene")
  .option("--rubric <name>", "override the council's rubric")
  .option("--rigor <tier>", `rigor tier: ${RIGOR_TIERS.join("|")}`)
  .option("--persona <name>", "cherry-pick persona (repeatable)", collect, [])
  .option("--model <id>", "reviewer model id (repeatable)", collect, [])
  .option("--context <dir>", "context directory (repeatable)", collect, [])
  .option("--out <dir>", "output directory")
  .option("-y, --yes", "no picker, no confirmations")
  .action(async (file: string, opts: ReviewCliOptions) => {
    await executeReview(resolveTarget(file), opts, "panel");
  });

/** Directory targets: review the concatenation? v1 picks the largest doc. */
function resolveTarget(file: string): string {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return resolved;
  }
  // Directory-as-primary: concatenate member documents with provenance
  // markers into a synthetic primary (plan M8).
  const parts: string[] = [];
  const exts = new Set([".md", ".markdown", ".txt"]);
  for (const entry of fs.readdirSync(resolved).sort()) {
    const full = path.join(resolved, entry);
    if (fs.statSync(full).isFile() && exts.has(path.extname(entry).toLowerCase())) {
      parts.push(`<!-- file: ${entry} -->\n\n${fs.readFileSync(full, "utf-8")}`);
    }
  }
  if (parts.length === 0) {
    console.error(`Directory ${resolved} contains no reviewable documents (.md/.txt).`);
    process.exit(1);
  }
  const combined = path.join(resolved, ".quorable-combined.md");
  fs.writeFileSync(combined, parts.join("\n\n---\n\n"), "utf-8");
  console.error(
    `Directory target: combined ${parts.length} file(s) into ${combined} ` +
      `(per-file provenance markers included).`,
  );
  return combined;
}

registerManageCommands(program);
registerRunCommands(program);

program.parseAsync(process.argv).catch((exc: unknown) => {
  console.error(exc instanceof Error ? exc.message : String(exc));
  process.exit(1);
});
