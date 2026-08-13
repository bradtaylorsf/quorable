/**
 * The interactive picker (plan §5.4) — sugar over config, never a second
 * system. On a TTY with no --council flag: pick council or cherry-pick
 * personas → confirm the model panel → pick rigor → cost estimate →
 * confirm. Every choice echoes its equivalent flags; --save writes the
 * result back as config.
 */

import * as clack from "@clack/prompts";

import { listCouncils, listPersonas, loadCouncil, type AssetRoots } from "../config/resolve.js";
import { RIGOR_TIERS, type RigorTier } from "../config/schema.js";
import { personaModelWarnings } from "../providers/types.js";

export interface PickerResult {
  council: string;
  personas: string[] | null; // null = council default
  rigor: RigorTier;
  models: string[] | null; // null = config default
  cancelled: boolean;
}

export function isInteractive(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

export async function runPicker(args: {
  roots: AssetRoots;
  defaultCouncil: string;
  defaultRigor: RigorTier;
  defaultModels: string[];
}): Promise<PickerResult> {
  const cancelled: PickerResult = {
    council: args.defaultCouncil,
    personas: null,
    rigor: args.defaultRigor,
    models: null,
    cancelled: true,
  };

  clack.intro("quorable review");

  const councils = listCouncils(args.roots);
  const councilChoice = await clack.select({
    message: "Which council reviews this document?",
    initialValue: args.defaultCouncil,
    options: councils.map((name) => {
      const council = loadCouncil(name, args.roots);
      return {
        value: name,
        label: name,
        hint: `${council.description} [${council.personas.join(", ")}]`,
      };
    }),
  });
  if (clack.isCancel(councilChoice)) return cancelled;
  const council = loadCouncil(councilChoice, args.roots);

  const cherryPick = await clack.confirm({
    message: `Use the full council (${council.personas.join(", ")})?`,
    initialValue: true,
  });
  if (clack.isCancel(cherryPick)) return cancelled;

  let personas: string[] | null = null;
  if (!cherryPick) {
    const personaChoice = await clack.multiselect({
      message: "Pick personas (space to toggle):",
      initialValues: council.personas,
      options: listPersonas(args.roots).map((p) => ({ value: p, label: p })),
      required: true,
    });
    if (clack.isCancel(personaChoice)) return cancelled;
    personas = personaChoice;
  }

  const rigorChoice = await clack.select({
    message: "Rigor tier?",
    initialValue: args.defaultRigor,
    options: [
      { value: "quick" as const, label: "quick", hint: "1 run, top-3 personas, no stats — fast sanity pass" },
      { value: "standard" as const, label: "standard", hint: "2 runs, full council, agreement stats + regressions" },
      { value: "rigorous" as const, label: "rigorous", hint: "adds held-out validation, golden pre-run, validation-task blocking" },
    ],
  });
  if (clack.isCancel(rigorChoice)) return cancelled;

  const modelsOk = await clack.confirm({
    message: `Reviewer panel: ${args.defaultModels.join(", ")} — keep?`,
    initialValue: true,
  });
  if (clack.isCancel(modelsOk)) return cancelled;

  let models: string[] | null = null;
  if (!modelsOk) {
    const modelInput = await clack.text({
      message: "Reviewer model ids (comma-separated, provider-qualified ok):",
      initialValue: args.defaultModels.join(", "),
      validate: (v) => (v.trim().length === 0 ? "At least one model" : undefined),
    });
    if (clack.isCancel(modelInput)) return cancelled;
    models = modelInput.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Statistical guardrail (§5.4): every persona effectively runs on the
  // whole panel here, so warn once about the panel itself.
  const effectivePersonas = personas ?? council.personas;
  const effectiveModels = models ?? args.defaultModels;
  const warnings = personaModelWarnings(
    Object.fromEntries(effectivePersonas.map((p) => [p, effectiveModels])),
  );
  const unique = [...new Set(warnings.map((w) => w.split(" — ")[1] ?? w))];
  if (unique.length > 0) {
    clack.log.warn(unique.join("\n"));
  }

  // Echo the equivalent flags — the picker is sugar, never a second system.
  const flagParts = [`--council ${councilChoice}`, `--rigor ${rigorChoice}`];
  if (personas) flagParts.push(...personas.map((p) => `--persona ${p}`));
  if (models) flagParts.push(...models.map((m) => `--model ${m}`));
  clack.log.info(`Equivalent flags: ${flagParts.join(" ")}`);

  return {
    council: councilChoice,
    personas,
    rigor: rigorChoice,
    models,
    cancelled: false,
  };
}

export async function confirmCostInteractive(perLoopUsd: number, threshold: number): Promise<boolean> {
  if (perLoopUsd <= threshold) return true;
  const proceed = await clack.confirm({
    message: `Estimated cost $${perLoopUsd.toFixed(2)} exceeds $${threshold.toFixed(2)}. Proceed?`,
    initialValue: false,
  });
  return !clack.isCancel(proceed) && proceed === true;
}

/** First-run wizard: no keys anywhere → prompt for an OpenRouter key. */
export async function firstRunKeyWizard(): Promise<string | null> {
  clack.intro("quorable — first run");
  clack.log.info(
    "No provider keys found. quorable needs at least an OpenRouter key " +
      "(one key, every vendor: https://openrouter.ai/keys).",
  );
  const key = await clack.password({
    message: "Paste your OpenRouter API key (stored in ~/.quorable/.env, chmod 600):",
    validate: (v) => (v.trim().length < 8 ? "That does not look like a key" : undefined),
  });
  if (clack.isCancel(key)) return null;
  return key.trim();
}
