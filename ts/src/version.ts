/**
 * The package version, read from package.json at runtime so the CLI can never
 * drift from the published version. Walks up from this module because the
 * compiled file (dist/version.js) and the source (ts/src/version.ts) sit at
 * different depths below the package root.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function packageVersion(): string {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "quorable" && typeof pkg.version === "string") return (cached = pkg.version);
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cached = "0.0.0-unknown");
}
