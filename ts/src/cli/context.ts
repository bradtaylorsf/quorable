/**
 * Shared CLI plumbing: resolve config + council + pack + prompts for a
 * target, with provider settings from stored keys (env always wins).
 */

import path from "node:path";

import { effectiveKeys, quorableHome } from "../config/home.js";
import { loadConfig } from "../config/layering.js";
import {
  loadCouncil,
  loadPackagedPrompt,
  loadPersonaOverlay,
  rubricPath,
  type AssetRoots,
  type Council,
} from "../config/resolve.js";
import { RIGOR_PRESETS, type QuorableConfig, type RigorSettings, type RigorTier } from "../config/schema.js";
import { loadPackFromRubricFile } from "../pack/rubric.js";
import { PackError, type Pack } from "../pack/types.js";
import type { ProviderSettings } from "../providers/registry.js";

export interface ReviewFlags {
  council?: string;
  rubric?: string;
  rigor?: string;
  personas?: string[];
  models?: string[];
  out?: string;
  context?: string[];
}

export interface ResolvedContext {
  config: QuorableConfig;
  configSources: { layer: string; path: string | null }[];
  council: Council;
  personas: string[];
  personaOverlays: Record<string, string>;
  pack: Pack;
  rigor: RigorSettings;
  providerSettings: ProviderSettings;
  prompts: { system: string; synthesis: string; coldReader: string };
  roots: AssetRoots;
}

export function resolveContext(targetPath: string | null, flags: ReviewFlags): ResolvedContext {
  const home = quorableHome();
  const configFlags: Record<string, unknown> = {};
  if (flags.council) configFlags["council"] = flags.council;
  if (flags.rigor) configFlags["rigor"] = flags.rigor;
  if (flags.rubric) configFlags["rubric"] = flags.rubric;
  if (flags.personas && flags.personas.length > 0) configFlags["personas"] = flags.personas;
  if (flags.models && flags.models.length > 0) {
    configFlags["models"] = {
      reviewers: flags.models.map((id) => ({ id })),
    };
  }

  const { config, sources } = loadConfig({
    projectDir: targetPath ? path.dirname(path.resolve(targetPath)) : process.cwd(),
    flags: configFlags,
    home,
  });

  const roots: AssetRoots = { home };
  const council = loadCouncil(config.council, roots);
  const personas = config.personas.length > 0 ? config.personas : council.personas;
  const personaOverlays = Object.fromEntries(
    personas.map((p) => [p, loadPersonaOverlay(p, roots)]),
  );

  const rubricName = config.rubric ?? council.rubric;
  const rp = rubricPath(rubricName, roots);
  if (!rp) {
    throw new PackError(`Rubric '${rubricName}' not found`);
  }
  const pack = loadPackFromRubricFile(rp);

  const rigor = RIGOR_PRESETS[config.rigor as RigorTier];

  const providerSettings: ProviderSettings = {
    keys: effectiveKeys(home),
    localBaseUrl: config.providers.local_base_url ?? undefined,
    timeoutSeconds: config.pipeline.timeout_seconds,
    retryAttempts: config.pipeline.retry_attempts,
  };

  return {
    config,
    configSources: sources,
    council,
    personas,
    personaOverlays,
    pack,
    rigor,
    providerSettings,
    prompts: {
      system: loadPackagedPrompt("system_prompt"),
      synthesis: loadPackagedPrompt("synthesis"),
      coldReader: loadPackagedPrompt("cold_reader"),
    },
    roots,
  };
}

/** All model specs a review run may call (for the capability check). */
export function allModelSpecs(config: QuorableConfig, rigor: RigorSettings): string[] {
  const specs = config.models.reviewers.filter((r) => !r.held_out).map((r) => r.id);
  specs.push(config.models.synthesizer.id);
  if (rigor.heldOut) specs.push(config.models.held_out.id);
  return [...new Set(specs)];
}
