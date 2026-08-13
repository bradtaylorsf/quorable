/**
 * Regression tracking across runs, ported from regressions.py.
 *
 * regressions.yaml lists weaknesses from prior document versions. A
 * previously-resolved weakness that reappears is flagged loudly. Absence
 * alone never resolves an entry: auto-resolution requires the document
 * hash to have CHANGED since the entry was recorded — an unchanged document
 * failing to re-surface a weakness is reviewer noise, not a fix.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { sequenceRatio } from "./seqmatch.js";

export const FUZZY_THRESHOLD = 0.85;

export const RegressionEntrySchema = z.object({
  description: z.string(),
  unit: z.string(),
  severity: z.string(),
  run_id: z.string(),
  date: z.string(),
  resolved: z.boolean().default(false),
  resolved_run_id: z.string().nullable().default(null),
  doc_sha256: z.string().nullable().default(null),
});

export type RegressionEntry = z.infer<typeof RegressionEntrySchema>;

const RegistrySchema = z.object({
  entries: z.array(RegressionEntrySchema).default([]),
});

export interface RegressionRegistry {
  entries: RegressionEntry[];
}

export interface RegressionResult {
  reappeared: RegressionEntry[];
  newEntries: RegressionEntry[];
  resolved: RegressionEntry[];
}

export function loadRegistry(filePath: string): RegressionRegistry {
  if (!fs.existsSync(filePath)) return { entries: [] };
  const raw = parseYaml(fs.readFileSync(filePath, "utf-8"));
  if (raw === null || raw === undefined) return { entries: [] };
  return RegistrySchema.parse(raw);
}

export function saveRegistry(registry: RegressionRegistry, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(registry), "utf-8");
}

type Key = string;

/** Normalized (description, unit) key — JSON keeps the parts separable. */
function makeKey(description: string, unit: string): Key {
  return JSON.stringify([description.toLowerCase().trim(), unit.toLowerCase().trim()]);
}

function keyParts(key: Key): [string, string] {
  return JSON.parse(key) as [string, string];
}

function fuzzyFind(
  key: Key,
  candidates: Map<Key, RegressionEntry>,
): RegressionEntry | null {
  const [desc, unit] = keyParts(key);
  // Short descriptions are unreliable for fuzzy matching — require a
  // higher threshold when under 40 characters (parity with the parent).
  const effectiveThreshold = desc.length < 40 ? 0.95 : FUZZY_THRESHOLD;
  let bestRatio = 0;
  let bestEntry: RegressionEntry | null = null;
  for (const [candidateKey, entry] of candidates) {
    const [cDesc, cUnit] = keyParts(candidateKey);
    if (unit !== cUnit) continue;
    const ratio = sequenceRatio(desc, cDesc);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestEntry = entry;
    }
  }
  return bestRatio >= effectiveThreshold ? bestEntry : null;
}

export function checkRegressions(args: {
  synthesis: Record<string, unknown>;
  registry: RegressionRegistry;
  runId: string;
  docSha256?: string | null;
  onWarning?: (msg: string) => void;
}): RegressionResult {
  const warn = args.onWarning ?? (() => {});
  const docSha256 = args.docSha256 ?? null;
  const weaknessesRaw = args.synthesis["consensus_weaknesses"];
  const weaknesses = Array.isArray(weaknessesRaw)
    ? (weaknessesRaw as Record<string, unknown>[])
    : [];

  const existingByKey = new Map<Key, RegressionEntry>();
  for (const entry of args.registry.entries) {
    existingByKey.set(makeKey(entry.description, entry.unit), entry);
  }

  const result: RegressionResult = { reappeared: [], newEntries: [], resolved: [] };
  const now = new Date().toISOString().slice(0, 10);
  const matchedExistingKeys = new Set<Key>();

  for (const weakness of weaknesses) {
    const description = String(weakness["description"] ?? "");
    const unit = String(weakness["unit"] ?? "");
    const key = makeKey(description, unit);

    let existing = existingByKey.get(key) ?? null;
    let matchedKey = key;
    if (existing === null) {
      existing = fuzzyFind(key, existingByKey);
      if (existing !== null) {
        matchedKey = makeKey(existing.description, existing.unit);
      }
    }

    if (existing !== null) {
      matchedExistingKeys.add(matchedKey);
      if (existing.resolved) {
        result.reappeared.push(existing);
        warn(
          `Regression detected: '${existing.description}' (${existing.unit}) — ` +
            `previously resolved in ${existing.resolved_run_id}`,
        );
      }
    } else {
      result.newEntries.push({
        description,
        unit,
        severity: String(weakness["severity"] ?? ""),
        run_id: args.runId,
        date: now,
        resolved: false,
        resolved_run_id: null,
        doc_sha256: docSha256,
      });
    }
  }

  // Auto-resolution requires a demonstrably revised document.
  for (const [key, entry] of existingByKey) {
    if (entry.resolved || matchedExistingKeys.has(key)) continue;
    if (entry.doc_sha256 === null) continue; // legacy entry: never auto-resolve
    if (docSha256 === null || entry.doc_sha256 === docSha256) continue; // unchanged doc: noise
    result.resolved.push(entry);
  }

  return result;
}

export function updateRegistry(args: {
  registry: RegressionRegistry;
  result: RegressionResult;
  runId: string;
}): RegressionRegistry {
  const resolvedKeys = new Set(
    args.result.resolved.map((e) => makeKey(e.description, e.unit)),
  );
  const reappearedKeys = new Set(
    args.result.reappeared.map((e) => makeKey(e.description, e.unit)),
  );
  for (const entry of args.registry.entries) {
    const key = makeKey(entry.description, entry.unit);
    if (resolvedKeys.has(key)) {
      entry.resolved = true;
      entry.resolved_run_id = args.runId;
    } else if (reappearedKeys.has(key)) {
      entry.resolved = false;
      entry.resolved_run_id = null;
    }
  }
  args.registry.entries.push(...args.result.newEntries);
  return args.registry;
}
