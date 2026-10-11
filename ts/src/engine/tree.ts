/**
 * Artifact snapshot primitives. A candidate can be a single text file or a
 * whole directory (a repository, a project, a folder of derived evidence).
 * Integrity is git-free: a directory's identity is a sha256 over the sorted
 * (relative path, file sha256) pairs of every non-excluded regular file.
 * Symlinks are never followed, copied, or hashed.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface SourceVersion {
  path: string;
  sha256: string;
  /** Directory sources record the exclusion list their hash was computed with. */
  excludes?: string[];
  /** Optional VCS commit holding this version (candidate directories). */
  commit?: string;
}

/** Directory and file *names* skipped at any depth. Dependency and build output, never source. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", "dist", "build", ".next", "target", "coverage", ".turbo", ".cache",
];

export interface TreeFile { rel: string; path: string; size: number; mode: number }

export function normalizeExcludes(excludes?: readonly string[]): string[] {
  const set = new Set<string>(excludes ?? DEFAULT_EXCLUDES);
  set.add(".git"); // the candidate's own version store is never part of its identity
  for (const name of set) {
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new Error(`Exclusions are bare names, not paths: '${name}'`);
    }
  }
  return [...set].sort();
}

/** Every regular file under dir, sorted by relative path. Excluded names and symlinks are skipped. */
export function walkTree(dir: string, excludes?: readonly string[]): TreeFile[] {
  const skip = new Set(normalizeExcludes(excludes));
  const out: TreeFile[] = [];
  const visit = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(childAbs, childRel);
      else if (entry.isFile()) {
        const stat = fs.statSync(childAbs);
        out.push({ rel: childRel, path: childAbs, size: stat.size, mode: stat.mode });
      }
    }
  };
  visit(dir, "");
  return out;
}

export function fileSha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Identity of a directory's contents. Stable across machines for identical trees. */
export function treeHash(dir: string, excludes?: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of walkTree(dir, excludes)) hash.update(`${file.rel}\0${fileSha256(file.path)}\n`);
  return hash.digest("hex");
}

/** sha256 of a file, or the tree hash of a directory. */
export function sha256Path(target: string, excludes?: readonly string[]): string {
  return fs.statSync(target).isDirectory() ? treeHash(target, excludes) : fileSha256(target);
}

export function isTextBuffer(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0);
}

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** Quotable evidence surface: every non-excluded text file (no NUL bytes, size-capped), realpath'd. */
export function textFiles(dir: string, excludes?: readonly string[], maxBytes = MAX_TEXT_FILE_BYTES): SourceVersion[] {
  const out: SourceVersion[] = [];
  for (const file of walkTree(dir, excludes)) {
    if (file.size > maxBytes) continue;
    const content = fs.readFileSync(file.path);
    if (!isTextBuffer(content)) continue;
    out.push({ path: fs.realpathSync(file.path), sha256: createHash("sha256").update(content).digest("hex") });
  }
  return out;
}

/** Copy a tree without symlinks or excluded names. dest must not exist. Modes are preserved. */
export function copyTree(src: string, dest: string, excludes?: readonly string[]): number {
  if (fs.existsSync(dest)) throw new Error(`Copy destination already exists: ${dest}`);
  fs.mkdirSync(dest, { recursive: true });
  const files = walkTree(src, excludes);
  for (const file of files) {
    const target = path.join(dest, ...file.rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.path, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, file.mode & 0o777);
  }
  return files.length;
}

/** True when child is parent or lies inside it (both already resolved). */
export function insideOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
