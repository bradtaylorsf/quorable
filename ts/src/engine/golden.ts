/**
 * Golden-set harness, ported from golden.py: measured recall against
 * seeded defects + a clean negative control. Extended with the M6.5
 * DISCRIMINATION TEST: alongside seeded defects, cases can be marked
 * `known: good|bad` (a real accepted document, a real rejected one). If
 * the panel cannot separate them by composite, the rubric is broken
 * regardless of what κ says — this tests the eval itself, which recall
 * testing structurally cannot.
 *
 * Mechanical detectors are free and run by default; `llm_*` detectors and
 * the discrimination panel only run with --live (they cost money).
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { runGates, type Gate, type GateResult } from "./gates.js";
import type { Pack } from "../pack/types.js";

const GoldenDefectSchema = z.object({
  id: z.string(),
  detector: z.string(),
  expect: z.string(),
});

const GoldenCaseSchema = z.object({
  id: z.string(),
  path: z.string(),
  negative_control: z.boolean().default(false),
  /** M6.5: real-world outcome label for the discrimination test. */
  known: z.enum(["good", "bad"]).nullish().default(null),
  defects: z.array(GoldenDefectSchema).default([]),
});

const GoldenManifestSchema = z.object({
  cases: z.array(GoldenCaseSchema).default([]),
});

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

export interface DefectOutcome {
  defectId: string;
  detector: string;
  expect: string;
  caught: boolean;
  detail: string;
}

export interface CaseOutcome {
  caseId: string;
  negativeControl: boolean;
  known: "good" | "bad" | null;
  outcomes: DefectOutcome[];
  falsePositives: string[];
  skippedLive: number;
  /** Composite from the discrimination panel (live only). */
  composite: number | null;
}

export function loadGoldenManifest(goldenDir: string): GoldenCase[] {
  const manifestPath = path.join(goldenDir, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Golden manifest not found: ${manifestPath}`);
  }
  const parsed = GoldenManifestSchema.safeParse(
    parseYaml(fs.readFileSync(manifestPath, "utf-8")),
  );
  if (!parsed.success) {
    throw new Error(
      `Golden manifest invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data.cases;
}

/** Run the pack's mechanical gates against one golden case. */
export function runMechanicalCase(
  goldenCase: GoldenCase,
  goldenDir: string,
  pack: Pack,
): CaseOutcome {
  const docPath = path.join(goldenDir, goldenCase.path);
  const text = fs.readFileSync(docPath, "utf-8");
  const outcome: CaseOutcome = {
    caseId: goldenCase.id,
    negativeControl: goldenCase.negative_control,
    known: goldenCase.known ?? null,
    outcomes: [],
    falsePositives: [],
    skippedLive: 0,
    composite: null,
  };

  const gates = new Map<string, Gate>(pack.mechanicalGates.map((g) => [g.name, g]));
  const gateResults: Record<string, GateResult> = runGates(pack.mechanicalGates, text);

  for (const defect of goldenCase.defects) {
    if (defect.detector.startsWith("llm_")) {
      outcome.skippedLive += 1;
      continue;
    }
    const gateResult = gateResults[defect.detector];
    if (!gates.has(defect.detector) || gateResult === undefined) {
      outcome.outcomes.push({
        defectId: defect.id,
        detector: defect.detector,
        expect: defect.expect,
        caught: false,
        detail:
          `detector '${defect.detector}' is not a pack gate ` +
          `(available: ${[...gates.keys()].sort().join(", ")})`,
      });
      continue;
    }
    const findings = gateResult.findings.join(" | ");
    const caught = gateResult.findings.some((f) => f.includes(defect.expect));
    outcome.outcomes.push({
      defectId: defect.id,
      detector: defect.detector,
      expect: defect.expect,
      caught,
      detail: `findings: ${findings || "(none)"}`,
    });
  }

  if (outcome.negativeControl) {
    for (const [name, result] of Object.entries(gateResults)) {
      outcome.falsePositives.push(...result.findings.map((f) => `${name}: ${f}`));
    }
  }

  return outcome;
}

export interface DiscriminationResult {
  goodCase: string;
  badCase: string;
  goodComposite: number | null;
  badComposite: number | null;
  separated: boolean;
}

/**
 * M6.5 verdict: the known-good document must outscore the known-bad one.
 * Composites come from a live mini-panel run by the caller (this module
 * stays network-free).
 */
export function evaluateDiscrimination(outcomes: CaseOutcome[]): DiscriminationResult[] {
  const good = outcomes.filter((o) => o.known === "good" && o.composite !== null);
  const bad = outcomes.filter((o) => o.known === "bad" && o.composite !== null);
  const results: DiscriminationResult[] = [];
  for (const g of good) {
    for (const b of bad) {
      results.push({
        goodCase: g.caseId,
        badCase: b.caseId,
        goodComposite: g.composite,
        badComposite: b.composite,
        separated: g.composite! > b.composite!,
      });
    }
  }
  return results;
}

export function formatGoldenReport(
  outcomes: CaseOutcome[],
  live: boolean,
  discrimination: DiscriminationResult[] = [],
): string {
  const lines = ["# Golden-Set Report\n"];
  lines.push(`Mode: ${live ? "mechanical + live LLM" : "mechanical only"}\n`);

  const totalSeeded = outcomes.reduce((a, o) => a + o.outcomes.length, 0);
  const totalCaught = outcomes.reduce(
    (a, o) => a + o.outcomes.filter((d) => d.caught).length,
    0,
  );
  const totalSkipped = outcomes.reduce((a, o) => a + o.skippedLive, 0);
  if (totalSeeded || totalSkipped) {
    lines.push(
      `**Recall: ${totalCaught}/${totalSeeded} seeded defects caught` +
        (totalSkipped ? ` (${totalSkipped} llm defects skipped — run with --live)` : "") +
        ".**\n",
    );
  }

  for (const o of outcomes) {
    const tags = [
      o.negativeControl ? " (negative control)" : "",
      o.known ? ` (known ${o.known})` : "",
    ].join("");
    lines.push(`## ${o.caseId}${tags}\n`);
    if (o.outcomes.length > 0) {
      lines.push("| Defect | Detector | Expected | Caught |");
      lines.push("|---|---|---|---|");
      for (const d of o.outcomes) {
        lines.push(
          `| ${d.defectId} | ${d.detector} | ${d.expect} | ` +
            `${d.caught ? "YES" : "**MISSED**"} |`,
        );
      }
      lines.push("");
      for (const d of o.outcomes) {
        if (!d.caught) lines.push(`- MISSED ${d.defectId}: ${d.detail}`);
      }
      lines.push("");
    }
    if (o.skippedLive) {
      lines.push(`- ${o.skippedLive} llm defect(s) not evaluated (mechanical-only run)\n`);
    }
    if (o.composite !== null) {
      lines.push(`- Panel composite: ${o.composite.toFixed(2)}\n`);
    }
    if (o.negativeControl) {
      if (o.falsePositives.length > 0) {
        lines.push(`**False positives (${o.falsePositives.length}):**`);
        for (const fp of o.falsePositives) lines.push(`- ${fp}`);
      } else {
        lines.push("**False positives: none.**");
      }
      lines.push("");
    }
  }

  if (discrimination.length > 0) {
    lines.push("## Discrimination Test (does the rubric separate good from bad?)\n");
    for (const d of discrimination) {
      lines.push(
        `- ${d.goodCase} (${d.goodComposite?.toFixed(2)}) vs ${d.badCase} ` +
          `(${d.badComposite?.toFixed(2)}): ` +
          (d.separated
            ? "separated"
            : "**NOT SEPARATED — the rubric cannot tell a known-good document " +
              "from a known-bad one; fix the rubric before trusting any score**"),
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Non-zero-exit condition: any miss, mechanical false positive, or failed separation. */
export function goldenFailed(
  outcomes: CaseOutcome[],
  discrimination: DiscriminationResult[] = [],
): boolean {
  const missed = outcomes.some((o) => o.outcomes.some((d) => !d.caught));
  const mechanicalFps = outcomes.some(
    (o) => o.negativeControl && o.falsePositives.some((fp) => !fp.startsWith("llm")),
  );
  const notSeparated = discrimination.some((d) => !d.separated);
  return missed || mechanicalFps || notSeparated;
}
