/**
 * `quorable config` — see and edit the layered configuration.
 *
 * Layering, later wins: packaged defaults → ~/.quorable/config.yaml →
 * project quorable.yaml → environment → CLI flags. `show` prints the
 * effective result plus which files contributed; `set`/`unset` write to one
 * chosen layer (home by default, `--project` for the current directory), so
 * a project can override models, providers, rigor, or anything else without
 * touching global defaults.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { Command } from "commander";

import { ensureHome, homePaths } from "../../config/home.js";
import {
  deepMerge,
  findProjectConfig,
  loadConfig,
  PROJECT_CONFIG_NAMES,
} from "../../config/layering.js";
import {
  ConfigSchema,
  endpointNames,
  localBackendWarnings,
  PACKAGED_DEFAULTS,
  vendorOverrides,
} from "../../config/schema.js";
import { parseModelRef, vendorOf } from "../../providers/types.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The file a write lands in: the project config, or the home config. */
function targetFile(opts: { project?: boolean }): string {
  if (opts.project) {
    return findProjectConfig(process.cwd()) ?? path.join(process.cwd(), PROJECT_CONFIG_NAMES[0]!);
  }
  return homePaths().config;
}

function readLayer(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = parseYaml(fs.readFileSync(file, "utf-8"));
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${file} must contain a YAML mapping.`);
  }
  return raw as Record<string, unknown>;
}

function writeLayer(file: string, data: Record<string, unknown>): void {
  if (file === homePaths().config) ensureHome();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyYaml(data), "utf-8");
}

/** Coerce a CLI string into the YAML scalar it looks like. */
function coerce(value: string): unknown {
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  // Comma lists become arrays — `personas=a,b,c`, `models.reviewers` is
  // handled by its own command since its items are objects.
  if (value.includes(",")) return value.split(",").map((s) => s.trim()).filter(Boolean);
  return value;
}

function getPath(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const part of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
}

function unsetPath(obj: Record<string, unknown>, parts: string[]): boolean {
  const parent = getPath(obj, parts.slice(0, -1));
  if (typeof parent !== "object" || parent === null) return false;
  const key = parts.at(-1)!;
  if (!(key in (parent as Record<string, unknown>))) return false;
  delete (parent as Record<string, unknown>)[key];
  return true;
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description(
      "Inspect and edit configuration (defaults → ~/.quorable/config.yaml → " +
        "project quorable.yaml → env → flags)",
    );

  config
    .command("show", { isDefault: true })
    .description("Print the effective config and the layers that produced it")
    .option("--project-dir <dir>", "directory to resolve the project layer from")
    .option("--json", "emit JSON")
    .action((opts: { projectDir?: string; json?: boolean }) => {
      const dir = opts.projectDir ? path.resolve(opts.projectDir) : process.cwd();
      const { config: effective, sources } = loadConfig({
        projectDir: dir,
        fallbackDir: process.cwd(),
      });
      if (opts.json) {
        console.log(JSON.stringify({ config: effective, sources }, null, 2));
        return;
      }
      console.log("Layers (later wins):");
      for (const s of sources) {
        console.log(`  ${s.layer.padEnd(9)} ${s.path ?? "(built in)"}`);
      }
      const inactive = ["home", "project"].filter(
        (layer) => !sources.some((s) => s.layer === layer),
      );
      for (const layer of inactive) {
        const where =
          layer === "home" ? homePaths().config : `${PROJECT_CONFIG_NAMES[0]} (not found)`;
        console.log(`  ${layer.padEnd(9)} — none (${where})`);
      }

      if (effective.profile) {
        console.log(`\nActive profile: ${effective.profile}`);
      }

      console.log("\nEffective config:");
      console.log(stringifyYaml(effective).trimEnd());

      // Vendor buckets decide whether agreement statistics mean anything,
      // and local models default to one shared bucket — show the result.
      const resolution = {
        endpoints: endpointNames(effective),
        vendors: vendorOverrides(effective),
      };
      console.log("\nReviewer panel:");
      for (const r of effective.models.reviewers.filter((x) => !x.held_out)) {
        let vendor: string;
        try {
          vendor = vendorOf(parseModelRef(r.id, resolution), resolution);
        } catch (exc) {
          vendor = `UNRESOLVED (${exc instanceof Error ? exc.message : String(exc)})`;
        }
        console.log(`  ${r.id.padEnd(38)} vendor=${vendor}`);
      }
      for (const w of localBackendWarnings(effective)) {
        console.log(`\nWARNING: ${w}`);
      }
    });

  config
    .command("path")
    .description("Print the config file paths for each writable layer")
    .action(() => {
      console.log(`home     ${homePaths().config}`);
      const project = findProjectConfig(process.cwd());
      console.log(`project  ${project ?? `(none found from ${process.cwd()})`}`);
    });

  config
    .command("get <key>")
    .description("Read one effective value, dotted (e.g. models.synthesizer.id)")
    .action((key: string) => {
      const { config: effective } = loadConfig({
        projectDir: process.cwd(),
        fallbackDir: process.cwd(),
      });
      const value = getPath(effective, key.split("."));
      if (value === undefined) fail(`No such key: ${key}`);
      console.log(
        typeof value === "object" && value !== null
          ? stringifyYaml(value).trimEnd()
          : String(value),
      );
    });

  config
    .command("set <key> <value>")
    .description("Write one value, dotted (e.g. rigor quick, pipeline.max_concurrency 2)")
    .option("--project", "write to the project quorable.yaml instead of ~/.quorable/config.yaml")
    .action((key: string, value: string, opts: { project?: boolean }) => {
      const file = targetFile(opts);
      const layer = readLayer(file);
      setPath(layer, key.split("."), coerce(value));
      // Validate the merged result before persisting: a config that cannot
      // load is worse than a rejected edit.
      assertValid(layer, file, opts.project === true);
      writeLayer(file, layer);
      console.log(`${file}: ${key} = ${value}`);
    });

  config
    .command("unset <key>")
    .description("Remove one value from a layer, letting the layer below win")
    .option("--project", "edit the project quorable.yaml")
    .action((key: string, opts: { project?: boolean }) => {
      const file = targetFile(opts);
      if (!fs.existsSync(file)) fail(`No config at ${file}.`);
      const layer = readLayer(file);
      if (!unsetPath(layer, key.split("."))) fail(`${file} does not set ${key}.`);
      assertValid(layer, file, opts.project === true);
      writeLayer(file, layer);
      console.log(`${file}: removed ${key}`);
    });

  config
    .command("models <ids...>")
    .description("Set the reviewer panel (space- or comma-separated model ids)")
    .option("--project", "write to the project quorable.yaml")
    .option("--synthesizer <id>", "also set the synthesizer model")
    .option("--held-out <id>", "also set the held-out model")
    .action((ids: string[], opts: { project?: boolean; synthesizer?: string; heldOut?: string }) => {
      const file = targetFile(opts);
      const layer = readLayer(file);
      const reviewers = ids.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
      if (reviewers.length === 0) fail("Give at least one model id.");
      setPath(layer, ["models", "reviewers"], reviewers.map((id) => ({ id })));
      if (opts.synthesizer) setPath(layer, ["models", "synthesizer"], { id: opts.synthesizer });
      if (opts.heldOut) setPath(layer, ["models", "held_out"], { id: opts.heldOut });
      assertValid(layer, file, opts.project === true);
      writeLayer(file, layer);
      console.log(`${file}: reviewers = ${reviewers.join(", ")}`);
      console.log("Run `quorable config show` to see vendor buckets for the new panel.");
    });

  // --- profiles -------------------------------------------------------------
  const profile = config
    .command("profile")
    .description("Named setting bundles — normally which local backend a job runs on");

  profile
    .command("list")
    .description("List defined profiles and mark the active one")
    .action(() => {
      const { config: effective } = loadConfig({
        projectDir: process.cwd(),
        fallbackDir: process.cwd(),
      });
      const names = Object.keys(effective.profiles);
      if (names.length === 0) {
        console.log("No profiles defined. Add one under `profiles:` in");
        console.log(`  ${homePaths().config}`);
        return;
      }
      for (const name of names) {
        const active = name === effective.profile;
        const body = effective.profiles[name] as Record<string, unknown>;
        const models = (body?.["models"] ?? {}) as Record<string, unknown>;
        const reviewers = (models["reviewers"] ?? []) as { id?: string }[];
        const summary = Array.isArray(reviewers)
          ? `${reviewers.length} reviewer(s)`
          : "no reviewers";
        console.log(`${active ? "*" : " "} ${name.padEnd(14)} ${summary}`);
      }
      if (!effective.profile) {
        console.log("\n(no profile active — the base config is used as written)");
      }
    });

  profile
    .command("use <name>")
    .description("Make a profile active (this is how a job picks its backend)")
    .option("--project", "select it for this project only")
    .action((name: string, opts: { project?: boolean }) => {
      const file = targetFile(opts);
      const layer = readLayer(file);
      const { config: effective } = loadConfig({
        projectDir: process.cwd(),
        fallbackDir: process.cwd(),
      });
      const known = Object.keys(effective.profiles);
      if (!known.includes(name)) {
        fail(
          `No profile '${name}'.` +
            (known.length > 0
              ? ` Known: ${known.join(", ")}.`
              : " None are defined yet."),
        );
      }
      setPath(layer, ["profile"], name);
      assertValid(layer, file, opts.project === true);
      writeLayer(file, layer);
      console.log(`${file}: profile = ${name}`);
      console.log("Run `quorable config show` to see the resulting panel.");
    });

  profile
    .command("show <name>")
    .description("Print one profile's body")
    .action((name: string) => {
      const { config: effective } = loadConfig({
        projectDir: process.cwd(),
        fallbackDir: process.cwd(),
      });
      const body = effective.profiles[name];
      if (!body) fail(`No profile '${name}'. Known: ${Object.keys(effective.profiles).join(", ")}`);
      console.log(stringifyYaml(body).trimEnd());
    });

  // --- endpoints ------------------------------------------------------------
  const endpoint = config
    .command("endpoint")
    .description("Manage named OpenAI-compatible endpoints (local servers, hosted APIs)");

  endpoint
    .command("add <name> <baseUrl>")
    .description("Define an endpoint, addressable as <name>:<model-id>")
    .option("--project", "write to the project quorable.yaml")
    .option("--api-key-env <var>", "env var holding the key (omit for keyless local servers)")
    .option("--json-mode", "endpoint accepts response_format json_object")
    .option("--vendor <name>", "vendor bucket for every model here (agreement statistics)")
    .option("--vendor-from-model-id", "derive the vendor from the model id's vendor/ prefix")
    .action(
      (
        name: string,
        baseUrl: string,
        opts: {
          project?: boolean;
          apiKeyEnv?: string;
          jsonMode?: boolean;
          vendor?: string;
          vendorFromModelId?: boolean;
        },
      ) => {
        if (name.includes(":") || name.includes("/")) {
          fail(`Endpoint name '${name}' cannot contain ':' or '/' — it is a model-id prefix.`);
        }
        const file = targetFile(opts);
        const layer = readLayer(file);
        const entry: Record<string, unknown> = { base_url: baseUrl };
        if (opts.apiKeyEnv) entry["api_key_env"] = opts.apiKeyEnv;
        if (opts.jsonMode) entry["json_mode"] = true;
        if (opts.vendor) entry["vendor"] = opts.vendor;
        if (opts.vendorFromModelId) entry["vendor_from_model_id"] = true;
        setPath(layer, ["providers", "endpoints", name], entry);
        assertValid(layer, file, opts.project === true);
        writeLayer(file, layer);
        console.log(`${file}: endpoint '${name}' → ${baseUrl}`);
        console.log(`Use it as a model prefix, e.g. --model ${name}:<model-id>`);
      },
    );

  endpoint
    .command("list")
    .description("List effective endpoints")
    .action(() => {
      const { config: effective } = loadConfig({
        projectDir: process.cwd(),
        fallbackDir: process.cwd(),
      });
      const entries = Object.entries(effective.providers.endpoints);
      if (entries.length === 0) {
        console.log("No named endpoints. Add one:");
        console.log("  quorable config endpoint add lmstudio http://localhost:1234/v1");
        if (effective.providers.local_base_url) {
          console.log(`\nBuilt-in 'local:' prefix → ${effective.providers.local_base_url}`);
        }
        return;
      }
      for (const [name, e] of entries) {
        const bits = [
          `key=${e.api_key ? "(literal)" : (e.api_key_env ?? "none")}`,
          `json_mode=${e.json_mode}`,
          `vendor=${e.vendor ?? (e.vendor_from_model_id ? "from-model-id" : "local")}`,
        ];
        console.log(`${name.padEnd(14)} ${e.base_url.padEnd(34)} ${bits.join("  ")}`);
      }
    });

  endpoint
    .command("remove <name>")
    .description("Remove an endpoint definition")
    .option("--project", "edit the project quorable.yaml")
    .action((name: string, opts: { project?: boolean }) => {
      const file = targetFile(opts);
      if (!fs.existsSync(file)) fail(`No config at ${file}.`);
      const layer = readLayer(file);
      if (!unsetPath(layer, ["providers", "endpoints", name])) {
        fail(`${file} does not define endpoint '${name}'.`);
      }
      writeLayer(file, layer);
      console.log(`${file}: removed endpoint '${name}'`);
    });
}
/**
 * Validate an edited layer the way a real run would see it — merged over
 * everything beneath it — so `config set` can never persist a file that
 * makes the CLI unusable. A home layer sits on the packaged defaults; a
 * project layer sits on defaults + home. Env and flags are deliberately
 * excluded: a temporary override must not mask a bad write.
 */
function assertValid(layer: Record<string, unknown>, file: string, isProject: boolean): void {
  let below: Record<string, unknown> = { ...(PACKAGED_DEFAULTS as Record<string, unknown>) };
  if (isProject) below = deepMerge(below, readLayer(homePaths().config));
  const parsed = ConfigSchema.safeParse(deepMerge(below, layer));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    fail(`Refusing to write ${file} — the result would be invalid:\n${detail}`);
  }
}
