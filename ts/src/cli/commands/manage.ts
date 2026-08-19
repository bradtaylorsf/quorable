/**
 * Management commands: keys, persona, council, init.
 */

import fs from "node:fs";
import path from "node:path";

import type { Command } from "commander";

import {
  deleteKey,
  ensureHome,
  homePaths,
  loadStoredKeys,
  maskKey,
  PROVIDER_ENV_NAMES,
  quorableHome,
  storeKey,
} from "../../config/home.js";
import { findProjectConfig } from "../../config/layering.js";
import {
  councilPath,
  listCouncils,
  listPersonas,
  listRubrics,
  loadCouncil,
  personaPath,
  loadPersonaOverlay,
  type AssetRoots,
} from "../../config/resolve.js";
import type { ProviderKeys } from "../../providers/registry.js";

const PROVIDERS = ["openrouter", "anthropic", "openai", "openai_compatible"] as const;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Asset roots including the nearest project's `.quorable/`, if any. */
function cwdRoots(): AssetRoots {
  const projectConfig = findProjectConfig(process.cwd());
  return projectConfig
    ? { extra: [path.join(path.dirname(projectConfig), ".quorable")] }
    : {};
}

function sourceLabel(p: string, roots: AssetRoots): string {
  if ((roots.extra ?? []).some((r) => p.startsWith(r + path.sep))) return "(project)";
  return p.startsWith(quorableHome()) ? "(user)" : "(packaged)";
}

/** User and project files are editable; packaged assets are not. */
function editablePath(p: string | null, roots: AssetRoots): boolean {
  if (!p) return false;
  return sourceLabel(p, roots) !== "(packaged)";
}

export function registerManageCommands(program: Command): void {
  // --- keys -----------------------------------------------------------------
  const keys = program
    .command("keys")
    .description("Manage provider API keys (~/.quorable/.env, chmod 600; env vars always win)");

  keys
    .command("set <provider> [key]")
    .description(`Store a key. Providers: ${PROVIDERS.join(", ")}`)
    .action(async (provider: string, key?: string) => {
      if (!(PROVIDERS as readonly string[]).includes(provider)) {
        fail(`Unknown provider '${provider}'. Valid: ${PROVIDERS.join(", ")}`);
      }
      let value = key;
      if (!value) {
        if (!process.stdin.isTTY) {
          fail("Pass the key as an argument or run interactively.");
        }
        const clack = await import("@clack/prompts");
        const input = await clack.password({ message: `${provider} API key:` });
        if (clack.isCancel(input)) process.exit(0);
        value = input.trim();
      }
      const envPath = storeKey(provider as keyof ProviderKeys, value);
      console.log(`Stored ${PROVIDER_ENV_NAMES[provider as keyof ProviderKeys]} in ${envPath} (600).`);
      console.log("Note: a process env var with the same name always wins.");
    });

  keys
    .command("list")
    .description("List stored keys (masked) and which env vars are set")
    .action(() => {
      const stored = loadStoredKeys();
      for (const provider of PROVIDERS) {
        const envName = PROVIDER_ENV_NAMES[provider];
        const envSet = Boolean(process.env[envName]);
        const storedKey = stored[provider];
        const parts = [
          `${provider.padEnd(18)}`,
          storedKey ? `stored: ${maskKey(storedKey)}` : "stored: —",
          envSet ? `env ${envName}: set (wins)` : `env ${envName}: —`,
        ];
        console.log(parts.join("  "));
      }
    });

  keys
    .command("delete <provider>")
    .description("Remove a stored key")
    .action((provider: string) => {
      if (!(PROVIDERS as readonly string[]).includes(provider)) {
        fail(`Unknown provider '${provider}'. Valid: ${PROVIDERS.join(", ")}`);
      }
      const removed = deleteKey(provider as keyof ProviderKeys);
      console.log(removed ? `Removed stored ${provider} key.` : `No stored ${provider} key.`);
    });

  // --- persona --------------------------------------------------------------
  const persona = program
    .command("persona")
    .description("Manage the persona library (~/.quorable/personas + packaged)");

  persona
    .command("list")
    .description("List available personas")
    .action(() => {
      const roots = cwdRoots();
      for (const name of listPersonas(roots)) {
        const p = personaPath(name, roots)!;
        console.log(`${name.padEnd(22)} ${sourceLabel(p, roots)}  ${p}`);
      }
    });

  persona
    .command("show <name>")
    .description("Print a persona overlay")
    .action((name: string) => {
      console.log(loadPersonaOverlay(name, cwdRoots()));
    });

  persona
    .command("new <name>")
    .description("Create a persona in ~/.quorable/personas from the house template")
    .action((name: string) => {
      ensureHome();
      const dest = path.join(homePaths().personas, `${name}.md`);
      if (fs.existsSync(dest)) fail(`${dest} already exists.`);
      fs.writeFileSync(
        dest,
        `# ${name}\n\n## Lens\n\n(One paragraph: the single question this persona asks of every document.)\n\n## What you own\n\n- \n- \n\n## Approach\n\n(How it reads, what counts as a finding, what a finding must include.\nEvery weakness cites a location; every attack states what would neutralize it.)\n\n## Temperament\n\n(A sentence or two.)\n`,
        "utf-8",
      );
      console.log(`Created ${dest} — edit it, then add it to a council.`);
    });

  // --- council --------------------------------------------------------------
  const council = program
    .command("council")
    .description("Manage councils (named persona sets; models stay config)");

  council
    .command("list")
    .description("List available councils")
    .action(() => {
      const roots = cwdRoots();
      for (const name of listCouncils(roots)) {
        const c = loadCouncil(name, roots);
        console.log(`${name.padEnd(18)} rubric=${c.rubric.padEnd(16)} [${c.personas.join(", ")}]`);
      }
    });

  council
    .command("show <name>")
    .description("Show a council: personas, rubric, source file")
    .action((name: string) => {
      const roots = cwdRoots();
      const c = loadCouncil(name, roots);
      console.log(`name:     ${c.name}`);
      console.log(`about:    ${c.description}`);
      console.log(`rubric:   ${c.rubric}`);
      console.log(`personas: ${c.personas.join(", ")}`);
      console.log(`file:     ${councilPath(name, roots)}`);
    });

  council
    .command("new <name>")
    .description("Create a council in ~/.quorable/councils")
    .option("--personas <names>", "comma-separated persona names", "")
    .option("--rubric <name>", "rubric name", "document")
    .action((name: string, opts: { personas: string; rubric: string }) => {
      ensureHome();
      const roots = cwdRoots();
      const personas = opts.personas.split(",").map((s) => s.trim()).filter(Boolean);
      if (personas.length === 0) {
        fail(`--personas is required. Available: ${listPersonas(roots).join(", ")}`);
      }
      const missing = personas.filter((p) => !personaPath(p, roots));
      if (missing.length > 0) {
        fail(`Unknown persona(s): ${missing.join(", ")}. Available: ${listPersonas(roots).join(", ")}`);
      }
      if (!listRubrics(roots).includes(opts.rubric)) {
        fail(`Unknown rubric '${opts.rubric}'. Available: ${listRubrics(roots).join(", ")}`);
      }
      const dest = path.join(homePaths().councils, `${name}.yaml`);
      if (fs.existsSync(dest)) fail(`${dest} already exists.`);
      fs.writeFileSync(
        dest,
        `name: ${name}\ndescription: ""\npersonas:\n${personas.map((p) => `  - ${p}`).join("\n")}\nrubric: ${opts.rubric}\n`,
        "utf-8",
      );
      console.log(`Created ${dest}`);
    });

  council
    .command("add <name> <persona>")
    .description("Add a persona to a user council")
    .action((name: string, personaName: string) => {
      const roots = cwdRoots();
      const p = councilPath(name, roots);
      if (!p || !editablePath(p, roots)) {
        fail(
          `Council '${name}' is packaged or missing — create a user copy first: ` +
            `quorable council new ${name}-custom --personas ...`,
        );
      }
      if (!personaPath(personaName, roots)) fail(`Unknown persona '${personaName}'.`);
      const c = loadCouncil(name, roots);
      if (c.personas.includes(personaName)) fail(`${personaName} is already in ${name}.`);
      const updated = { ...c, personas: [...c.personas, personaName] };
      fs.writeFileSync(
        p,
        `name: ${updated.name}\ndescription: "${updated.description}"\npersonas:\n${updated.personas.map((x) => `  - ${x}`).join("\n")}\nrubric: ${updated.rubric}\n`,
        "utf-8",
      );
      console.log(`Added ${personaName} to ${name}.`);
    });

  council
    .command("remove <name> <persona>")
    .description("Remove a persona from a user council")
    .action((name: string, personaName: string) => {
      const roots = cwdRoots();
      const p = councilPath(name, roots);
      if (!p || !editablePath(p, roots)) {
        fail(`Council '${name}' is packaged or missing — only user or project councils can be edited.`);
      }
      const c = loadCouncil(name, roots);
      if (!c.personas.includes(personaName)) fail(`${personaName} is not in ${name}.`);
      const personas = c.personas.filter((x) => x !== personaName);
      if (personas.length === 0) fail("A council needs at least one persona.");
      fs.writeFileSync(
        p,
        `name: ${c.name}\ndescription: "${c.description}"\npersonas:\n${personas.map((x) => `  - ${x}`).join("\n")}\nrubric: ${c.rubric}\n`,
        "utf-8",
      );
      console.log(`Removed ${personaName} from ${name}.`);
    });

  // --- init -----------------------------------------------------------------
  program
    .command("init")
    .description("Scaffold a project: quorable.yaml + golden/ skeleton in the current directory")
    .action(() => {
      const cwd = process.cwd();
      const configPath = path.join(cwd, "quorable.yaml");
      if (fs.existsSync(configPath)) {
        console.log("quorable.yaml already exists — skipping.");
      } else {
        fs.writeFileSync(
          configPath,
          [
            "# quorable project configuration — overrides ~/.quorable/config.yaml.",
            "# Layering, later wins: defaults -> home -> this file -> env -> flags.",
            "# Inspect the result any time with `quorable config show`.",
            "",
            "council: general-doc",
            "rigor: standard",
            "",
            "# --- Models -------------------------------------------------------------",
            "# Anything set here overrides your global defaults for this project only.",
            "# Ids may be bare (OpenRouter), provider-qualified (anthropic:, openai:),",
            "# or endpoint-qualified using a name from providers.endpoints below.",
            "",
            "# models:",
            "#   reviewers:",
            "#     - id: anthropic/claude-sonnet-4.6",
            "#     - id: openai/gpt-5.4",
            "#     - id: google/gemini-3.5-flash",
            "#   synthesizer: {id: anthropic/claude-sonnet-4.6, temperature: 0.1}",
            "#   held_out: {id: x-ai/grok-4.3}   # keep cross-vendor vs every reviewer",
            "",
            "# --- Providers ----------------------------------------------------------",
            "# Name any OpenAI-compatible endpoint and address it as <name>:<model-id>.",
            "# Local servers need no key; hosted ones read api_key_env from the process",
            "# env or ~/.quorable/.env — never commit a literal key here.",
            "",
            "# providers:",
            "#   endpoints:",
            "#     lmstudio:",
            "#       base_url: http://localhost:1234/v1",
            "#       # LM Studio ids look like google/gemma-4-26b — treat that prefix as",
            "#       # the vendor so agreement statistics count independent raters.",
            "#       vendor_from_model_id: true",
            "#     ollama:",
            "#       base_url: http://localhost:11434/v1",
            "#     together:",
            "#       base_url: https://api.together.xyz/v1",
            "#       api_key_env: TOGETHER_API_KEY",
            "#       vendor_from_model_id: true",
            "",
            "# Local models default to ONE shared 'local' vendor bucket, because",
            "# self-hosted variants of the same family share blind spots and would",
            "# inflate κ/ICC. Declare a vendor per model when the families really do",
            "# differ:",
            "#   reviewers:",
            "#     - {id: ollama:qwen2.5:latest, vendor: qwen}",
            "#     - {id: ollama:llama3.3:70b,  vendor: meta}",
            "",
            "# --- Pipeline -----------------------------------------------------------",
            "# pipeline:",
            "#   cost_threshold: 20.0   # per run; abort at threshold × multiplier",
            "#   max_concurrency: 1     # one local server serializes anyway",
            "#   timeout_seconds: 900   # local reasoning models are slow",
            "",
          ].join("\n"),
          "utf-8",
        );
        console.log(`Created ${configPath}`);
      }
      const goldenDir = path.join(cwd, "golden");
      const goldenManifest = path.join(goldenDir, "manifest.yaml");
      if (!fs.existsSync(goldenManifest)) {
        fs.mkdirSync(goldenDir, { recursive: true });
        fs.writeFileSync(
          goldenManifest,
          [
            "# Golden set: documents with KNOWN seeded defects + one clean negative",
            "# control (+ optionally `known: good|bad` real documents for the",
            "# discrimination test). Run `quorable golden` after ANY prompt,",
            "# persona, or gate change.",
            "",
            "cases: []",
            "#  - id: seeded_case_1",
            "#    path: seeded_case_1.md",
            "#    defects:",
            "#      - id: overlength",
            "#        detector: word_count      # a rubric gate name",
            '#        expect: "words"',
            "#  - id: clean_control",
            "#    path: clean_control.md",
            "#    negative_control: true",
            "#  - id: accepted_2024",
            "#    path: accepted_2024.md",
            "#    known: good",
            "",
          ].join("\n"),
          "utf-8",
        );
        console.log(`Created ${goldenManifest}`);
      }
      console.log("\nNext: `quorable review <file>` — or edit quorable.yaml first.");
    });
}
