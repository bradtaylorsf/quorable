import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/version.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "dist", "cli", "main.js");
const expected = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string }).version;

describe("version", () => {
  it("the library reports package.json's version", () => {
    expect(packageVersion()).toBe(expected);
  });
  it.skipIf(!fs.existsSync(CLI))("the built CLI reports package.json's version", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, "--version"]);
    expect(stdout.trim()).toBe(expected);
  });
});
