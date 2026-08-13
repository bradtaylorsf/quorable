/**
 * Provider abstraction tests (M1): model-ref parsing, vendor independence
 * warnings, key resolution/capability checks. Ports the intent of the
 * Python test_client.py's non-network tests; HTTP behavior is covered via
 * validatedCall with fake clients in validation.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseModelRef,
  panelVendorWarnings,
  personaModelWarnings,
  vendorOf,
} from "../src/providers/types.js";
import {
  checkModelAvailability,
  keyForProvider,
  type ProviderSettings,
} from "../src/providers/registry.js";

describe("parseModelRef", () => {
  it("bare ids keep today's meaning (openrouter)", () => {
    const ref = parseModelRef("x-ai/grok-4.3");
    expect(ref.provider).toBe("openrouter");
    expect(ref.model).toBe("x-ai/grok-4.3");
  });

  it("provider-qualified ids parse", () => {
    expect(parseModelRef("anthropic:claude-sonnet-4-6")).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(parseModelRef("openai:gpt-5.4")).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(parseModelRef("local:llama-3.3-70b")).toMatchObject({
      provider: "openai_compatible",
      model: "llama-3.3-70b",
    });
    expect(parseModelRef("openai-compatible:qwen")).toMatchObject({
      provider: "openai_compatible",
      model: "qwen",
    });
  });

  it("unknown prefix falls back to openrouter with the whole spec as model", () => {
    const ref = parseModelRef("mistralai/mistral-large");
    expect(ref.provider).toBe("openrouter");
    expect(ref.model).toBe("mistralai/mistral-large");
  });
});

describe("vendorOf", () => {
  it("openrouter vendor is the path prefix", () => {
    expect(vendorOf(parseModelRef("anthropic/claude-sonnet-4.6"))).toBe("anthropic");
    expect(vendorOf(parseModelRef("x-ai/grok-4.3"))).toBe("x-ai");
  });
  it("direct providers are their own vendor", () => {
    expect(vendorOf(parseModelRef("anthropic:claude-sonnet-4-6"))).toBe("anthropic");
    expect(vendorOf(parseModelRef("openai:gpt-5.4"))).toBe("openai");
  });
  it("local endpoints share one vendor bucket", () => {
    expect(vendorOf(parseModelRef("local:llama-3.3-70b"))).toBe("local");
  });
});

describe("panelVendorWarnings (statistical honesty)", () => {
  it("warns on a single-vendor panel", () => {
    const warnings = panelVendorWarnings(
      ["anthropic/claude-sonnet-4.6", "anthropic:claude-opus-4-6"],
      null,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SINGLE-VENDOR PANEL");
  });

  it("cross-vendor panels do not warn", () => {
    expect(
      panelVendorWarnings(["anthropic/claude-sonnet-4.6", "openai/gpt-5.4"], null),
    ).toHaveLength(0);
  });

  it("warns when the held-out model shares a vendor with a reviewer", () => {
    const warnings = panelVendorWarnings(
      ["anthropic/claude-sonnet-4.6", "openai/gpt-5.4"],
      "anthropic:claude-opus-4-6",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("held-out");
    expect(warnings[0]).toContain("NOT meaningful");
  });

  it("three local variants are a single-vendor panel", () => {
    const warnings = panelVendorWarnings(
      ["local:llama-a", "local:llama-b", "local:llama-c"],
      null,
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("personaModelWarnings (picker guardrail §5.4)", () => {
  it("single-model persona has no agreement statistics", () => {
    const warnings = personaModelWarnings({ critic: ["openai/gpt-5.4"] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("just an opinion");
  });
  it("same-vendor pair warns", () => {
    const warnings = personaModelWarnings({
      critic: ["openai/gpt-5.4", "openai:gpt-5.5"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("vendor");
  });
  it("cross-vendor pair is clean", () => {
    expect(
      personaModelWarnings({ critic: ["openai/gpt-5.4", "anthropic/claude-sonnet-4.6"] }),
    ).toHaveLength(0);
  });
});

describe("key resolution + capability check", () => {
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const v of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const [v, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  });

  const settings = (keys: ProviderSettings["keys"]): ProviderSettings => ({
    keys,
    timeoutSeconds: 30,
    retryAttempts: 1,
  });

  it("process env always wins over stored keys", () => {
    process.env["OPENROUTER_API_KEY"] = "env-key";
    expect(keyForProvider("openrouter", { openrouter: "stored-key" })).toBe("env-key");
  });

  it("stored keys used when env is absent", () => {
    expect(keyForProvider("openrouter", { openrouter: "stored-key" })).toBe("stored-key");
  });

  it("flags models whose provider has no key, with substitution hint", () => {
    const problems = checkModelAvailability(
      ["anthropic:claude-sonnet-4-6", "x-ai/grok-4.3"],
      settings({ openrouter: "or-key" }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("anthropic:claude-sonnet-4-6");
    expect(problems[0]).toContain("ANTHROPIC_API_KEY");
    expect(problems[0]).toContain("openrouter");
  });

  it("openai-compatible models never require a key", () => {
    expect(checkModelAvailability(["local:llama-3.3-70b"], settings({}))).toHaveLength(0);
  });

  it("no keys at all points at the wizard", () => {
    const problems = checkModelAvailability(["x-ai/grok-4.3"], settings({}));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("quorable keys set");
  });
});
