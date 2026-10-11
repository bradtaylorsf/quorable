import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCheckFlag, runCommandCheck, runCommandChecks } from "../src/engine/checks.js";

const dirs: string[] = [];
function temp(): string { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quorable-checks-"))); dirs.push(d); return d; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const node = process.execPath;

describe("command checks", () => {
  it("passes on exit 0 and freezes the output log", async () => {
    const dir = temp(); const log = path.join(dir, "logs", "ok.log");
    const run = await runCommandCheck({ name: "ok", argv: [node, "-e", "console.log('all good')"], timeoutMs: 10_000 }, dir, log);
    expect(run.result).toEqual({ passed: true, findings: [] });
    const text = fs.readFileSync(log, "utf8");
    expect(text).toContain("result: exit 0"); expect(text).toContain("all good"); expect(text).toContain(`cwd: ${dir}`);
  });
  it("fails on non-zero exit with the log path and an output tail as findings", async () => {
    const dir = temp();
    const run = await runCommandCheck({ name: "tests", argv: [node, "-e", "console.error('1 test failed: expected ok'); process.exit(3)"], timeoutMs: 10_000 }, dir, path.join(dir, "t.log"));
    expect(run.result.passed).toBe(false);
    expect(run.result.findings[0]).toMatch(/^tests: exit 3 \(log: /);
    expect(run.result.findings).toContain("1 test failed: expected ok");
  });
  it("kills on timeout and reports it", async () => {
    const dir = temp();
    const run = await runCommandCheck({ name: "slow", argv: [node, "-e", "setTimeout(() => {}, 20000)"], timeoutMs: 100 }, dir, path.join(dir, "s.log"));
    expect(run.result.passed).toBe(false); expect(run.exit).toMatch(/timed out/);
  });
  it("reports an unstartable command instead of crashing", async () => {
    const dir = temp();
    const run = await runCommandCheck({ name: "missing", argv: ["definitely-not-a-real-binary-xyz"], timeoutMs: 1000 }, dir, path.join(dir, "m.log"));
    expect(run.result.passed).toBe(false); expect(run.exit).toMatch(/could not start/);
  });
  it("runs the configured command in the candidate directory", async () => {
    const dir = temp(); fs.writeFileSync(path.join(dir, "flag.txt"), "present");
    const { results, logs } = await runCommandChecks([
      { name: "flag", argv: [node, "-e", "require('fs').accessSync('flag.txt')"], timeoutMs: 5000 },
      { name: "no-flag", argv: [node, "-e", "require('fs').accessSync('absent.txt')"], timeoutMs: 5000 },
    ], dir, path.join(dir, "logs"));
    expect(results["flag"]!.passed).toBe(true); expect(results["no-flag"]!.passed).toBe(false); expect(logs).toHaveLength(2);
    await expect(runCommandChecks([{ name: "a", argv: [node], timeoutMs: 1 }, { name: "a", argv: [node], timeoutMs: 1 }], dir, dir)).rejects.toThrow(/unique/);
  });
  it("parses name=command flags without a shell", () => {
    expect(parseCheckFlag("tests=npm test -- --run", 5000)).toEqual({ name: "tests", argv: ["npm", "test", "--", "--run"], timeoutMs: 5000 });
    expect(() => parseCheckFlag("npm test", 5000)).toThrow(/name=command/);
    expect(() => parseCheckFlag("bad name=npm test", 5000)).toThrow(/alphanumeric/);
    expect(() => parseCheckFlag("empty=", 5000)).toThrow(/argv/);
  });
});
