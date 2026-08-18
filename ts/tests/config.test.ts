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
import {
  RIGOR_PRESETS,
  activeReviewers,
  endpointNames,
  localBackendWarnings,
  vendorOverrides,
} from "../src/config/schema.js";
import { checkModelAvailability } from "../src/providers/registry.js";
import {
  DEFAULT_PRICING,
  MODEL_PRICING,
  estimatePipelineCost,
  estimateTotalUsd,
  getPricing,
} from "../src/engine/costs.js";
import { panelVendorWarnings, parseModelRef, vendorOf } from "../src/providers/types.js";

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

// ---------------------------------------------------------------------------
// Named endpoints + per-project provider overrides
// ---------------------------------------------------------------------------

describe("named provider endpoints", () => {
  function writeProject(dir: string, yaml: string): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "quorable.yaml"), yaml, "utf-8");
    return dir;
  }

  it("a project config can define endpoints and route models through them", () => {
    const project = writeProject(
      path.join(tmpDir, "proj"),
      [
        "providers:",
        "  endpoints:",
        "    lmstudio:",
        "      base_url: http://localhost:1234/v1",
        "      vendor_from_model_id: true",
        "models:",
        "  reviewers:",
        "    - id: lmstudio:google/gemma-4-26b-a4b",
        "    - id: lmstudio:qwen/qwen3.5-9b",
        "",
      ].join("\n"),
    );
    const { config } = loadConfig({ home, projectDir: project, env: {} });
    expect(config.providers.endpoints["lmstudio"]?.base_url).toBe("http://localhost:1234/v1");
    expect(config.models.reviewers.map((r) => r.id)).toEqual([
      "lmstudio:google/gemma-4-26b-a4b",
      "lmstudio:qwen/qwen3.5-9b",
    ]);

    const res = { endpoints: endpointNames(config), vendors: vendorOverrides(config) };
    const ref = parseModelRef("lmstudio:google/gemma-4-26b-a4b", res);
    expect(ref.provider).toBe("openai_compatible");
    expect(ref.endpoint).toBe("lmstudio");
    expect(ref.model).toBe("google/gemma-4-26b-a4b");
    // vendor_from_model_id makes a multi-family local panel read as
    // genuinely cross-vendor rather than one "local" bucket.
    expect(vendorOf(ref, res)).toBe("google");
    expect(vendorOf(parseModelRef("lmstudio:qwen/qwen3.5-9b", res), res)).toBe("qwen");
  });

  it("a project layer overrides home endpoints and models", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      homePaths(home).config,
      [
        "providers:",
        "  endpoints:",
        "    lmstudio:",
        "      base_url: http://localhost:1234/v1",
        "models:",
        "  reviewers:",
        "    - id: lmstudio:openai/gpt-oss-20b",
        "",
      ].join("\n"),
      "utf-8",
    );
    const project = writeProject(
      path.join(tmpDir, "proj2"),
      [
        "providers:",
        "  endpoints:",
        "    lmstudio:",
        "      base_url: http://192.168.1.50:1234/v1",
        "",
      ].join("\n"),
    );
    const { config, sources } = loadConfig({ home, projectDir: project, env: {} });
    expect(sources.map((s) => s.layer)).toEqual(["defaults", "home", "project"]);
    // Project wins on the endpoint URL; home's model list still applies.
    expect(config.providers.endpoints["lmstudio"]?.base_url).toBe("http://192.168.1.50:1234/v1");
    expect(config.models.reviewers.map((r) => r.id)).toEqual(["lmstudio:openai/gpt-oss-20b"]);
  });

  it("local models default to one shared vendor bucket unless declared", () => {
    const project = writeProject(
      path.join(tmpDir, "proj3"),
      [
        "providers:",
        "  endpoints:",
        "    ollama:",
        "      base_url: http://localhost:11434/v1",
        "models:",
        "  reviewers:",
        "    - id: ollama:qwen2.5:latest",
        "    - id: ollama:llama3.3:70b",
        "",
      ].join("\n"),
    );
    const { config } = loadConfig({ home, projectDir: project, env: {} });
    const res = { endpoints: endpointNames(config), vendors: vendorOverrides(config) };
    // No vendor policy → conservative single bucket → single-vendor warning.
    expect(vendorOf(parseModelRef("ollama:qwen2.5:latest", res), res)).toBe("local");
    const warnings = panelVendorWarnings(
      config.models.reviewers.map((r) => r.id),
      null,
      res,
    );
    expect(warnings.some((w) => w.includes("SINGLE-VENDOR PANEL"))).toBe(true);
  });

  it("a per-model vendor declaration overrides the endpoint policy", () => {
    const project = writeProject(
      path.join(tmpDir, "proj4"),
      [
        "providers:",
        "  endpoints:",
        "    ollama:",
        "      base_url: http://localhost:11434/v1",
        "models:",
        "  reviewers:",
        "    - id: ollama:qwen2.5:latest",
        "      vendor: qwen",
        "    - id: ollama:llama3.3:70b",
        "      vendor: meta",
        "",
      ].join("\n"),
    );
    const { config } = loadConfig({ home, projectDir: project, env: {} });
    const res = { endpoints: endpointNames(config), vendors: vendorOverrides(config) };
    expect(vendorOf(parseModelRef("ollama:qwen2.5:latest", res), res)).toBe("qwen");
    expect(
      panelVendorWarnings(config.models.reviewers.map((r) => r.id), null, res),
    ).toEqual([]);
  });

  it("an unknown model prefix fails loudly instead of becoming an OpenRouter call", () => {
    expect(() => parseModelRef("lmstudo:google/gemma-4-26b-a4b", { endpoints: ["lmstudio"] }))
      .toThrow(/unknown provider or endpoint 'lmstudo'/i);
    // OpenRouter variant suffixes carry a '/' before the colon and still parse.
    expect(parseModelRef("meta-llama/llama-3.3-70b-instruct:free")).toMatchObject({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct:free",
    });
  });

  it("an endpoint declaring api_key_env is reported when the var is unset", () => {
    delete process.env["TEST_TOGETHER_KEY"];
    const settings = {
      keys: {},
      endpoints: {
        together: {
          base_url: "https://api.together.xyz/v1",
          api_key_env: "TEST_TOGETHER_KEY",
          api_key: null,
          json_mode: false,
          vendor: null,
          vendor_from_model_id: true,
        },
        ollama: {
          base_url: "http://localhost:11434/v1",
          api_key_env: null,
          api_key: null,
          json_mode: false,
          vendor: null,
          vendor_from_model_id: false,
        },
      },
      timeoutSeconds: 60,
      retryAttempts: 0,
      home,
    };
    const problems = checkModelAvailability(
      ["together:meta-llama/Llama-3.3-70B", "ollama:qwen2.5:latest"],
      settings,
    );
    // The keyless local endpoint is fine; the one that declared a var is not.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("TEST_TOGETHER_KEY");
  });
});

describe("config precedence escapes", () => {
  it("QUORABLE_MODELS replaces the reviewer panel for one run", () => {
    const { config } = loadConfig({
      home,
      env: { QUORABLE_MODELS: "lmstudio:a, lmstudio:b" } as NodeJS.ProcessEnv,
    });
    expect(config.models.reviewers.map((r) => r.id)).toEqual(["lmstudio:a", "lmstudio:b"]);
  });

  it("an explicit config path bypasses discovery", () => {
    const explicit = path.join(tmpDir, "elsewhere.yaml");
    fs.writeFileSync(explicit, "rigor: quick\n", "utf-8");
    const project = path.join(tmpDir, "proj5");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "quorable.yaml"), "rigor: rigorous\n", "utf-8");
    const { config, sources } = loadConfig({
      home,
      projectDir: project,
      configPath: explicit,
      env: {},
    });
    expect(config.rigor).toBe("quick");
    expect(sources.find((s) => s.layer === "project")?.path).toBe(explicit);
  });

  it("falls back to the cwd when the document's tree has no project config", () => {
    const project = path.join(tmpDir, "cwd-proj");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "quorable.yaml"), "rigor: quick\n", "utf-8");
    const lonelyDoc = path.join(tmpDir, "no-config-here");
    fs.mkdirSync(lonelyDoc, { recursive: true });
    const { config } = loadConfig({
      home,
      projectDir: lonelyDoc,
      fallbackDir: project,
      env: {},
    });
    expect(config.rigor).toBe("quick");
  });
});

describe("local models cost nothing to estimate", () => {
  it("prices endpoint-qualified and local: specs at zero", () => {
    expect(getPricing("lmstudio:google/gemma-4-26b-a4b", ["lmstudio"])).toEqual([0, 0]);
    expect(getPricing("local:llama-3.3-70b")).toEqual([0, 0]);
    // Hosted models keep their real price, qualified or not.
    expect(getPricing("x-ai/grok-4.3")).toEqual(MODEL_PRICING["x-ai/grok-4.3"]);
    expect(getPricing("openrouter:x-ai/grok-4.3")).toEqual(MODEL_PRICING["x-ai/grok-4.3"]);
    // An unknown hosted id still falls back to the default, not to free.
    expect(getPricing("some-vendor/unknown-model")).toEqual(DEFAULT_PRICING);
  });

  it("a full local panel estimates at $0.00", () => {
    const estimate = estimatePipelineCost({
      reviewerIds: ["lmstudio:google/gemma-4-26b-a4b", "lmstudio:qwen/qwen3.5-9b"],
      synthesizerId: "lmstudio:google/gemma-4-26b-a4b",
      drafterId: null,
      runsPerPersona: 2,
      personas: ["skeptical_expert", "clarity_editor"],
      personaDocChars: () => [20_000],
      allDocChars: [20_000],
      systemPromptChars: 4000,
      personaOverlayChars: { skeptical_expert: 1200, clarity_editor: 1100 },
      includeDrafter: false,
      iterations: 1,
      endpoints: ["lmstudio"],
    });
    expect(estimateTotalUsd(estimate)).toBe(0);
    // The call COUNT is still real — free does not mean unmetered.
    expect(estimate.modelEstimates.reduce((a, m) => a + m.numCalls, 0)).toBeGreaterThan(0);
  });
});

describe("pipeline.synthesis_fallback", () => {
  it("defaults to none — today's behaviour is the default", () => {
    const { config } = loadConfig({ home, env: {} });
    expect(config.pipeline.synthesis_fallback).toBe("none");
  });

  it("rejects anything but none|markdown", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      homePaths(home).config,
      "pipeline:\n  synthesis_fallback: sometimes\n",
      "utf-8",
    );
    expect(() => loadConfig({ home, env: {} })).toThrow(/synthesis_fallback/);
  });

  it("layers packaged -> home -> project", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      homePaths(home).config,
      "pipeline:\n  synthesis_fallback: markdown\n",
      "utf-8",
    );
    // Home turns it on globally...
    expect(loadConfig({ home, env: {} }).config.pipeline.synthesis_fallback).toBe("markdown");

    // ...and a project can turn it back off where structured output matters.
    const project = path.join(tmpDir, "strict");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "quorable.yaml"),
      "pipeline:\n  synthesis_fallback: none\n",
      "utf-8",
    );
    const { config, sources } = loadConfig({ home, projectDir: project, env: {} });
    expect(config.pipeline.synthesis_fallback).toBe("none");
    expect(sources.map((s) => s.layer)).toEqual(["defaults", "home", "project"]);
    // Sibling pipeline values still merge rather than being replaced.
    expect(config.pipeline.runs_per_persona).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Profiles: a job picks ONE backend rather than straddling two local servers.
// ---------------------------------------------------------------------------

const TWO_BACKENDS = [
  "profiles:",
  "  lmstudio:",
  "    providers:",
  "      endpoints:",
  "        lmstudio:",
  "          base_url: http://localhost:1234/v1",
  "          vendor_from_model_id: true",
  "    models:",
  "      reviewers:",
  "        - id: lmstudio:google/gemma-4-26b",
  "        - id: lmstudio:qwen/qwen3.5-9b",
  "      synthesizer:",
  "        id: lmstudio:google/gemma-4-26b",
  "  ollama:",
  "    providers:",
  "      endpoints:",
  "        ollama:",
  "          base_url: http://localhost:11434/v1",
  "    models:",
  "      reviewers:",
  "        - id: ollama:qwen2.5:latest",
  "      synthesizer:",
  "        id: ollama:qwen2.5:latest",
  "",
].join("\n");

function writeHome(body: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(homePaths(home).config, body, "utf-8");
}

describe("config profiles", () => {
  it("the selected profile supplies the panel; the other is inert", () => {
    writeHome(TWO_BACKENDS + "profile: lmstudio\n");
    const { config } = loadConfig({ home, env: {} });
    expect(config.profile).toBe("lmstudio");
    expect(config.models.reviewers.map((r) => r.id)).toEqual([
      "lmstudio:google/gemma-4-26b",
      "lmstudio:qwen/qwen3.5-9b",
    ]);
    // Only the active backend's endpoint is reachable, so a stray ollama:
    // id cannot silently resolve while lmstudio is the active job backend.
    expect(endpointNames(config)).toEqual(["lmstudio"]);
  });

  it("switching the profile switches the whole backend in one line", () => {
    writeHome(TWO_BACKENDS + "profile: ollama\n");
    const { config } = loadConfig({ home, env: {} });
    expect(config.models.reviewers.map((r) => r.id)).toEqual(["ollama:qwen2.5:latest"]);
    expect(config.models.synthesizer.id).toBe("ollama:qwen2.5:latest");
    expect(endpointNames(config)).toEqual(["ollama"]);
  });

  it("a project selects its own profile without touching global defaults", () => {
    writeHome(TWO_BACKENDS + "profile: lmstudio\n");
    const project = path.join(tmpDir, "fast-job");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "quorable.yaml"), "profile: ollama\n", "utf-8");

    const scoped = loadConfig({ home, projectDir: project, env: {} });
    expect(scoped.config.models.reviewers.map((r) => r.id)).toEqual(["ollama:qwen2.5:latest"]);
    // The home default is untouched for everything else.
    expect(loadConfig({ home, env: {} }).config.models.reviewers).toHaveLength(2);
  });

  it("env and flags can select a profile too, flags winning", () => {
    writeHome(TWO_BACKENDS + "profile: lmstudio\n");
    expect(
      loadConfig({ home, env: { QUORABLE_PROFILE: "ollama" } as NodeJS.ProcessEnv }).config
        .models.reviewers.map((r) => r.id),
    ).toEqual(["ollama:qwen2.5:latest"]);

    const { config } = loadConfig({
      home,
      env: { QUORABLE_PROFILE: "ollama" } as NodeJS.ProcessEnv,
      flags: { profile: "lmstudio" },
    });
    expect(config.models.reviewers).toHaveLength(2);
  });

  it("a layer's own keys beat the profile it selected", () => {
    writeHome(TWO_BACKENDS + "profile: lmstudio\nrigor: quick\n");
    const project = path.join(tmpDir, "override");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "quorable.yaml"),
      "profile: ollama\nmodels:\n  synthesizer:\n    id: ollama:something-else\n",
      "utf-8",
    );
    const { config } = loadConfig({ home, projectDir: project, env: {} });
    // Profile supplied the reviewers; the project's explicit key won on the
    // synthesizer.
    expect(config.models.reviewers.map((r) => r.id)).toEqual(["ollama:qwen2.5:latest"]);
    expect(config.models.synthesizer.id).toBe("ollama:something-else");
  });

  it("an unknown profile name fails loudly and lists the real ones", () => {
    writeHome(TWO_BACKENDS + "profile: lmstduio\n");
    expect(() => loadConfig({ home, env: {} })).toThrow(
      /selects profile 'lmstduio'.*Known profiles: lmstudio, ollama/s,
    );
  });
});

describe("two local backends in one run", () => {
  it("warns when models straddle two localhost endpoints", () => {
    writeHome(
      [
        "providers:",
        "  endpoints:",
        "    lmstudio: {base_url: 'http://localhost:1234/v1'}",
        "    ollama: {base_url: 'http://localhost:11434/v1'}",
        "models:",
        "  reviewers:",
        "    - id: lmstudio:google/gemma-4-26b",
        "    - id: ollama:qwen2.5:latest",
        "  synthesizer: {id: lmstudio:google/gemma-4-26b}",
        "",
      ].join("\n"),
    );
    const { config } = loadConfig({ home, env: {} });
    const warnings = localBackendWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TWO LOCAL BACKENDS");
    expect(warnings[0]).toContain("lmstudio and ollama");
  });

  it("stays silent for one local backend, or for several remote ones", () => {
    writeHome(
      [
        "providers:",
        "  endpoints:",
        "    lmstudio: {base_url: 'http://localhost:1234/v1'}",
        "    together: {base_url: 'https://api.together.xyz/v1'}",
        "    groq: {base_url: 'https://api.groq.com/openai/v1'}",
        "models:",
        "  reviewers:",
        "    - id: lmstudio:google/gemma-4-26b",
        "    - id: together:meta-llama/Llama-3.3-70B",
        "    - id: groq:llama-3.3-70b-versatile",
        "  synthesizer: {id: lmstudio:google/gemma-4-26b}",
        "",
      ].join("\n"),
    );
    const { config } = loadConfig({ home, env: {} });
    expect(localBackendWarnings(config)).toEqual([]);
  });
});
