/**
 * Mechanical command checks: a named argv run inside the candidate directory,
 * passing on exit code 0. Tests, type checks, linters, renderers, probes —
 * anything the project can express as a command. No shell, no model. Output
 * is frozen to a log file so reviewers and verifiers can quote it as
 * evidence. Commands come from the rubric or the CLI, i.e. the same trust
 * level as the project's own build scripts.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { GateResult } from "./gates.js";

export interface CommandCheck { name: string; argv: string[]; timeoutMs: number }

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OUTPUT_CAP = 1024 * 1024;

export function validateCheck(check: CommandCheck): CommandCheck {
  if (!NAME_RE.test(check.name)) throw new Error(`Check name '${check.name}' must be alphanumeric with . _ - (max 64 chars).`);
  if (!check.argv.length || check.argv.some((a) => typeof a !== "string" || !a.length)) throw new Error(`Check '${check.name}' needs a non-empty argv.`);
  if (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs <= 0 || check.timeoutMs > 2_147_483_647) throw new Error(`Check '${check.name}' has an invalid timeout.`);
  return check;
}

/** `name=command arg arg` — whitespace-split, no quoting or shell; wrap complex commands in a script. */
export function parseCheckFlag(value: string, timeoutMs: number): CommandCheck {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new Error(`Expected name=command, got '${value}'.`);
  const name = value.slice(0, eq).trim();
  const argv = value.slice(eq + 1).trim().split(/\s+/).filter(Boolean);
  return validateCheck({ name, argv, timeoutMs });
}

export interface CheckRun { result: GateResult; log: string; exit: string; elapsedMs: number; stdout: string; stderr: string }

/** Exit states that mean the command never produced a trustworthy result. */
export function abnormalExit(exit: string): boolean {
  return exit === "cancelled" || exit.startsWith("timed out") || exit.startsWith("could not start") ||
    exit.startsWith("output exceeded") || exit.startsWith("signal");
}

export function runCommandCheck(
  check: CommandCheck, cwd: string, logPath: string, signal?: AbortSignal, env: Record<string, string> = {},
): Promise<CheckRun> {
  validateCheck(check);
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = ""; let stderr = ""; let bytes = 0; let exit = "unknown"; let finished = false;
    const child = spawn(check.argv[0]!, check.argv.slice(1), {
      cwd, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32",
      env: { ...process.env, ...env },
    });
    const kill = (): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* exited */ }
    };
    const timer = setTimeout(() => { exit = `timed out after ${check.timeoutMs}ms`; kill(); }, check.timeoutMs);
    const abort = (): void => { exit = "cancelled"; kill(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const take = (text: string, sink: "out" | "err"): void => {
      bytes += Buffer.byteLength(text);
      if (bytes > OUTPUT_CAP) { if (exit === "unknown") exit = "output exceeded 1 MiB"; kill(); return; }
      if (sink === "out") stdout += text; else stderr += text;
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (t: string) => take(t, "out"));
    child.stderr.on("data", (t: string) => take(t, "err"));
    const finish = (code: number | null, sig: NodeJS.Signals | null, error?: Error): void => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) exit = `could not start: ${error.message}`;
      else if (exit === "unknown") exit = code === null ? `signal ${sig ?? "unknown"}` : `exit ${code}`;
      const passed = exit === "exit 0";
      const elapsedMs = Date.now() - start;
      const tail = `${stderr}\n${stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-5).map((l) => l.slice(0, 200));
      const findings = passed ? [] : [`${check.name}: ${exit} (log: ${logPath})`, ...tail];
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, `# check: ${check.name}\n$ ${check.argv.join(" ")}\ncwd: ${cwd}\nresult: ${exit}\npassed: ${passed}\nelapsed_ms: ${elapsedMs}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
      resolve({ result: { passed, findings }, log: logPath, exit, elapsedMs, stdout, stderr });
    };
    child.on("error", (exc) => finish(null, null, exc));
    child.on("close", (code, sig) => finish(code, sig));
  });
}

/** Sequential, so checks that share ports or caches do not race. Names must be unique. */
export async function runCommandChecks(
  checks: CommandCheck[], cwd: string, logDir: string, signal?: AbortSignal, env: Record<string, string> = {},
): Promise<{ results: Record<string, GateResult>; logs: string[] }> {
  if (new Set(checks.map((c) => c.name)).size !== checks.length) throw new Error("Check names must be unique.");
  const results: Record<string, GateResult> = {}; const logs: string[] = [];
  for (const check of checks) {
    const run = await runCommandCheck(check, cwd, path.join(logDir, `${check.name}.log`), signal, env);
    results[check.name] = run.result; logs.push(run.log);
  }
  return { results, logs };
}
