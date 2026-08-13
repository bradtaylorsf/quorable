/**
 * Human-readable report generation, ported from reports.py and extended
 * with the M6 blind-spot integrity sections: rubric gaps from the cold
 * read, two-sided agreement flags, persona differentiation, escape rate,
 * and open validation tasks. Everything the report claims numerically was
 * computed in code, never copied from an LLM.
 */

import type { ColdRead } from "./coldReader.js";
import type { AgreementFlags, PersonaOverlap } from "./integrity.js";
import type { HeldOutComparison } from "./heldOut.js";
import type { ShipCheckResult } from "./scoring.js";
import type { ValidationTask } from "./validationTasks.js";
import { rubricGaps } from "./coldReader.js";
import type { CostTracker } from "./costs.js";

type Synthesis = Record<string, unknown>;

function severityMarker(severity: string): string {
  return (
    { critical: "[CRITICAL]", major: "[MAJOR]", minor: "[MINOR]" }[severity] ?? ""
  );
}

function formatAgreementTable(agreement: Record<string, number>): string {
  const lines = [
    "| Metric | Value | Interpretation |",
    "|--------|-------|----------------|",
  ];
  for (const [key, val] of Object.entries(agreement).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    let valStr: string;
    let interp: string;
    if (Number.isNaN(val)) {
      valStr = "N/A";
      interp = "Insufficient data";
    } else if (key.startsWith("icc_")) {
      valStr = val.toFixed(4);
      interp =
        val >= 0.75
          ? "Excellent agreement"
          : val >= 0.6
            ? "Good agreement"
            : val >= 0.4
              ? "Moderate agreement"
              : "**Genuinely contested**";
    } else {
      valStr = val.toFixed(4);
      interp =
        val >= 0.61
          ? "Substantial agreement"
          : val >= 0.41
            ? "Moderate agreement"
            : val >= 0.21
              ? "Fair agreement"
              : "**Poor agreement**";
    }
    let label: string;
    if (key.startsWith("icc_") && key.includes("__")) {
      const [dim, persona] = key.slice(4).split("__", 2) as [string, string];
      label = `ICC (${persona}): ${dim}`;
    } else if (key.startsWith("icc_")) {
      label = `ICC (pooled, all personas): ${key.slice(4)}`;
    } else {
      label = key.replace("fleiss_kappa_", "Fleiss' kappa: ");
    }
    lines.push(`| ${label} | ${valStr} | ${interp} |`);
  }
  return lines.join("\n");
}

export interface ReportInputs {
  synthesis: Synthesis;
  shipCheck: ShipCheckResult | null;
  personaCoverage: Record<string, number> | null;
  agreementFlags: AgreementFlags | null;
  coldRead: ColdRead | null;
  differentiation: PersonaOverlap[] | null;
  heldOutComparison: HeldOutComparison | null;
  validationTasks: ValidationTask[];
  panelWarnings: string[];
  priorSynthesis?: Synthesis | null;
}

export function generateSynthesisReport(inputs: ReportInputs): string {
  const sections: string[] = [];
  const { synthesis } = inputs;

  sections.push("# quorable Adversarial Review — Synthesis Report\n");

  // --- Verdict summary ---
  if (inputs.shipCheck) {
    const check = inputs.shipCheck;
    sections.push("## Verdict\n");
    sections.push(
      check.ok
        ? "**SHIP** — all gates passed.\n"
        : "**NOT SHIPPABLE** — " + check.reasons.map((r) => `\n- ${r}`).join("") + "\n",
    );
    if (check.composite !== null) {
      sections.push(
        `Composite: **${check.composite.toFixed(2)}** | ` +
          Object.entries(check.perDimension)
            .map(([d, v]) => `${d}: ${v.toFixed(2)}`)
            .join(" | ") +
          "\n",
      );
    }
  }

  // --- Panel composition warnings (statistical honesty, up front) ---
  if (inputs.panelWarnings.length > 0) {
    sections.push("## Panel Warnings\n");
    for (const w of inputs.panelWarnings) sections.push(`- **${w}**\n`);
  }

  // --- Persona coverage (a missing lens changes everything below) ---
  if (inputs.personaCoverage !== null) {
    const coverage = inputs.personaCoverage;
    const missing = Object.entries(coverage)
      .filter(([, n]) => n === 0)
      .map(([p]) => p);
    sections.push("## Review Coverage\n");
    sections.push(
      "Successful reviews per persona — " +
        Object.entries(coverage)
          .map(([p, n]) => `${p}: ${n}`)
          .join(", ") +
        "\n",
    );
    if (missing.length > 0) {
      sections.push(
        `**WARNING: no successful reviews from persona(s) ${missing.join(", ")}. ` +
          `This synthesis is missing those lenses entirely — re-run them ` +
          `before relying on it.**\n`,
      );
    }
  }

  // --- Cold read (M6.1): the only signal not conditioned on the rubric ---
  if (inputs.coldRead !== null) {
    sections.push("## Cold Read\n");
    sections.push(`> ${inputs.coldRead.overall_impression}\n`);
    sections.push(
      `Would finish reading: **${inputs.coldRead.would_finish_reading ? "yes" : "no"}**\n`,
    );
    const gaps = rubricGaps(inputs.coldRead);
    if (gaps.length > 0) {
      sections.push(
        "### Rubric gaps\n\nReader reactions that map to NO rubric dimension — " +
          "the rubric cannot see these:\n",
      );
      for (const gap of gaps) {
        sections.push(`- ${gap.reaction} *(at: ${gap.location || "unspecified"})*\n`);
      }
    } else if (inputs.coldRead.reactions.length > 0) {
      sections.push("No rubric gaps: every cold-read reaction maps to a scored dimension.\n");
    }
  }

  // --- Consensus weaknesses ---
  const weaknesses = (synthesis["consensus_weaknesses"] ?? []) as Record<string, unknown>[];
  sections.push("## Consensus Weaknesses\n");
  if (weaknesses.length > 0) {
    for (const severity of ["critical", "major", "minor"]) {
      const group = weaknesses.filter((w) => w["severity"] === severity);
      if (group.length === 0) continue;
      sections.push(`### ${severity[0]!.toUpperCase()}${severity.slice(1)} Issues\n`);
      for (const w of group) {
        sections.push(
          `- ${severityMarker(String(w["severity"]))} **${w["unit"] ?? ""}**: ` +
            `${w["description"]} (${w["reviewer_count"] ?? "?"} reviewers)\n` +
            `  - *Suggested fix:* ${w["suggested_fix"] ?? ""}\n`,
        );
      }
    }
  } else {
    sections.push("No consensus weaknesses identified.\n");
  }

  // --- Contested issues ---
  const contested = (synthesis["contested_issues"] ?? []) as Record<string, unknown>[];
  sections.push("## Contested Issues\n");
  if (contested.length > 0) {
    for (const ci of contested) {
      sections.push(`### ${ci["description"]}\n`);
      sections.push(`**Position A:** ${ci["position_a"]}\n`);
      sections.push(`- Models: ${(ci["models_supporting_a"] as string[])?.join(", ") ?? ""}\n`);
      sections.push(`**Position B:** ${ci["position_b"]}\n`);
      sections.push(`- Models: ${(ci["models_supporting_b"] as string[])?.join(", ") ?? ""}\n`);
    }
  } else {
    sections.push("No contested issues identified.\n");
  }

  // --- Ranked fixes ---
  const fixes = (synthesis["ranked_fixes"] ?? []) as Record<string, unknown>[];
  sections.push("## Ranked Fixes (by priority)\n");
  if (fixes.length > 0) {
    sections.push(
      "| # | Fix | Unit | Impact | Ease | Consensus | Priority |\n" +
        "|---|-----|------|--------|------|-----------|----------|\n",
    );
    fixes.forEach((fix, i) => {
      sections.push(
        `| ${i + 1} | ${fix["description"]} | ${fix["unit"] ?? ""} | ` +
          `${fix["impact"]}/5 | ${fix["ease"]}/5 | ` +
          `${Math.round(Number(fix["consensus"] ?? 0) * 100)}% | ` +
          `${Number(fix["priority_score"] ?? 0).toFixed(1)} |\n`,
      );
    });
  } else {
    sections.push("No fixes ranked.\n");
  }

  // --- Unique arguments ---
  const uniques = (synthesis["unique_arguments"] ?? []) as Record<string, unknown>[];
  if (uniques.length > 0) {
    sections.push("## Unique Arguments (single-reviewer findings)\n");
    for (const ua of uniques) {
      sections.push(
        `- **${ua["source_model"]}** (${ua["source_persona"]}): ${ua["description"]}\n` +
          `  - *Assessment:* ${ua["assessment"]}\n`,
      );
    }
  }

  // --- Agreement statistics + two-sided flags (M6.2) ---
  const agreement = (synthesis["inter_rater_agreement"] ?? {}) as Record<string, number>;
  sections.push("## Inter-Rater Agreement Statistics\n");
  sections.push(formatAgreementTable(agreement) + "\n");
  if (inputs.agreementFlags) {
    const flags = inputs.agreementFlags;
    if (flags.suspiciouslyUniform) {
      sections.push(
        `**SUSPICIOUSLY UNIFORM AGREEMENT: every defined statistic is >= ` +
          `${flags.highThreshold}. Near-perfect agreement across the board ` +
          `usually means redundant personas or correlated raters, not ` +
          `quality. Check persona differentiation below.**\n`,
      );
    }
    if (flags.contested.length > 0) {
      sections.push(
        `Genuinely contested (ICC < ${flags.lowThreshold}): ` +
          `${flags.contested.join(", ")} — the panel does not agree here; ` +
          `read the contested issues rather than trusting the mean.\n`,
      );
    }
  }

  // --- Persona differentiation (M6.3) ---
  if (inputs.differentiation && inputs.differentiation.length > 0) {
    sections.push("## Persona Differentiation\n");
    sections.push(
      "| Persona pair | Overlap | Assessment |\n|---|---|---|\n" +
        inputs.differentiation
          .map(
            (o) =>
              `| ${o.personaA} vs ${o.personaB} | ${(o.overlap * 100).toFixed(0)}% | ` +
              `${o.decorative ? "**DECORATIVE — one of these is not earning its seat; rewrite or drop it**" : "distinct"} |`,
          )
          .join("\n") +
        "\n",
    );
  }

  // --- Held-out comparison + escape rate (M6.4) ---
  if (inputs.heldOutComparison) {
    const c = inputs.heldOutComparison;
    sections.push("## Held-Out Validation\n");
    sections.push(
      `Status: **${c.status}** (${c.method} comparison)` +
        (c.escapeRate !== null
          ? ` | Escape rate: **${(c.escapeRate * 100).toFixed(0)}%**`
          : "") +
        "\n",
    );
    if (c.missedSevOne.length > 0) {
      sections.push(
        "**Severity-1 finding(s) the panel missed entirely (blocks shipping " +
          "at rigorous):**\n" +
          c.missedSevOne.map((m) => `- ${m}`).join("\n") +
          "\n",
      );
    }
    if (c.newIssues.length > 0) {
      sections.push("See `held_out_new_issues.md` for the triage checklist.\n");
    }
  }

  // --- Validation tasks (M6/§5.3) ---
  if (inputs.validationTasks.length > 0) {
    const open = inputs.validationTasks.filter((t) => t.status === "open");
    const refuted = inputs.validationTasks.filter((t) => t.status === "refuted");
    sections.push("## Validation Tasks\n");
    sections.push(
      `${inputs.validationTasks.length} claim(s) reviewers could not ground ` +
        `(${open.length} open, ${refuted.length} refuted) — see ` +
        "`validation_tasks.json`. The system distinguishes *checked* from " +
        "*asserted*: open tasks are assertions, not facts.\n",
    );
    for (const t of open) {
      sections.push(`- [ ] **${t.id}**: ${t.claim} *(check: ${t.source_doc || "?"})*\n`);
    }
  }

  // --- Diff against prior run ---
  if (inputs.priorSynthesis) {
    sections.push("## Changes from Prior Run\n");
    sections.push(generatePriorDiff(inputs.priorSynthesis, synthesis));
  }

  const status = synthesis["held_out_validator_status"] ?? "not_yet_run";
  sections.push(`\n---\n*Held-out validator status: ${status}*\n`);

  return sections.join("\n");
}

function generatePriorDiff(prior: Synthesis, current: Synthesis): string {
  const lines: string[] = [];
  const descs = (s: Synthesis): Set<string> =>
    new Set(
      ((s["consensus_weaknesses"] ?? []) as Record<string, unknown>[]).map((w) =>
        String(w["description"] ?? ""),
      ),
    );
  const priorDescs = descs(prior);
  const currentDescs = descs(current);
  const newW = [...currentDescs].filter((d) => !priorDescs.has(d));
  const resolvedW = [...priorDescs].filter((d) => !currentDescs.has(d));
  if (newW.length > 0) {
    lines.push("### New Weaknesses\n");
    for (const w of newW) lines.push(`- ${w}\n`);
  }
  if (resolvedW.length > 0) {
    lines.push("### Resolved Weaknesses\n");
    for (const w of resolvedW) lines.push(`- ~~${w}~~\n`);
  }
  if (newW.length === 0 && resolvedW.length === 0) {
    lines.push("No changes in consensus weaknesses.\n");
  }
  return lines.join("\n");
}

export function generateCostSummary(tracker: CostTracker): string {
  const lines = ["quorable — Cost Summary", "=".repeat(40)];
  if (tracker.records.length === 0) {
    lines.push("\nNo API calls recorded.");
    return lines.join("\n");
  }
  const byModel = new Map<string, { calls: number; tokens: number; cost: number }>();
  for (const r of tracker.records) {
    const agg = byModel.get(r.model) ?? { calls: 0, tokens: 0, cost: 0 };
    agg.calls += 1;
    agg.tokens += r.totalTokens;
    agg.cost += r.costUsd;
    byModel.set(r.model, agg);
  }
  lines.push("\nPer-Model Breakdown:", "-".repeat(40));
  for (const [model, agg] of [...byModel.entries()].sort()) {
    lines.push(
      `${model.padEnd(40)} ${String(agg.calls).padStart(5)} ` +
        `${String(agg.tokens).padStart(10)} $${agg.cost.toFixed(4).padStart(9)}`,
    );
  }
  lines.push("-".repeat(67));
  lines.push(
    `${"TOTAL".padEnd(40)} ` +
      `${String(tracker.records.length).padStart(5)} ` +
      `${String([...byModel.values()].reduce((a, b) => a + b.tokens, 0)).padStart(10)} ` +
      `$${tracker.totalUsd.toFixed(4).padStart(9)}`,
  );
  return lines.join("\n");
}
