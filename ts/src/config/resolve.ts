/**
 * Persona / council / rubric resolution (plan M2/M7).
 *
 * Search order, nearest wins: project `.quorable/` directory (if the CLI
 * passes one) → user library `~/.quorable/{personas,councils,rubrics}` →
 * packaged assets shipped with the npm package. Councils reference persona
 * NAMES only (§5.4) — models stay a config concern.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { homePaths, quorableHome } from "./home.js";
import { PackError } from "../pack/types.js";

/** Locate the packaged assets directory (works from ts/src and dist). */
export function packagedAssetsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "assets");
    if (fs.existsSync(path.join(candidate, "councils"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("Packaged assets directory not found (broken install?)");
}

export const CouncilSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** Persona names only — never models (plan §5.4). */
  personas: z.array(z.string().min(1)).min(1),
  /** Default rubric for this council; config/flags can override. */
  rubric: z.string().min(1),
});

export type Council = z.infer<typeof CouncilSchema>;

export interface AssetRoots {
  /** Highest-precedence extra roots (e.g. a project's .quorable dir). */
  extra?: string[];
  home?: string;
}

function searchRoots(kind: "personas" | "councils" | "rubrics", roots: AssetRoots): string[] {
  const home = roots.home ?? quorableHome();
  const dirs = [
    ...(roots.extra ?? []).map((r) => path.join(r, kind)),
    homePaths(home)[kind],
    path.join(packagedAssetsDir(), kind),
  ];
  return dirs.filter((d) => fs.existsSync(d));
}

function findFile(
  kind: "personas" | "councils" | "rubrics",
  fileName: string,
  roots: AssetRoots,
): string | null {
  for (const dir of searchRoots(kind, roots)) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function listNames(
  kind: "personas" | "councils" | "rubrics",
  ext: string,
  roots: AssetRoots,
): string[] {
  const names = new Set<string>();
  for (const dir of searchRoots(kind, roots)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(ext)) names.add(file.slice(0, -ext.length));
    }
  }
  return [...names].sort();
}

// --- Personas ---------------------------------------------------------------

export function listPersonas(roots: AssetRoots = {}): string[] {
  return listNames("personas", ".md", roots);
}

export function personaPath(name: string, roots: AssetRoots = {}): string | null {
  return findFile("personas", `${name}.md`, roots);
}

export function loadPersonaOverlay(name: string, roots: AssetRoots = {}): string {
  const p = personaPath(name, roots);
  if (!p) {
    throw new PackError(
      `Persona '${name}' not found. Available: ${listPersonas(roots).join(", ")}`,
    );
  }
  return fs.readFileSync(p, "utf-8");
}

// --- Councils ---------------------------------------------------------------

export function listCouncils(roots: AssetRoots = {}): string[] {
  return listNames("councils", ".yaml", roots);
}

export function councilPath(name: string, roots: AssetRoots = {}): string | null {
  return findFile("councils", `${name}.yaml`, roots);
}

export function loadCouncil(name: string, roots: AssetRoots = {}): Council {
  const p = councilPath(name, roots);
  if (!p) {
    throw new PackError(
      `Council '${name}' not found. Available: ${listCouncils(roots).join(", ")}`,
    );
  }
  const parsed = CouncilSchema.safeParse(parseYaml(fs.readFileSync(p, "utf-8")));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new PackError(`Council file ${p} is invalid:\n${detail}`);
  }
  // Fail at load time if the council names personas that do not exist —
  // a missing lens must never be discovered mid-run.
  const missing = parsed.data.personas.filter((persona) => !personaPath(persona, roots));
  if (missing.length > 0) {
    throw new PackError(
      `Council '${name}' names missing persona(s): ${missing.join(", ")}. ` +
        `Available: ${listPersonas(roots).join(", ")}`,
    );
  }
  return parsed.data;
}

// --- Rubrics ----------------------------------------------------------------

export function listRubrics(roots: AssetRoots = {}): string[] {
  return listNames("rubrics", ".yaml", roots);
}

export function rubricPath(name: string, roots: AssetRoots = {}): string | null {
  return findFile("rubrics", `${name}.yaml`, roots);
}

// --- Prompts (packaged defaults; projects can override via extra roots) -----

export function loadPackagedPrompt(name: string): string {
  const p = path.join(packagedAssetsDir(), "prompts", `${name}.md`);
  if (!fs.existsSync(p)) {
    throw new Error(`Packaged prompt not found: ${p}`);
  }
  return fs.readFileSync(p, "utf-8");
}
