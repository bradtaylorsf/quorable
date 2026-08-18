/**
 * Ports the remaining Python test intent: manifest parsing shapes
 * (test_manifest), parsers incl. truncation rules (test_parsers), golden
 * harness (test_golden), ledger freeze semantics (test_ledger), regression
 * fuzzy matching (test_regressions), unit discovery + merge (§5.2), and
 * run diff.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoManifest, loadManifest, assertManifestLoaded } from "../src/engine/manifest.js";
import {
  MAX_CHARS,
  PrimaryDocTooLargeError,
  documentFromText,
  parseDocument,
  prepareDocuments,
} from "../src/engine/parsers.js";
import {
  evaluateDiscrimination,
  formatGoldenReport,
  goldenFailed,
  loadGoldenManifest,
  runMechanicalCase,
} from "../src/engine/golden.js";
import {
  LedgerFrozenError,
  buildPredictionRow,
  freezePrediction,
  perPersonaVerdicts,
  recordOutcome,
} from "../src/engine/ledger.js";
import { checkRegressions, updateRegistry, type RegressionRegistry } from "../src/engine/regressions.js";
import { mergeUnitReviews, splitByMap, type DocumentMap } from "../src/engine/unitDiscovery.js";
import { compareRuns } from "../src/engine/diff.js";
import { buildPackFromRubric, parseRubric } from "../src/pack/rubric.js";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorable-engine-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const RUBRIC = parseRubric(`
name: t
units: [opening, body, close]
dimensions:
  clarity: {weight: 1.0, scale: [1, 10]}
verdict: {field: verdict, categories: [ship, revise, rethink]}
gates:
  - word_count: {max: 5}
ship: {composite_min: 6.0, dimension_min: 4}
`);
const PACK = buildPackFromRubric(RUBRIC);

// ---------------------------------------------------------------------------
// Manifest (test_manifest intent)
// ---------------------------------------------------------------------------

describe("manifest parsing", () => {
  it("supports all four section shapes", () => {
    const inputsDir = tmpDir;
    for (const f of ["sys.md", "core1.md", "core2.md", "extra1.md", "extra2.md"]) {
      fs.writeFileSync(path.join(inputsDir, f), "x");
    }
    const manifestPath = path.join(inputsDir, "manifest.yaml");
    fs.writeFileSync(
      manifestPath,
      [
        "system_prompt: {path: sys.md, tier: 1}",
        "core:",
        "  primary: {path: core1.md, tier: 1, critical: true, send_to: [stage1]}",
        "  canon: {path: core2.md, tier: 2, send_to: [stage1_critic]}",
        "loose:",
        "  - {path: extra1.md, tier: 2}",
        "nested:",
        "  batch:",
        "    - {path: extra2.md, tier: 3}",
      ].join("\n"),
    );
    const entries = loadManifest(manifestPath, inputsDir);
    expect(entries.map((e) => e.name).sort()).toEqual(
      ["canon", "extra1", "extra2", "primary", "system_prompt"].sort(),
    );
    expect(entries.find((e) => e.name === "canon")!.sendTo).toEqual(["stage1_critic"]);
    expect(entries.find((e) => e.name === "extra2")!.tier).toBe(3);
  });

  it("missing critical files fail loudly", () => {
    const manifestPath = path.join(tmpDir, "manifest.yaml");
    fs.writeFileSync(manifestPath, "core:\n  gone: {path: missing.md, tier: 1, critical: true}\n");
    expect(() => loadManifest(manifestPath, tmpDir)).toThrow(/Critical document missing/);
  });

  it("declared-vs-loaded assertion catches silent skips (M9)", () => {
    fs.writeFileSync(path.join(tmpDir, "a.md"), "x");
    const entries = autoManifest(path.join(tmpDir, "a.md"));
    expect(() => assertManifestLoaded(entries, {})).toThrow(/failed to load/);
  });

  it("autoManifest: target is tier-1 critical primary; context globs to tier-2", () => {
    const target = path.join(tmpDir, "doc.md");
    fs.writeFileSync(target, "primary");
    const ctxDir = path.join(tmpDir, "ctx");
    fs.mkdirSync(path.join(ctxDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(ctxDir, "one.md"), "ctx1");
    fs.writeFileSync(path.join(ctxDir, "nested", "two.txt"), "ctx2");
    fs.writeFileSync(path.join(ctxDir, "skip.bin"), "binary");
    const entries = autoManifest(target, [ctxDir], { primaryName: "primary_document" });
    expect(entries[0]).toMatchObject({ name: "primary_document", tier: 1, critical: true });
    const contextNames = entries.slice(1).map((e) => e.name).sort();
    expect(contextNames).toEqual(["one", "two"]);
    expect(entries.every((e, i) => i === 0 || e.tier === 2)).toBe(true);
  });

  it("autoManifest dedupes name collisions", () => {
    const target = path.join(tmpDir, "doc.md");
    fs.writeFileSync(target, "p");
    const a = path.join(tmpDir, "ctx-a");
    const b = path.join(tmpDir, "ctx-b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, "notes.md"), "1");
    fs.writeFileSync(path.join(b, "notes.md"), "2");
    const entries = autoManifest(target, [a, b]);
    const names = entries.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// Parsers (test_parsers intent)
// ---------------------------------------------------------------------------

describe("parsers", () => {
  it("markdown parses with sha and counts", async () => {
    const p = path.join(tmpDir, "doc.md");
    fs.writeFileSync(p, "# Hello\n\nWorld.");
    const entries = autoManifest(p);
    const doc = await parseDocument(entries[0]!);
    expect(doc.content).toContain("Hello");
    expect(doc.charCount).toBe(doc.content.length);
    expect(doc.sha256).toHaveLength(64);
    expect(doc.truncated).toBe(false);
  });

  it("yaml parses to readable text", async () => {
    const p = path.join(tmpDir, "data.yaml");
    fs.writeFileSync(p, "key: value\nitems: [a, b]\n");
    const entries = autoManifest(p);
    const doc = await parseDocument(entries[0]!);
    expect(doc.content).toContain("key: value");
  });

  it("non-primary documents truncate at the cap with a marker", async () => {
    const p = path.join(tmpDir, "big.md");
    fs.writeFileSync(p, "x".repeat(MAX_CHARS + 100));
    const entries = autoManifest(path.join(tmpDir, "big.md"));
    entries[0]!.name = "context_doc"; // not the primary
    const doc = await parseDocument(entries[0]!, { primaryDocName: "primary_document" });
    expect(doc.truncated).toBe(true);
    expect(doc.content).toContain("TRUNCATED at 200,000");
  });

  it("the primary document must never be truncated — it fails loudly", async () => {
    const p = path.join(tmpDir, "big.md");
    fs.writeFileSync(p, "x".repeat(MAX_CHARS + 100));
    const entries = autoManifest(p, [], { primaryName: "primary_document" });
    await expect(
      parseDocument(entries[0]!, { primaryDocName: "primary_document" }),
    ).rejects.toThrow(PrimaryDocTooLargeError);
  });

  it("prepareDocuments skips broken non-primary docs with a warning", async () => {
    const target = path.join(tmpDir, "doc.md");
    fs.writeFileSync(target, "fine");
    const ctx = path.join(tmpDir, "ctx");
    fs.mkdirSync(ctx);
    fs.writeFileSync(path.join(ctx, "bad.pdf"), "not actually a pdf");
    const entries = autoManifest(target, [ctx]);
    const warnings: string[] = [];
    const documents = await prepareDocuments(entries, {
      onWarning: (m) => warnings.push(m),
    });
    expect(documents["primary_document"]).toBeDefined();
    expect(documents["bad"]).toBeUndefined();
    expect(warnings.join(" ")).toContain("bad");
  });
});

// ---------------------------------------------------------------------------
// Golden (test_golden intent + M6.5)
// ---------------------------------------------------------------------------

describe("golden harness", () => {
  function writeGolden(): string {
    const goldenDir = path.join(tmpDir, "golden");
    fs.mkdirSync(goldenDir, { recursive: true });
    fs.writeFileSync(
      path.join(goldenDir, "seeded.md"),
      "one two three four five six seven eight",
    );
    fs.writeFileSync(path.join(goldenDir, "clean.md"), "one two three");
    fs.writeFileSync(
      path.join(goldenDir, "manifest.yaml"),
      [
        "cases:",
        "  - id: overlength_case",
        "    path: seeded.md",
        "    defects:",
        "      - {id: too_long, detector: word_count, expect: words}",
        "      - {id: style, detector: llm_style_check, expect: cliché}",
        "  - id: clean_control",
        "    path: clean.md",
        "    negative_control: true",
      ].join("\n"),
    );
    return goldenDir;
  }

  it("catches seeded defects, skips llm detectors, clean control has no FPs", () => {
    const goldenDir = writeGolden();
    const cases = loadGoldenManifest(goldenDir);
    const outcomes = cases.map((c) => runMechanicalCase(c, goldenDir, PACK));
    const seeded = outcomes[0]!;
    expect(seeded.outcomes).toHaveLength(1);
    expect(seeded.outcomes[0]!.caught).toBe(true);
    expect(seeded.skippedLive).toBe(1);
    const control = outcomes[1]!;
    expect(control.falsePositives).toHaveLength(0);
    expect(goldenFailed(outcomes)).toBe(false);
    const report = formatGoldenReport(outcomes, false);
    expect(report).toContain("Recall: 1/1");
    expect(report).toContain("negative control");
  });

  it("a missed defect or unknown detector fails the run", () => {
    const goldenDir = writeGolden();
    fs.writeFileSync(
      path.join(goldenDir, "manifest.yaml"),
      [
        "cases:",
        "  - id: bad_detector",
        "    path: clean.md",
        "    defects:",
        "      - {id: x, detector: nonexistent_gate, expect: whatever}",
      ].join("\n"),
    );
    const cases = loadGoldenManifest(goldenDir);
    const outcomes = cases.map((c) => runMechanicalCase(c, goldenDir, PACK));
    expect(outcomes[0]!.outcomes[0]!.caught).toBe(false);
    expect(outcomes[0]!.outcomes[0]!.detail).toContain("not a pack gate");
    expect(goldenFailed(outcomes)).toBe(true);
  });

  it("negative-control false positives fail the run", () => {
    const goldenDir = writeGolden();
    fs.writeFileSync(
      path.join(goldenDir, "clean.md"),
      "way too many words for the five word limit here",
    );
    const cases = loadGoldenManifest(goldenDir);
    const outcomes = cases.map((c) => runMechanicalCase(c, goldenDir, PACK));
    expect(outcomes[1]!.falsePositives.length).toBeGreaterThan(0);
    expect(goldenFailed(outcomes)).toBe(true);
  });

  it("M6.5 discrimination: known-good must outscore known-bad", () => {
    const outcomes = [
      { caseId: "accepted", negativeControl: false, known: "good" as const, outcomes: [], falsePositives: [], skippedLive: 0, composite: 7.4 },
      { caseId: "rejected", negativeControl: false, known: "bad" as const, outcomes: [], falsePositives: [], skippedLive: 0, composite: 7.9 },
    ];
    const discrimination = evaluateDiscrimination(outcomes);
    expect(discrimination).toHaveLength(1);
    expect(discrimination[0]!.separated).toBe(false);
    expect(goldenFailed([], discrimination)).toBe(true);
    expect(formatGoldenReport(outcomes, true, discrimination)).toContain("NOT SEPARATED");
  });
});

// ---------------------------------------------------------------------------
// Ledger (test_ledger intent + M6.6)
// ---------------------------------------------------------------------------

describe("prediction ledger", () => {
  function writeRunDir(): string {
    const runDir = path.join(tmpDir, "doc-reviewed");
    fs.mkdirSync(path.join(runDir, "raw_reviews"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run_metadata.yaml"),
      `run_id: 20260812_010101\ntarget: /tmp/doc.md\nhashes:\n  primary_document: ${"a".repeat(64)}\n`,
    );
    const mk = (persona: string, verdict: string, score: number) => ({
      persona,
      model_id: "m",
      verdict,
      confidence: 0.5,
      findings: [],
      suspected_prompt_injection: [],
      validation_requests: [],
      unit_reviews: [
        { unit: "opening", clarity: score, verdict, weaknesses: [], rationale: "" },
      ],
    });
    fs.writeFileSync(
      path.join(runDir, "raw_reviews", "m_praiser_run1.json"),
      JSON.stringify(mk("praiser", "ship", 8)),
    );
    fs.writeFileSync(
      path.join(runDir, "raw_reviews", "m_praiser_run2.json"),
      JSON.stringify(mk("praiser", "revise", 7)),
    );
    fs.writeFileSync(
      path.join(runDir, "raw_reviews", "m_critic_run1.json"),
      JSON.stringify(mk("critic", "revise", 4)),
    );
    return runDir;
  }

  it("builds a row with modal per-persona verdicts and gate-identical composite", () => {
    const runDir = writeRunDir();
    const row = buildPredictionRow({ runDir, pack: PACK, hypothesis: "h" });
    expect(row.run_id).toBe("20260812_010101");
    expect(row.file_id).toContain("doc.md_aaaaaaaaaaaa");
    // Modal with first-seen tie-break: praiser saw ship then revise → ship.
    expect(row.per_persona_verdict).toEqual({ praiser: "ship", critic: "revise" });
    expect(row.composite).toBeCloseTo((8 + 7 + 4) / 3, 4);
  });

  it("freeze is write-once; outcome joins onto the frozen row", () => {
    const runDir = writeRunDir();
    const ledgerPath = path.join(tmpDir, "predictions.yaml");
    const row = buildPredictionRow({ runDir, pack: PACK });
    freezePrediction(row, ledgerPath);
    expect(() => freezePrediction(row, ledgerPath)).toThrow(LedgerFrozenError);

    const updated = recordOutcome({
      ledgerPath,
      runId: row.run_id,
      result: "accepted",
    });
    expect(updated.outcome).toHaveLength(1);
    expect(updated.composite).toBe(row.composite); // frozen fields untouched
    expect(() =>
      recordOutcome({ ledgerPath, runId: "nope", result: "x" }),
    ).toThrow(/No frozen prediction/);
  });

  it("perPersonaVerdicts modal counting", () => {
    const reviews = [
      { verdict: "ship" },
      { verdict: "ship" },
      { verdict: "revise" },
    ] as Record<string, unknown>[];
    expect(perPersonaVerdicts(reviews, ["a", "a", "a"], PACK)).toEqual({ a: "ship" });
  });
});

// ---------------------------------------------------------------------------
// Regressions (test_regressions intent)
// ---------------------------------------------------------------------------

describe("regression fuzzy matching", () => {
  const entry = (description: string, resolved = false): RegressionRegistry["entries"][number] => ({
    description,
    unit: "body",
    severity: "major",
    run_id: "r1",
    date: "2026-08-01",
    resolved,
    resolved_run_id: resolved ? "r2" : null,
    doc_sha256: "hash-v1",
  });

  it("fuzzy-matches reworded weaknesses (same unit) and flags reappearance", () => {
    const registry: RegressionRegistry = {
      entries: [entry("the body buries its strongest evidence in an aside near the end", true)],
    };
    const result = checkRegressions({
      synthesis: {
        consensus_weaknesses: [
          {
            description: "the body buries its strongest evidence in an aside near the end.",
            unit: "body",
            severity: "major",
          },
        ],
      },
      registry,
      runId: "r3",
      docSha256: "hash-v2",
    });
    expect(result.reappeared).toHaveLength(1);
    expect(result.newEntries).toHaveLength(0);
  });

  it("short descriptions require near-exact match (0.95)", () => {
    const registry: RegressionRegistry = { entries: [entry("weak hook")] };
    const result = checkRegressions({
      synthesis: {
        consensus_weaknesses: [
          { description: "weak close", unit: "body", severity: "minor" },
        ],
      },
      registry,
      runId: "r3",
      docSha256: "hash-v2",
    });
    expect(result.newEntries).toHaveLength(1); // NOT fuzzy-matched
  });

  it("different unit never matches", () => {
    const registry: RegressionRegistry = {
      entries: [entry("the body buries its strongest evidence in an aside near the end")],
    };
    const result = checkRegressions({
      synthesis: {
        consensus_weaknesses: [
          {
            description: "the body buries its strongest evidence in an aside near the end",
            unit: "close",
            severity: "major",
          },
        ],
      },
      registry,
      runId: "r3",
      docSha256: "hash-v2",
    });
    expect(result.newEntries).toHaveLength(1);
  });

  it("updateRegistry reopens reappeared entries and marks resolved", () => {
    const reg: RegressionRegistry = {
      entries: [entry("aaa long description of a weakness that is quite specific", true)],
    };
    const result = {
      reappeared: [reg.entries[0]!],
      newEntries: [entry("a brand new weakness description that was never seen before")],
      resolved: [],
    };
    const updated = updateRegistry({ registry: reg, result, runId: "r9" });
    expect(updated.entries[0]!.resolved).toBe(false);
    expect(updated.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Unit discovery (§5.2)
// ---------------------------------------------------------------------------

describe("unit discovery", () => {
  const doc =
    "CHAPTER ONE begins with a storm over the harbor town.\n" +
    "Lots of chapter one text here.\n" +
    "CHAPTER TWO opens in the capital, years later.\n" +
    "Chapter two content follows.\n" +
    "CHAPTER THREE returns to the harbor for the reckoning.\n" +
    "Final content.";

  const map: DocumentMap = {
    summary: "A three-chapter story.",
    units: [
      { name: "ch1", synopsis: "storm", start_quote: "CHAPTER ONE begins with a storm over the harbor town." },
      { name: "ch2", synopsis: "capital", start_quote: "CHAPTER TWO opens in the capital, years later." },
      { name: "ch3", synopsis: "reckoning", start_quote: "CHAPTER THREE returns to the harbor for the reckoning." },
    ],
  };

  it("splits at located boundaries, text never dropped", () => {
    const units = splitByMap(doc, map)!;
    expect(units).toHaveLength(3);
    expect(units[0]!.text).toContain("chapter one text");
    expect(units[2]!.text).toContain("Final content");
    expect(units.map((u) => u.text).join("")).toBe(doc);
  });

  it("unlocatable quotes merge into the previous unit; <2 boundaries → null", () => {
    const partial: DocumentMap = {
      summary: "s",
      units: [
        map.units[0]!,
        { name: "ghost", synopsis: "g", start_quote: "THIS QUOTE DOES NOT EXIST ANYWHERE" },
        map.units[2]!,
      ],
    };
    const units = splitByMap(doc, partial)!;
    expect(units).toHaveLength(2);
    expect(units[0]!.text).toContain("capital"); // ghost merged into ch1
    expect(splitByMap(doc, { summary: "s", units: [partial.units[1]!, partial.units[1]!] })).toBeNull();
  });

  it("mergeUnitReviews concatenates units and takes the worst verdict", () => {
    const merged = mergeUnitReviews(
      [
        {
          verdict: "ship",
          unit_reviews: [{ unit: "ch1", clarity: 8 }],
          findings: [{ description: "a", severity: 3 }],
          validation_requests: [],
          suspected_prompt_injection: [],
        },
        {
          verdict: "rethink",
          unit_reviews: [{ unit: "ch2", clarity: 3 }],
          findings: [{ description: "b", severity: 2 }],
          validation_requests: [{ claim: "c" }],
          suspected_prompt_injection: [],
        },
      ],
      {
        unitListField: "unit_reviews",
        verdictField: "verdict",
        verdictCategories: ["ship", "revise", "rethink"],
      },
    )!;
    expect((merged["unit_reviews"] as unknown[]).length).toBe(2);
    expect(merged["verdict"]).toBe("rethink");
    expect((merged["findings"] as unknown[]).length).toBe(2);
    expect((merged["validation_requests"] as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Run diff
// ---------------------------------------------------------------------------

describe("run diff", () => {
  it("reports new/resolved weaknesses and score deltas", () => {
    const mkRun = (name: string, score: number, weakness: string | null): string => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(path.join(dir, "raw_reviews"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "synthesis.json"),
        JSON.stringify({
          consensus_weaknesses: weakness
            ? [{ description: weakness, unit: "body", severity: "major", reviewer_count: 2, suggested_fix: "f" }]
            : [],
          ranked_fixes: [],
          held_out_validator_status: "not_yet_run",
        }),
      );
      fs.writeFileSync(
        path.join(dir, "raw_reviews", "m_p_run1.json"),
        JSON.stringify({
          persona: "p",
          model_id: "m",
          verdict: "revise",
          confidence: 0.5,
          findings: [],
          suspected_prompt_injection: [],
          validation_requests: [],
          unit_reviews: [
            { unit: "opening", clarity: score, verdict: "revise", weaknesses: [], rationale: "" },
          ],
        }),
      );
      return dir;
    };
    const a = mkRun("run-a", 4, "old weakness");
    const b = mkRun("run-b", 7, "new weakness");
    const diff = compareRuns({ runDirA: a, runDirB: b, pack: PACK });
    expect(diff.newWeaknesses).toEqual(["new weakness"]);
    expect(diff.resolvedWeaknesses).toEqual(["old weakness"]);
    expect(diff.scoreDeltas).toEqual([
      { unit: "opening", dimension: "clarity", scoreA: 4, scoreB: 7 },
    ]);
  });
});

describe("diff on a run with no structured synthesis", () => {
  it("explains the fallback instead of crashing on a missing file", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorable-fallback-run-"));
    try {
      fs.writeFileSync(
        path.join(runDir, "synthesis_report.md"),
        "# report\n\n## Synthesis (unstructured fallback)\n\nprose\n",
        "utf-8",
      );
      const call = () => compareRuns({ runDirA: runDir, runDirB: runDir, pack: PACK });
      expect(call).toThrow(/fell back to\s+unstructured markdown/);
      expect(call).toThrow(/synthesis_fallback: none/);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("keeps the plain message when the run simply has no synthesis at all", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorable-empty-run-"));
    try {
      expect(() =>
        compareRuns({ runDirA: runDir, runDirB: runDir, pack: PACK }),
      ).toThrow(/No synthesis\.json in/);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});
