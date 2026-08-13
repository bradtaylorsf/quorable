/**
 * M2: config layering (defaults → home → project → env → flags), key
 * storage in ~/.quorable/.env with 600 perms, rigor presets. Ports the
 * intent of Python test_config.py and extends it to the layered model.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, deepMerge, findProjectConfig } from "../src/config/layering.js";
import {
  effectiveKeys,
  homePaths,
  loadStoredKeys,
  maskKey,
  storeKey,
} from "../src/config/home.js";
import { RIGOR_PRESETS, activeReviewers } from "../src/config/schema.js";

let tmpDir: string;
let home: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorable-test-"));
  home = path.join(tmpDir, "home");
  delete process.env["QUORABLE_COUNCIL"];
  delete process.env["QUORABLE_RIGOR"];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["QUORABLE_COUNCIL"];
  delete process.env["QUORABLE_RIGOR"];
});

describe("config layering", () => {
  it("packaged defaults alone produce a valid cross-vendor config", () => {
    const { config, sources } = loadConfig({ home, env: {} });
    expect(sources.map((s) => s.layer)).toEqual(["defaults"]);
    expect(config.models.reviewers.length).toBeGreaterThanOrEqual(2);
    expect(config.rigor).toBe("standard");
    expect(config.council).toBe("general-doc");
    // Held-out must be cross-vendor against every default reviewer.
    const heldOutVendor = config.models.held_out.id.split("/")[0];
    for (const r of config.models.reviewers) {
      expect(r.id.split("/")[0]).not.toBe(heldOutVendor);
    }
  });

  it("home config overrides defaults; project overrides home; env overrides project; flags win", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(homePaths(home).config, "council: blog-post\nrigor: quick\n");
    const project = path.join(tmpDir, "proj", "sub");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "proj", "quorable.yaml"), "rigor: rigorous\n");

    let result = loadConfig({ home, projectDir: project, env: {} });
    expect(result.config.council).toBe("blog-post"); // from home
    expect(result.config.rigor).toBe("rigorous"); // project beats home

    result = loadConfig({
      home,
      projectDir: project,
      env: { QUORABLE_RIGOR: "standard" } as NodeJS.ProcessEnv,
    });
    expect(result.config.rigor).toBe("standard"); // env beats project

    result = loadConfig({
      home,
      projectDir: project,
      env: { QUORABLE_RIGOR: "standard" } as NodeJS.ProcessEnv,
      flags: { rigor: "quick" },
    });
    expect(result.config.rigor).toBe("quick"); // flags beat env
    expect(result.sources.map((s) => s.layer)).toEqual([
      "defaults",
      "home",
      "project",
      "env",
      "flags",
    ]);
  });

  it("project config is found walking up from a nested dir", () => {
    const projRoot = path.join(tmpDir, "repo");
    const deep = path.join(projRoot, "docs", "drafts");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(projRoot, ".quorable.yaml"), "council: screenplay\n");
    expect(findProjectConfig(deep)).toBe(path.join(projRoot, ".quorable.yaml"));
    const { config } = loadConfig({ home, projectDir: deep, env: {} });
    expect(config.council).toBe("screenplay");
  });

  it("model overrides replace the whole reviewer list (arrays replace)", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      homePaths(home).config,
      [
        "models:",
        "  reviewers:",
        "    - id: openai/gpt-5.4",
        "    - id: anthropic:claude-sonnet-4-6",
      ].join("\n"),
    );
    const { config } = loadConfig({ home, env: {} });
    expect(config.models.reviewers.map((r) => r.id)).toEqual([
      "openai/gpt-5.4",
      "anthropic:claude-sonnet-4-6",
    ]);
    // Unspecified roles still come from defaults.
    expect(config.models.held_out.id).toBe("x-ai/grok-4.3");
  });

  it("invalid rigor env fails loudly", () => {
    expect(() =>
      loadConfig({ home, env: { QUORABLE_RIGOR: "extreme" } as NodeJS.ProcessEnv }),
    ).toThrow(/QUORABLE_RIGOR/);
  });

  it("held_out reviewers are filtered by activeReviewers", () => {
    const { config } = loadConfig({
      home,
      env: {},
      flags: {
        models: {
          reviewers: [
            { id: "a/one" },
            { id: "b/two", held_out: true },
          ],
          synthesizer: { id: "a/one" },
          held_out: { id: "c/three" },
        },
      },
    });
    expect(activeReviewers(config).map((r) => r.id)).toEqual(["a/one"]);
  });

  it("deepMerge: objects merge, scalars/arrays replace", () => {
    expect(
      deepMerge(
        { a: { x: 1, y: 2 }, list: [1, 2], keep: "k" },
        { a: { y: 3 }, list: [9] },
      ),
    ).toEqual({ a: { x: 1, y: 3 }, list: [9], keep: "k" });
  });
});

describe("key storage (~/.quorable/.env)", () => {
  it("stores with 600 perms and loads back", () => {
    const envPath = storeKey("openrouter", "sk-or-secret123", home);
    const mode = fs.statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadStoredKeys(home)).toEqual({ openrouter: "sk-or-secret123" });
  });

  it("multiple providers coexist; updates overwrite", () => {
    storeKey("openrouter", "or-1", home);
    storeKey("anthropic", "an-1", home);
    storeKey("openrouter", "or-2", home);
    expect(loadStoredKeys(home)).toEqual({ openrouter: "or-2", anthropic: "an-1" });
  });

  it("process env wins over stored keys", () => {
    storeKey("openrouter", "stored", home);
    process.env["OPENROUTER_API_KEY"] = "from-env";
    try {
      expect(effectiveKeys(home).openrouter).toBe("from-env");
    } finally {
      delete process.env["OPENROUTER_API_KEY"];
    }
  });

  it("maskKey never reveals the middle", () => {
    expect(maskKey("sk-or-v1-abcdefghijklmnop")).toBe("sk-o…mnop");
    expect(maskKey("short")).toBe("*****");
  });
});

describe("rigor presets (M5)", () => {
  it("quick: 1 run, top-3 personas, no stats, no held-out", () => {
    const quick = RIGOR_PRESETS.quick;
    expect(quick.runsPerPersona).toBe(1);
    expect(quick.personaLimit).toBe(3);
    expect(quick.agreementStats).toBe(false);
    expect(quick.heldOut).toBe(false);
  });
  it("standard: 2 runs, full council, stats + regressions on", () => {
    const std = RIGOR_PRESETS.standard;
    expect(std.runsPerPersona).toBe(2);
    expect(std.personaLimit).toBeNull();
    expect(std.agreementStats).toBe(true);
    expect(std.regressions).toBe(true);
    expect(std.heldOut).toBe(false);
  });
  it("rigorous: held-out + golden + validation-task blocking on", () => {
    const rig = RIGOR_PRESETS.rigorous;
    expect(rig.heldOut).toBe(true);
    expect(rig.goldenPreRun).toBe(true);
    expect(rig.validationTasksBlock).toBe(true);
  });
});
