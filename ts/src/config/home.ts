/**
 * The global home: ~/.quorable/ (plan M2).
 *
 *   config.yaml     default models per role, default council, default rigor
 *   .env            provider keys, chmod 600 (decision §6.2: no OS keyring;
 *                   process env always wins)
 *   personas/*.md   the global persona library
 *   councils/*.yaml named persona sets
 *   rubrics/*.yaml  reusable scoring rubrics (generic-pack input)
 *   cache/          pricing cache etc.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderKeys } from "../providers/registry.js";

export function quorableHome(): string {
  return process.env["QUORABLE_HOME"] ?? path.join(os.homedir(), ".quorable");
}

export function homePaths(home = quorableHome()) {
  return {
    home,
    config: path.join(home, "config.yaml"),
    env: path.join(home, ".env"),
    personas: path.join(home, "personas"),
    councils: path.join(home, "councils"),
    rubrics: path.join(home, "rubrics"),
    cache: path.join(home, "cache"),
  };
}

export function ensureHome(home = quorableHome()): void {
  const paths = homePaths(home);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  for (const dir of [paths.personas, paths.councils, paths.rubrics, paths.cache]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Key storage — ~/.quorable/.env, chmod 600. Process env always wins.
// ---------------------------------------------------------------------------

const KEY_NAMES: Record<string, keyof ProviderKeys> = {
  OPENROUTER_API_KEY: "openrouter",
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  OPENAI_COMPATIBLE_API_KEY: "openai_compatible",
};

export const PROVIDER_ENV_NAMES: Record<keyof ProviderKeys, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openai_compatible: "OPENAI_COMPATIBLE_API_KEY",
};

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read one env var by name: process env first, then ~/.quorable/.env. Used
 * for named endpoints' `api_key_env`, whose names are not known at compile
 * time (TOGETHER_API_KEY, GROQ_API_KEY, …).
 */
export function readEnvVar(name: string, home = quorableHome()): string {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const envPath = homePaths(home).env;
  if (!fs.existsSync(envPath)) return "";
  return parseEnvFile(fs.readFileSync(envPath, "utf-8"))[name] ?? "";
}

/** Load stored provider keys from ~/.quorable/.env (absent file = empty). */
export function loadStoredKeys(home = quorableHome()): ProviderKeys {
  const envPath = homePaths(home).env;
  if (!fs.existsSync(envPath)) return {};
  const vars = parseEnvFile(fs.readFileSync(envPath, "utf-8"));
  const keys: ProviderKeys = {};
  for (const [envName, provider] of Object.entries(KEY_NAMES)) {
    if (vars[envName]) keys[provider] = vars[envName];
  }
  return keys;
}

/** Persist one provider key into ~/.quorable/.env (chmod 600). */
export function storeKey(
  provider: keyof ProviderKeys,
  value: string,
  home = quorableHome(),
): string {
  ensureHome(home);
  const envPath = homePaths(home).env;
  const existing = fs.existsSync(envPath)
    ? parseEnvFile(fs.readFileSync(envPath, "utf-8"))
    : {};
  existing[PROVIDER_ENV_NAMES[provider]] = value;
  const content =
    Object.entries(existing)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  fs.writeFileSync(envPath, content, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
  return envPath;
}

export function deleteKey(provider: keyof ProviderKeys, home = quorableHome()): boolean {
  const envPath = homePaths(home).env;
  if (!fs.existsSync(envPath)) return false;
  const existing = parseEnvFile(fs.readFileSync(envPath, "utf-8"));
  const envName = PROVIDER_ENV_NAMES[provider];
  if (!(envName in existing)) return false;
  delete existing[envName];
  const content =
    Object.entries(existing)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  fs.writeFileSync(envPath, content, { encoding: "utf-8", mode: 0o600 });
  return true;
}

export function maskKey(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Effective keys: stored keys overlaid by process env (env always wins).
 */
export function effectiveKeys(home = quorableHome()): ProviderKeys {
  const keys = loadStoredKeys(home);
  for (const [envName, provider] of Object.entries(KEY_NAMES)) {
    if (process.env[envName]) keys[provider] = process.env[envName];
  }
  return keys;
}
