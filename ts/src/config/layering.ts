/**
 * Config layering: packaged defaults → ~/.quorable/config.yaml → project
 * config → env vars → CLI flags, later wins (plan M2, Blocker 3).
 *
 * Merge semantics: objects deep-merge, arrays and scalars replace. A
 * project config is `quorable.yaml` or `.quorable.yaml` found in the target
 * document's directory or any ancestor (nearest wins), so `quorable review
 * some/deep/file.md` picks up the project's settings from anywhere.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { homePaths, quorableHome } from "./home.js";
import { ConfigSchema, PACKAGED_DEFAULTS, type QuorableConfig, RIGOR_TIERS } from "./schema.js";

export const PROJECT_CONFIG_NAMES = ["quorable.yaml", ".quorable.yaml"];

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge, arrays/scalars replace, null overrides. */
export function deepMerge(base: PlainObject, overlay: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function loadYamlIfExists(filePath: string): PlainObject | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = parseYaml(fs.readFileSync(filePath, "utf-8"));
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) {
    throw new Error(`${filePath} must contain a YAML mapping, got ${typeof raw}`);
  }
  return raw;
}

/** Find the nearest project config walking up from startDir. */
export function findProjectConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function envOverlay(env: NodeJS.ProcessEnv): PlainObject {
  const overlay: PlainObject = {};
  if (env["QUORABLE_COUNCIL"]) overlay["council"] = env["QUORABLE_COUNCIL"];
  if (env["QUORABLE_RIGOR"]) {
    const rigor = env["QUORABLE_RIGOR"];
    if (!(RIGOR_TIERS as readonly string[]).includes(rigor)) {
      throw new Error(
        `QUORABLE_RIGOR=${rigor} is not a rigor tier (${RIGOR_TIERS.join("|")})`,
      );
    }
    overlay["rigor"] = rigor;
  }
  if (env["QUORABLE_LOCAL_BASE_URL"]) {
    overlay["providers"] = { local_base_url: env["QUORABLE_LOCAL_BASE_URL"] };
  }
  return overlay;
}

export interface LoadConfigOptions {
  /** Directory whose ancestors are searched for a project config. */
  projectDir?: string | null;
  /** CLI flag overrides (highest precedence), already config-shaped. */
  flags?: PlainObject;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedConfig {
  config: QuorableConfig;
  /** Where each layer came from, for `quorable config` introspection. */
  sources: { layer: string; path: string | null }[];
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const home = opts.home ?? quorableHome();
  const env = opts.env ?? process.env;
  const sources: LoadedConfig["sources"] = [];

  let merged: PlainObject = { ...(PACKAGED_DEFAULTS as PlainObject) };
  sources.push({ layer: "defaults", path: null });

  const homeConfigPath = homePaths(home).config;
  const homeConfig = loadYamlIfExists(homeConfigPath);
  if (homeConfig) {
    merged = deepMerge(merged, homeConfig);
    sources.push({ layer: "home", path: homeConfigPath });
  }

  if (opts.projectDir) {
    const projectPath = findProjectConfig(opts.projectDir);
    if (projectPath) {
      const projectConfig = loadYamlIfExists(projectPath);
      if (projectConfig) {
        merged = deepMerge(merged, projectConfig);
        sources.push({ layer: "project", path: projectPath });
      }
    }
  }

  const fromEnv = envOverlay(env);
  if (Object.keys(fromEnv).length > 0) {
    merged = deepMerge(merged, fromEnv);
    sources.push({ layer: "env", path: null });
  }

  if (opts.flags && Object.keys(opts.flags).length > 0) {
    merged = deepMerge(merged, opts.flags);
    sources.push({ layer: "flags", path: null });
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration after layering:\n${detail}`);
  }
  return { config: parsed.data, sources };
}
