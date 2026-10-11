import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTree, DEFAULT_EXCLUDES, insideOrEqual, normalizeExcludes, sha256Path, textFiles, treeHash, walkTree } from "../src/engine/tree.js";

const dirs: string[] = [];
function temp(): string { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quorable-tree-"))); dirs.push(d); return d; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function project(): string {
  const dir = temp();
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.js"), "export const ok = false;\n");
  fs.writeFileSync(path.join(dir, "src", "lib", "util.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  return dir;
}

describe("tree snapshots", () => {
  it("walks sorted, skipping excluded names at any depth and symlinks", () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, "packages", "a", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages", "a", "node_modules", "x.js"), "x");
    fs.writeFileSync(path.join(dir, "packages", "a", "index.js"), "a");
    fs.symlinkSync(path.join(dir, "src", "app.js"), path.join(dir, "link.js"));
    expect(walkTree(dir).map((f) => f.rel)).toEqual(["logo.png", "packages/a/index.js", "src/app.js", "src/lib/util.js"]);
  });
  it("hashes content and paths deterministically; the hash ignores excluded output", () => {
    const dir = project(); const before = treeHash(dir);
    expect(treeHash(dir)).toBe(before);
    fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "changed");
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "changed");
    expect(treeHash(dir)).toBe(before);
    fs.writeFileSync(path.join(dir, "src", "app.js"), "export const ok = true;\n");
    expect(treeHash(dir)).not.toBe(before);
    const renamed = treeHash(dir); fs.renameSync(path.join(dir, "src", "app.js"), path.join(dir, "src", "main.js"));
    expect(treeHash(dir)).not.toBe(renamed);
    expect(sha256Path(dir)).toBe(treeHash(dir));
    expect(sha256Path(path.join(dir, "src", "main.js"))).toMatch(/^[a-f0-9]{64}$/);
  });
  it("honours custom exclusions and rejects path-like ones", () => {
    const dir = project(); fs.mkdirSync(path.join(dir, "generated")); fs.writeFileSync(path.join(dir, "generated", "big.js"), "g");
    expect(walkTree(dir, [...DEFAULT_EXCLUDES, "generated"]).map((f) => f.rel)).not.toContain("generated/big.js");
    expect(normalizeExcludes(["dist"])).toContain(".git");
    expect(() => normalizeExcludes(["src/gen"])).toThrow(/bare names/);
  });
  it("lists only text files as quotable evidence", () => {
    const dir = project();
    const files = textFiles(dir).map((f) => path.relative(dir, f.path));
    expect(files).toEqual(["src/app.js", "src/lib/util.js"]);
  });
  it("copies without symlinks or excluded names, preserving executable bits", () => {
    const dir = project(); fs.chmodSync(path.join(dir, "src", "app.js"), 0o755);
    fs.symlinkSync("/etc", path.join(dir, "escape"));
    const dest = path.join(temp(), "copy");
    expect(copyTree(dir, dest)).toBe(3);
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "escape"))).toBe(false);
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(false);
    expect(fs.statSync(path.join(dest, "src", "app.js")).mode & 0o111).toBeTruthy();
    expect(treeHash(dest)).toBe(treeHash(dir));
    expect(() => copyTree(dir, dest)).toThrow(/already exists/);
  });
  it("judges containment without prefix confusion", () => {
    expect(insideOrEqual("/a/b/c", "/a/b")).toBe(true);
    expect(insideOrEqual("/a/b", "/a/b")).toBe(true);
    expect(insideOrEqual("/a/bc", "/a/b")).toBe(false);
    expect(insideOrEqual("/a", "/a/b")).toBe(false);
  });
});
