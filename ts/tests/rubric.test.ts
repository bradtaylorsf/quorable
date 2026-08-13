/**
 * M3 — the generic pack: rubric YAML → working Pack with generated zod
 * schemas. Ports the intent of Python test_pack.py (validation with clear,
 * complete error lists) onto the no-code path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPackFromRubric,
  parseRubric,
} from "../src/pack/rubric.js";
import { PackError } from "../src/pack/types.js";
import { runGates } from "../src/engine/gates.js";
import { computeAgreement } from "../src/engine/agreement.js";
import { checkShipGates } from "../src/engine/scoring.js";
import {
  listCouncils,
  listPersonas,
  listRubrics,
  loadCouncil,
  loadPersonaOverlay,
  loadPackagedPrompt,
  rubricPath,
} from "../src/config/resolve.js";
import { loadRubricFile } from "../src/pack/rubric.js";

const BLOG_RUBRIC = `
name: blog-post
units: [hook, argument, evidence, structure, close]
dimensions:
  clarity:      {weight: 1.0, scale: [1, 10]}
  originality:  {weight: 1.5, scale: [1, 10]}
  evidence:     {weight: 2.0, scale: [1, 10]}
verdict:
  field: publish_readiness
  categories: [ship, revise, rethink]
gates:
  - word_count: {max: 2000}
  - banned_elements: ["as an AI", "in today's fast-paced"]
ship:
  composite_min: 7.0
  dimension_min: 5
  blocking: severity_1_findings
  composite_exclude_personas: [red_team]
`;

describe("rubric → pack (the keystone)", () => {
  it("the plan's example rubric builds a working pack", () => {
    const pack = buildPackFromRubric(parseRubric(BLOG_RUBRIC));
    expect(pack.name).toBe("blog-post");
    expect(pack.scoreDimensions).toEqual(["clarity", "originality", "evidence"]);
    expect(pack.verdictField).toBe("publish_readiness");
    expect(pack.canonicalUnits).toEqual(["hook", "argument", "evidence", "structure", "close"]);
    expect(pack.mechanicalGates.map((g) => g.name)).toEqual(["word_count", "banned_elements"]);
    expect(pack.shipGates.weights).toEqual({ clarity: 1.0, originality: 1.5, evidence: 2.0 });
  });

  it("generated review schema validates conforming output", () => {
    const pack = buildPackFromRubric(parseRubric(BLOG_RUBRIC));
    const review = {
      persona: "hook_doctor",
      model_id: "openai/gpt-5.4",
      publish_readiness: "revise",
      unit_reviews: [
        {
          unit: "hook",
          clarity: 8,
          originality: 6,
          evidence: 5,
          publish_readiness: "revise",
        },
      ],
      findings: [{ description: "weak open", severity: 3 }],
    };
    const parsed = pack.reviewSchema.safeParse(review);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Defaults fill in.
      expect(parsed.data["confidence"]).toBe(0.5);
      expect(parsed.data["validation_requests"]).toEqual([]);
      const unit = (parsed.data["unit_reviews"] as Record<string, unknown>[])[0]!;
      expect(unit["weaknesses"]).toEqual([]);
    }
  });

  it("generated schema rejects out-of-scale scores and unknown verdicts", () => {
    const pack = buildPackFromRubric(parseRubric(BLOG_RUBRIC));
    const bad = {
      publish_readiness: "yolo",
      unit_reviews: [{ unit: "hook", clarity: 11, originality: 6, evidence: 5, publish_readiness: "ship" }],
    };
    expect(pack.reviewSchema.safeParse(bad).success).toBe(false);
  });

  it("the whole engine runs off a generic pack: gates + agreement + ship", () => {
    const pack = buildPackFromRubric(parseRubric(BLOG_RUBRIC));
    const mkReview = (persona: string, score: number, verdict: string) => ({
      persona,
      model_id: "m",
      publish_readiness: verdict,
      confidence: 0.8,
      findings: [],
      suspected_prompt_injection: [],
      validation_requests: [],
      unit_reviews: pack.canonicalUnits.map((u) => ({
        unit: u,
        clarity: score,
        originality: score,
        evidence: score,
        publish_readiness: verdict,
        weaknesses: [],
        rationale: "",
      })),
    });
    const reviews = [
      mkReview("hook_doctor", 8, "ship"),
      mkReview("skeptical_expert", 7, "ship"),
      mkReview("red_team", 2, "rethink"),
    ];
    const personas = ["hook_doctor", "skeptical_expert", "red_team"];

    const gateResults = runGates(pack.mechanicalGates, "Short and clean document.");
    const agreement = computeAgreement(reviews, pack, personas);
    expect(agreement["fleiss_kappa_verdict"]).toBeDefined();

    const check = checkShipGates({
      synthesis: { consensus_weaknesses: [], ranked_fixes: [] },
      reviews,
      gateResults,
      pack,
      personas,
    });
    // red_team excluded from composite: mean of 8 and 7 = 7.5 >= 7.0 → ships.
    expect(check.composite).toBeCloseTo(7.5, 6);
    expect(check.ok).toBe(true);
  });

  it("a severity-1 finding in a raw review blocks even when synthesis drops it", () => {
    const pack = buildPackFromRubric(parseRubric(BLOG_RUBRIC));
    const good = {
      persona: "hook_doctor",
      publish_readiness: "ship",
      unit_reviews: pack.canonicalUnits.map((u) => ({
        unit: u, clarity: 9, originality: 9, evidence: 9, publish_readiness: "ship",
      })),
      findings: [{ description: "fabricated statistic in evidence section", severity: 1 }],
    };
    const check = checkShipGates({
      synthesis: { consensus_weaknesses: [], ranked_fixes: [] }, // synthesis dropped it
      reviews: [good, { ...good, findings: [] }],
      gateResults: {},
      pack,
      personas: ["hook_doctor", "skeptical_expert"],
    });
    expect(check.ok).toBe(false);
    expect(check.reasons.join(" ")).toContain("fabricated statistic");
  });

  it("invalid rubrics fail with a complete problem list", () => {
    expect(() => parseRubric("name: x\n")).toThrow(PackError);
    expect(() =>
      parseRubric(
        "name: x\nunits: [a]\ndimensions:\n  d: {}\nverdict: {field: v, categories: [one]}\nship: {composite_min: 1, dimension_min: 1}\n",
      ),
    ).toThrow(/categories/);
    expect(() =>
      parseRubric(
        "name: x\nunits: [a]\ndimensions:\n  d: {}\nverdict: {field: v, categories: [one, two]}\nship: {composite_min: 1, dimension_min: 1, blocking: no_such_builtin}\n",
      ),
    ).toThrow(/unknown built-in/);
  });
});

describe("packaged assets (M7 starter library)", () => {
  it("ships the four starter councils plus general-doc", () => {
    const councils = listCouncils({ home: "/nonexistent-home" });
    for (const name of ["general-doc", "blog-post", "grant-proposal", "screenplay", "legal-pleading"]) {
      expect(councils).toContain(name);
    }
  });

  it("every packaged council loads, resolves personas, and its rubric builds a pack", () => {
    const roots = { home: "/nonexistent-home" };
    for (const name of listCouncils(roots)) {
      const council = loadCouncil(name, roots);
      expect(council.personas.length).toBeGreaterThanOrEqual(3);
      for (const persona of council.personas) {
        const overlay = loadPersonaOverlay(persona, roots);
        expect(overlay.length).toBeGreaterThan(200);
      }
      const rp = rubricPath(council.rubric, roots);
      expect(rp, `rubric ${council.rubric} for council ${name}`).not.toBeNull();
      const pack = buildPackFromRubric(loadRubricFile(rp!));
      expect(pack.scoreDimensions.length).toBeGreaterThanOrEqual(3);
      // Red-team exclusion is wired in every starter rubric.
      expect(pack.shipGates.compositeExcludePersonas).toContain("red_team");
    }
  });

  it("red_team persona carries the house rule", () => {
    const overlay = loadPersonaOverlay("red_team", { home: "/nonexistent-home" });
    expect(overlay).toContain("cite a location");
    expect(overlay).toContain("neutralize");
  });

  it("home library overrides packaged assets", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "quorable-assets-"));
    try {
      fs.mkdirSync(path.join(tmpHome, "personas"), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, "personas", "red_team.md"), "# Custom red team\n");
      expect(loadPersonaOverlay("red_team", { home: tmpHome })).toContain("Custom red team");
      expect(listPersonas({ home: tmpHome })).toContain("clarity_editor");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("packaged prompts exist (system, synthesis, cold reader)", () => {
    expect(loadPackagedPrompt("system_prompt")).toContain("validation_requests");
    expect(loadPackagedPrompt("synthesis")).toContain("Contested issues");
    expect(loadPackagedPrompt("cold_reader")).toContain("intended reader");
  });

  it("packaged rubrics all parse", () => {
    for (const name of listRubrics({ home: "/nonexistent-home" })) {
      const rp = rubricPath(name, { home: "/nonexistent-home" })!;
      expect(() => loadRubricFile(rp)).not.toThrow();
    }
  });
});
