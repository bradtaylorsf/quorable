/** Subprocess adapters for investigative agents. Reports are prose, never JSON. */
import { spawn } from "node:child_process";

export type Harness = "codex" | "claude";
export interface AgentSpec { harness: Harness; model?: string }
/**
 * "read": investigate only — read/search tools, no edits, no shell for Claude,
 * read-only sandbox for Codex. "write": a normal coding session confined to
 * cwd — edit/write/shell for Claude (permission allowlist, no OS sandbox),
 * workspace-write sandbox for Codex. Nothing ever passes a permission-bypass flag.
 */
export type AgentPolicy = "read" | "write";
export interface AgentRequest {
  agent: AgentSpec;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  policy?: AgentPolicy;
  /** Extra directories the agent may read (Claude `--add-dir`); Codex reads freely inside its sandbox. */
  readDirs?: string[];
  signal?: AbortSignal;
  onTrace?: (text: string) => void;
}
export interface AgentResponse {
  status: "completed" | "failed" | "timed_out" | "cancelled";
  markdown: string;
  error: string | null;
  elapsedMs: number;
}
export type AgentRunner = (request: AgentRequest) => Promise<AgentResponse>;

export function parseAgentSpec(value: string): AgentSpec {
  const [harness, ...rest] = value.split(":");
  if (harness !== "codex" && harness !== "claude") {
    throw new Error(`Unknown agent '${value}'; use codex[:model] or claude[:model].`);
  }
  const model = rest.join(":");
  if (rest.length && !model.trim()) throw new Error("Agent model cannot be empty.");
  return { harness, ...(model ? { model } : {}) };
}

const CLAUDE_TOOLS: Record<AgentPolicy, string> = {
  read: "Read,Glob,Grep,WebSearch,WebFetch",
  write: "Read,Glob,Grep,Edit,Write,Bash,WebSearch,WebFetch",
};

export function harnessCommand(
  agent: AgentSpec, policy: AgentPolicy = "read", readDirs: string[] = [],
): { command: string; args: string[] } {
  const args = agent.harness === "codex"
    ? ["exec", "--sandbox", policy === "write" ? "workspace-write" : "read-only", "--ephemeral",
       "--skip-git-repo-check", "--color", "never", "-c", "approval_policy=\"never\""]
    : ["--print", "--output-format", "text", "--no-session-persistence",
       "--permission-mode", "dontAsk", "--tools", CLAUDE_TOOLS[policy],
       "--allowedTools", CLAUDE_TOOLS[policy],
       "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
  if (agent.harness === "claude" && readDirs.length) args.push("--add-dir", ...readDirs);
  if (agent.model) args.push("--model", agent.model);
  if (agent.harness === "codex") args.push("-");
  const executable = process.env[agent.harness === "codex" ? "QUORABLE_CODEX_BIN" : "QUORABLE_CLAUDE_BIN"];
  return { command: executable || agent.harness, args };
}

/** No shell interpolation. Kill the process group on POSIX, including tool children. */
export function runAgentProcess(
  request: AgentRequest,
  command = harnessCommand(request.agent, request.policy ?? "read", request.readDirs ?? []),
): Promise<AgentResponse> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 2_147_483_647) {
    return Promise.reject(new Error("timeoutMs must be a positive integer <= 2147483647."));
  }
  return new Promise((resolve) => {
    const start = Date.now();
    if (request.signal?.aborted) {
      resolve({ status: "cancelled", markdown: "", error: "Agent cancelled.", elapsedMs: 0 });
      return;
    }
    let markdown = "";
    let stderr = "";
    let forced: AgentResponse["status"] | null = null;
    let error: string | null = null;
    let finished = false;
    let bytes = 0;
    const child = spawn(command.command, command.args, {
      cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false,
      detached: process.platform !== "win32",
    });
    const kill = (): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already exited */ }
    };
    const stop = (status: AgentResponse["status"], reason: string): void => {
      forced = status; error = reason; kill();
    };
    const abort = (): void => stop("cancelled", "Agent cancelled.");
    const timer = setTimeout(() => stop("timed_out", `Agent exceeded ${request.timeoutMs}ms.`), request.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      const status = forced ?? (code === 0 && markdown.trim() ? "completed" : "failed");
      resolve({ status, markdown: markdown.trim(), elapsedMs: Date.now() - start,
        error: status === "completed" ? null : error ??
          `Agent exited ${code ?? "without a code"}: ${stderr.trim() || markdown.trim().slice(-8000) || "no final report"}` });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > 8 * 1024 * 1024) stop("failed", "Agent output exceeded 8 MiB.");
      else markdown += text;
    });
    child.stderr.on("data", (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > 8 * 1024 * 1024) {
        stop("failed", "Agent output exceeded 8 MiB.");
        return;
      }
      stderr = (stderr + text).slice(-8000);
      try { request.onTrace?.(text); }
      catch (exc) { stop("failed", `Cannot save agent trace: ${String(exc)}`); }
    });
    child.on("error", (exc) => { error = exc.message; finish(null); });
    child.on("close", finish);
    child.stdin.on("error", () => { /* EPIPE is reported by exit/error above */ });
    child.stdin.end(request.prompt);
  });
}
