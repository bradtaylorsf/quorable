/**
 * Validation tasks (M6 / plan §5.3) — first-class output.
 *
 * When a persona makes a claim it could not ground ("the contract says X",
 * "contradicts canon doc Y"), the run emits validation_tasks.json: claim,
 * source doc, what would confirm or refute it. A human or a calling agent
 * resolves them; at the `rigorous` tier, unresolved tasks BLOCK the ship
 * gate. The system distinguishes "checked" from "asserted" rather than
 * laundering the difference.
 */

import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ReviewResult } from "./pipeline.js";

export const ValidationTaskSchema = z.object({
  id: z.string(),
  claim: z.string(),
  source_doc: z.string().default(""),
  what_would_confirm: z.string().default(""),
  raised_by: z.array(z.string()).default([]),
  status: z.enum(["open", "confirmed", "refuted", "unverifiable"]).default("open"),
  resolution_note: z.string().default(""),
});

export type ValidationTask = z.infer<typeof ValidationTaskSchema>;

const TasksFileSchema = z.object({
  tasks: z.array(ValidationTaskSchema),
  instructions: z.string().default(""),
});

const INSTRUCTIONS =
  "Each task is a claim a reviewer made but could not ground in the provided " +
  "material. Resolve them by checking the named source: set status to " +
  "confirmed | refuted | unverifiable and add a resolution_note. At the " +
  "rigorous tier, open tasks block the ship gate. Re-run `quorable render " +
  "<run-dir>` after editing to refresh the gate result.";

function normalizeClaim(claim: string): string {
  return claim.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Collect validation_requests across raw reviews, deduped by claim text. */
export function collectValidationTasks(results: ReviewResult[]): ValidationTask[] {
  const byClaim = new Map<string, ValidationTask>();
  let counter = 1;
  for (const r of results) {
    if (r.review === null) continue;
    const requests = r.review["validation_requests"];
    if (!Array.isArray(requests)) continue;
    for (const raw of requests as Record<string, unknown>[]) {
      const claim = String(raw["claim"] ?? "").trim();
      if (!claim) continue;
      const key = normalizeClaim(claim);
      const raisedBy = `${r.persona} (${r.model})`;
      const existing = byClaim.get(key);
      if (existing) {
        if (!existing.raised_by.includes(raisedBy)) existing.raised_by.push(raisedBy);
        continue;
      }
      byClaim.set(key, {
        id: `vt-${String(counter++).padStart(3, "0")}`,
        claim,
        source_doc: String(raw["source_doc"] ?? ""),
        what_would_confirm: String(raw["what_would_confirm"] ?? ""),
        raised_by: [raisedBy],
        status: "open",
        resolution_note: "",
      });
    }
  }
  return [...byClaim.values()];
}

export function writeValidationTasks(runDir: string, tasks: ValidationTask[]): string {
  const filePath = path.join(runDir, "validation_tasks.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify({ tasks, instructions: INSTRUCTIONS }, null, 2) + "\n",
    "utf-8",
  );
  return filePath;
}

export function readValidationTasks(runDir: string): ValidationTask[] {
  const filePath = path.join(runDir, "validation_tasks.json");
  if (!fs.existsSync(filePath)) return [];
  const parsed = TasksFileSchema.safeParse(
    JSON.parse(fs.readFileSync(filePath, "utf-8")),
  );
  if (!parsed.success) {
    throw new Error(
      `validation_tasks.json is malformed: ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    );
  }
  return parsed.data.tasks;
}

/**
 * Ship-gate contribution: open tasks block at rigorous; refuted claims are
 * findings in their own right at every tier (a reviewer's assertion was
 * checked and found false — that must surface, not vanish).
 */
export function validationTaskShipReasons(
  tasks: ValidationTask[],
  opts: { blockOnOpen: boolean },
): string[] {
  const reasons: string[] = [];
  const open = tasks.filter((t) => t.status === "open");
  if (opts.blockOnOpen && open.length > 0) {
    reasons.push(
      `${open.length} unresolved validation task(s): ` +
        open.map((t) => t.id).join(", ") +
        " (resolve in validation_tasks.json)",
    );
  }
  return reasons;
}
