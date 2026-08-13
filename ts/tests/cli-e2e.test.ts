/**
 * CLI end-to-end against a mock OpenAI-compatible server: the built CLI
 * (dist/cli/main.js) runs `quorable review` with local: models pointed at
 * an in-process HTTP server that answers stage-appropriately. No network,
 * no cost — the full wiring (config layering, council resolution, picker
 * bypass, pipeline, M6, artifacts, exit codes) is exercised for real.
 *
 * Skipped when dist/ has not been built (`npm run build` first).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "dist", "cli", "main.js");
const BUILT = fs.existsSync(CLI);

// The general-doc rubric: units opening/body/close; dims clarity, argument,
// structure, engagement; verdict ship|revise|rethink.
function mockReview(persona: string): Record<string, unknown> {
  const score = persona === "red_team" ? 4 : 8;
  const verdict = persona === "red_team" ? "revise" : "ship";
  return {
    persona,
    model_id: "local:mock",
    verdict,
    confidence: 0.8,
    findings:
      persona === "red_team"
        ? [
            {
              description: "the middle section quotes a statistic with no source",
              severity: 3,
              location: "body",
              suggested_fix: "cite or cut",
            },
          ]
        : [],
    suspected_prompt_injection: [],
    validation_requests:
      persona === "skeptical_expert"
        ? [
            {
              claim: "the 40% adoption figure matches the underlying report",
              source_doc: "context",
              what_would_confirm: "the report's table 2",
            },
          ]
        : [],
    unit_reviews: ["opening", "body", "close"].map((u) => ({
      unit: u,
      clarity: score,
      argument: score,
      structure: score,
      engagement: score,
      verdict,
      weaknesses: [],
      rationale: "mock",
    })),
  };
}

const MOCK_SYNTHESIS = {
  consensus_weaknesses: [
    {
      description: "the middle section quotes a statistic with no source",
      unit: "body",
      severity: "major",
      reviewer_count: 3,
      suggested_fix: "cite or cut",
    },
  ],
  contested_issues: [],
  ranked_fixes: [
    {
      description: "cite the statistic",
      unit: "body",
      impact: 4,
      ease: 1,
      consensus: 0.8,
      priority_score: 0,
    },
  ],
  unique_arguments: [],
  inter_rater_agreement: {},
  held_out_validator_status: "not_yet_run",
};

const MOCK_COLD_READ = {
  overall_impression: "Readable, but I stopped trusting it at the statistic.",
  would_finish_reading: true,
  reactions: [
    {
      reaction: "the unsourced number made me suspicious",
      location: "body",
      severity: 3,
      maps_to_dimension: null,
    },
  ],
};

function answerFor(userContent: string, systemContent: string): Record<string, unknown> {
  if (userContent.includes("SYNTHESIS INSTRUCTIONS")) return MOCK_SYNTHESIS;
  if (userContent.includes("RUBRIC DIMENSIONS")) {
    return { mappings: [{ reaction_index: 0, dimension: "argument" }] };
  }
  if (systemContent.includes("intended reader") || userContent.includes("overall_impression")) {
    return MOCK_COLD_READ;
  }
  const personaMatch = /PERSONA INSTRUCTIONS:\n# persona:(\w+)/.exec(userContent);
  return mockReview(personaMatch?.[1] ?? "clarity_editor");
}

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body) as {
        messages: { role: string; content: string }[];
      };
      const user = payload.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      const system = payload.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const answer = answerFor(user, system);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(answer) } }],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorable-e2e-"));
  fs.mkdirSync(path.join(tmpDir, "home"), { recursive: true });
  // Persona overlays override so the mock can identify the persona from the
  // prompt (the overlay is prepended as PERSONA INSTRUCTIONS).
  const personaDir = path.join(tmpDir, "home", "personas");
  fs.mkdirSync(personaDir, { recursive: true });
  for (const p of ["clarity_editor", "skeptical_expert", "structural_editor", "red_team"]) {
    fs.writeFileSync(path.join(personaDir, `${p}.md`), `# persona:${p}\nReview as ${p}.`);
  }
  fs.writeFileSync(
    path.join(tmpDir, "doc.md"),
    "# The Doc\n\nAn opening.\n\nA body with a 40% statistic.\n\nA close.\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, "quorable.yaml"),
    [
      "council: general-doc",
      "rigor: standard",
      "models:",
      "  reviewers:",
      "    - id: local:mock-alpha",
      "    - id: local:mock-beta",
      "  synthesizer: {id: 'local:mock-synth', temperature: 0.1}",
      "  held_out: {id: 'local:mock-heldout'}",
      "providers:",
      `  local_base_url: "${baseUrl}"`,
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!BUILT)("built CLI end-to-end (mock provider)", () => {
  it("quorable review runs the full flow and writes artifacts", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, "review", "doc.md", "--yes"],
      {
        cwd: tmpDir,
        env: {
          ...process.env,
          QUORABLE_HOME: path.join(tmpDir, "home"),
          OPENROUTER_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
        },
        timeout: 60_000,
      },
    );
    const combined = stdout + stderr;

    // Verdict: red_team is composite-excluded; others score 8 → composite 8
    // >= 7.0, no sev-1 → ship at standard tier despite the open validation
    // task (blocking only at rigorous).
    expect(combined).toContain("Verdict: SHIP");
    // Single-vendor panel warning (all local:) must be loud.
    expect(combined).toContain("SINGLE-VENDOR PANEL");
    // Validation task surfaced.
    expect(combined).toContain("Validation tasks: 1 (1 open)");

    const outDir = path.join(tmpDir, "doc-reviewed");
    for (const artifact of [
      "synthesis.json",
      "synthesis_report.md",
      "run_metadata.yaml",
      "run.log",
      "gates.json",
      "validation_tasks.json",
      "cold_read.json",
      "cost_summary.txt",
    ]) {
      expect(fs.existsSync(path.join(outDir, artifact)), artifact).toBe(true);
    }
    // 2 models × 4 personas × 2 runs = 16 raw reviews.
    expect(fs.readdirSync(path.join(outDir, "raw_reviews"))).toHaveLength(16);

    // Agreement patched in code; report carries the M6 sections.
    const report = fs.readFileSync(path.join(outDir, "synthesis_report.md"), "utf-8");
    expect(report).toContain("Inter-Rater Agreement Statistics");
    expect(report).toContain("Cold Read");
    expect(report).toContain("Persona Differentiation");
    // Priority recomputed in code: (16 × 0.8) / 2 = 6.4.
    const synthesis = JSON.parse(
      fs.readFileSync(path.join(outDir, "synthesis.json"), "utf-8"),
    );
    expect(synthesis.ranked_fixes[0].priority_score).toBeCloseTo(6.4, 4);
  }, 90_000);

  it("rigorous blocks on the open validation task and held-out runs", async () => {
    let failed = false;
    let combined = "";
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [CLI, "review", "doc.md", "--yes", "--rigor", "rigorous", "--out", "doc-rigorous"],
        {
          cwd: tmpDir,
          env: {
            ...process.env,
            QUORABLE_HOME: path.join(tmpDir, "home"),
            OPENROUTER_API_KEY: "",
          },
          timeout: 60_000,
        },
      );
      combined = stdout + stderr;
    } catch (exc) {
      failed = true;
      const e = exc as { stdout?: string; stderr?: string };
      combined = (e.stdout ?? "") + (e.stderr ?? "");
    }
    void failed; // review exits 0 on a completed (non-aborted) run
    expect(combined).toContain("NOT SHIPPABLE");
    expect(combined).toContain("unresolved validation task");
    expect(fs.existsSync(path.join(tmpDir, "doc-rigorous", "held_out_validation.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmpDir, "doc-rigorous", "holdout_ledger.yaml"))).toBe(true);
  }, 90_000);

  it("handoff freezes a prediction and outcome joins a result onto it", async () => {
    const env = {
      ...process.env,
      QUORABLE_HOME: path.join(tmpDir, "home"),
      OPENROUTER_API_KEY: "",
    };
    const outDir = path.join(tmpDir, "doc-reviewed");
    const { stdout: handoffOut } = await execFileAsync(
      process.execPath,
      [CLI, "handoff", outDir, "--hypothesis", "citing the stat lifts credibility"],
      { cwd: tmpDir, env, timeout: 30_000 },
    );
    expect(handoffOut).toContain("Prediction frozen");

    // Freeze is write-once.
    await expect(
      execFileAsync(process.execPath, [CLI, "handoff", outDir], {
        cwd: tmpDir,
        env,
        timeout: 30_000,
      }),
    ).rejects.toMatchObject({ code: 1 });

    const runIdMatch = /run=(\S+)/.exec(handoffOut);
    expect(runIdMatch).not.toBeNull();
    const { stdout: outcomeOut } = await execFileAsync(
      process.execPath,
      [CLI, "outcome", runIdMatch![1]!, "--result", "published; 3x median engagement"],
      { cwd: tmpDir, env, timeout: 30_000 },
    );
    expect(outcomeOut).toContain("Recorded outcome");
  }, 60_000);
});
