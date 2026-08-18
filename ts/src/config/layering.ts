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
  if (env["QUORABLE_PROFILE"]) overlay["profile"] = env["QUORABLE_PROFILE"];
  if (env["QUORABLE_COUNCIL"]) overlay["council"] = env["QUORABLE_COUNCIL"];
  if (env["QUORABLE_RUBRIC"]) overlay["rubric"] = env["QUORABLE_RUBRIC"];
  if (env["QUORABLE_RIGOR"]) {
    const rigor = env["QUORABLE_RIGOR"];
    if (!(RIGOR_TIERS as readonly string[]).includes(rigor)) {
      throw new Error(
        `QUORABLE_RIGOR=${rigor} is not a rigor tier (${RIGOR_TIERS.join("|")})`,
      );
    }
    overlay["rigor"] = rigor;
  }
  // Model overrides: the one-off escape hatch for "this run, cheaper".
  const models: PlainObject = {};
  if (env["QUORABLE_MODELS"]) {
    const ids = env["QUORABLE_MODELS"].split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) models["reviewers"] = ids.map((id) => ({ id }));
  }
  if (env["QUORABLE_SYNTHESIZER"]) models["synthesizer"] = { id: env["QUORABLE_SYNTHESIZER"] };
  if (env["QUORABLE_HELD_OUT"]) models["held_out"] = { id: env["QUORABLE_HELD_OUT"] };
  if (Object.keys(models).length > 0) overlay["models"] = models;

  if (env["QUORABLE_LOCAL_BASE_URL"]) {
    overlay["providers"] = { local_base_url: env["QUORABLE_LOCAL_BASE_URL"] };
  }
  return overlay;
}

/**
 * Apply one raw layer, expanding the profile it selects (if any).
 *
 * Within a layer: the selected profile's body goes down FIRST, then the
 * layer's own explicit keys, so a layer can adopt a profile and still
 * override one detail of it. Profile DEFINITIONS accumulate across layers
 * (home defines them, a project can add or redefine); only the SELECTION
 * switches, which is what makes "this job runs on Ollama" a one-line change.
 */
function applyLayer(
  merged: PlainObject,
  raw: PlainObject,
  registry: PlainObject,
  layerName: string,
): { merged: PlainObject; registry: PlainObject } {
  let nextRegistry = registry;
  if (isPlainObject(raw["profiles"])) {
    nextRegistry = deepMerge(registry, raw["profiles"]);
  }

  let overlay = raw;
  const selected = raw["profile"];
  if (typeof selected === "string" && selected.length > 0) {
    const body = nextRegistry[selected];
    if (!isPlainObject(body)) {
      const known = Object.keys(nextRegistry);
      throw new Error(
        `${layerName} selects profile '${selected}', which is not defined. ` +
          (known.length > 0
            ? `Known profiles: ${known.join(", ")}.`
            : `No profiles are defined — add one under \`profiles:\` in ` +
              `~/.quorable/config.yaml.`),
      );
    }
    overlay = deepMerge(body, raw);
  }

  return { merged: deepMerge(merged, overlay), registry: nextRegistry };
}

export interface LoadConfigOptions {
  /** Directory whose ancestors are searched for a project config. */
  projectDir?: string | null;
  /**
   * Fallback search root when `projectDir` yields nothing — normally the
   * cwd, so running against a document outside the project still picks up
   * the project you are standing in.
   */
  fallbackDir?: string | null;
  /** Explicit project config path (--config / QUORABLE_CONFIG); skips discovery. */
  configPath?: string | null;
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
  // Profile definitions accumulate across layers; the selection does not.
  let registry: PlainObject = {};

  const homeConfigPath = homePaths(home).config;
  const homeConfig = loadYamlIfExists(homeConfigPath);
  if (homeConfig) {
    ({ merged, registry } = applyLayer(merged, homeConfig, registry, homeConfigPath));
    sources.push({ layer: "home", path: homeConfigPath });
  }

  // An explicit path wins outright; otherwise search up from the document's
  // directory, then from the cwd (so `quorable review ~/notes/x.md` run
  // inside a project still uses that project's config).
  const explicit = opts.configPath ?? env["QUORABLE_CONFIG"] ?? null;
  let projectPath: string | null = null;
  if (explicit) {
    projectPath = path.resolve(explicit);
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Config file not found: ${projectPath}`);
    }
  } else {
    projectPath =
      (opts.projectDir ? findProjectConfig(opts.projectDir) : null) ??
      (opts.fallbackDir ? findProjectConfig(opts.fallbackDir) : null);
  }
  if (projectPath) {
    const projectConfig = loadYamlIfExists(projectPath);
    if (projectConfig) {
      ({ merged, registry } = applyLayer(merged, projectConfig, registry, projectPath));
      sources.push({ layer: "project", path: projectPath });
    }
  }

  const fromEnv = envOverlay(env);
  if (Object.keys(fromEnv).length > 0) {
    ({ merged, registry } = applyLayer(merged, fromEnv, registry, "environment"));
    sources.push({ layer: "env", path: null });
  }

  if (opts.flags && Object.keys(opts.flags).length > 0) {
    ({ merged, registry } = applyLayer(merged, opts.flags, registry, "CLI flags"));
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
