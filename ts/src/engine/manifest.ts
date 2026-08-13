/**
 * Manifest model + parsing, ported from manifest.py, plus the auto-manifest
 * used by zero-config `quorable review` (Blocker 2 in the plan): the target
 * file becomes the tier-1 primary and `--context` directories glob into
 * tier-2 entries routed to stage1. A hand-written manifest still wins when
 * present.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

export interface ManifestEntry {
  name: string;
  path: string;
  format: string;
  role: string;
  tier: 1 | 2 | 3;
  sendTo: string[];
  critical: boolean;
  notes: string;
}

/** A parsed input document ready for inclusion in LLM prompts. */
export interface DocumentModel {
  name: string;
  role: string;
  tier: number;
  content: string;
  pageCount: number;
  charCount: number;
  sha256: string;
  truncated: boolean;
}

const FORMAT_BY_EXT: Record<string, string> = {
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".docx": "docx",
};

export function guessFormat(p: string): string {
  return FORMAT_BY_EXT[path.extname(p).toLowerCase()] ?? "markdown";
}

interface RawEntry {
  path: string;
  format?: string;
  role?: string;
  tier?: number;
  send_to?: string[];
  critical?: boolean;
  notes?: string;
}

function isEntryDict(val: unknown): val is RawEntry {
  return typeof val === "object" && val !== null && "path" in val;
}

function parseSingle(raw: RawEntry, inputsDir: string, fallbackName: string): ManifestEntry {
  const absPath = path.resolve(inputsDir, raw.path);
  return {
    name: fallbackName,
    path: absPath,
    format: raw.format ?? guessFormat(raw.path),
    role: raw.role ?? "",
    tier: (raw.tier ?? 1) as 1 | 2 | 3,
    sendTo: raw.send_to ?? [],
    critical: raw.critical ?? false,
    notes: raw.notes ?? "",
  };
}

function parseList(items: unknown[], inputsDir: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const item of items) {
    if (!isEntryDict(item)) continue;
    const name = path.parse(item.path).name;
    entries.push(parseSingle(item, inputsDir, name));
  }
  return entries;
}

/**
 * Parse a manifest YAML into a flat entry list. Sections are free-form: any
 * top-level key may hold a single entry, a dict of named entries, a list of
 * entries, or a dict of named lists.
 */
export function loadManifest(manifestPath: string, inputsDir: string): ManifestEntry[] {
  const raw = parseYaml(fs.readFileSync(manifestPath, "utf-8")) as Record<
    string,
    unknown
  > | null;
  const entries: ManifestEntry[] = [];

  for (const [key, val] of Object.entries(raw ?? {})) {
    if (val === null || val === undefined) continue;
    if (isEntryDict(val)) {
      entries.push(parseSingle(val, inputsDir, key));
    } else if (typeof val === "object" && !Array.isArray(val)) {
      for (const [subKey, subVal] of Object.entries(val as Record<string, unknown>)) {
        if (subVal === null || subVal === undefined) continue;
        if (isEntryDict(subVal)) {
          entries.push(parseSingle(subVal, inputsDir, subKey));
        } else if (Array.isArray(subVal)) {
          entries.push(...parseList(subVal, inputsDir));
        }
      }
    } else if (Array.isArray(val)) {
      entries.push(...parseList(val, inputsDir));
    }
  }

  // Enforce that all critical files exist (fail loudly — the grant fork's
  // silent-skip defect is exactly what this guards against).
  for (const entry of entries) {
    if (entry.critical && !fs.existsSync(entry.path)) {
      throw new Error(
        `Critical document missing: ${entry.name} (${entry.path}). ` +
          `The pipeline cannot run without this file.`,
      );
    }
  }

  return entries;
}

/**
 * Declared-vs-loaded assertion (plan M9): every declared, existing manifest
 * entry must appear in the loaded document set — silently skipped context
 * poisons every downstream review.
 */
export function assertManifestLoaded(
  entries: ManifestEntry[],
  documents: Record<string, DocumentModel>,
): void {
  const missing = entries.filter((e) => fs.existsSync(e.path) && !(e.name in documents));
  if (missing.length > 0) {
    throw new Error(
      `Manifest declared ${missing.length} document(s) that failed to load: ` +
        missing.map((e) => e.name).join(", ") +
        ". Refusing to run with silently missing context.",
    );
  }
}

const CONTEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".yaml",
  ".yml",
  ".docx",
]);

/**
 * Build an auto-manifest for zero-config review: the target file is the
 * tier-1 primary (critical, never truncated); each --context directory is
 * globbed (recursively) into tier-2 entries routed to stage1 + stage2.
 */
export function autoManifest(
  targetPath: string,
  contextDirs: string[] = [],
  opts: { primaryName?: string } = {},
): ManifestEntry[] {
  const primaryName = opts.primaryName ?? "primary_document";
  const entries: ManifestEntry[] = [
    {
      name: primaryName,
      path: path.resolve(targetPath),
      format: guessFormat(targetPath),
      role: "Primary document under review",
      tier: 1,
      sendTo: ["stage1", "stage2", "stage3"],
      critical: true,
      notes: "",
    },
  ];

  const seen = new Set<string>([path.resolve(targetPath)]);
  for (const dir of contextDirs) {
    for (const file of walkFiles(path.resolve(dir))) {
      if (!CONTEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      const base = path.parse(file).name;
      let name = base;
      let suffix = 2;
      while (entries.some((e) => e.name === name)) {
        name = `${base}_${suffix++}`;
      }
      entries.push({
        name,
        path: file,
        format: guessFormat(file),
        role: `Context document (${path.relative(dir, file) || path.basename(file)})`,
        tier: 2,
        sendTo: ["stage1", "stage2"],
        critical: false,
        notes: "",
      });
    }
  }
  return entries;
}

function* walkFiles(dir: string): Generator<string> {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const sorted = items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sorted) {
    if (item.name.startsWith(".")) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      yield* walkFiles(full);
    } else if (item.isFile()) {
      yield full;
    }
  }
}
