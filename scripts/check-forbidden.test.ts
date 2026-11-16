// End-to-end tests for scripts/check-forbidden.ts: each case copies the checker into a
// fresh temporary git repository, tracks a few files and runs it there.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "./forbidden";

// Test-only made-up word, absent from the two copied scripts.
const WORD = "vexmor";
const CONFIG = { terms: [{ sha256: sha256(WORD), length: WORD.length }] };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Opts = { git?: boolean; deleteAfterAdd?: string[] };

function run(
  files: Record<string, string | Uint8Array>,
  config: unknown = CONFIG,
  opts: Opts = {},
) {
  const root = mkdtempSync(join(tmpdir(), "hearth-forbidden-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts"));
  for (const name of ["check-forbidden.ts", "forbidden.ts"]) {
    copyFileSync(join(import.meta.dir, name), join(root, "scripts", name));
  }
  const configText = typeof config === "string" ? config : JSON.stringify(config);
  writeFileSync(join(root, "scripts", "forbidden-terms.json"), configText);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(root), // never find a repo above the temp dir
  };
  if (opts.git !== false) {
    for (const cmd of [
      ["git", "init", "-q"],
      ["git", "add", "-A"],
    ]) {
      expect(Bun.spawnSync(cmd, { cwd: root, env }).exitCode).toBe(0);
    }
  }
  for (const path of opts.deleteAfterAdd ?? []) rmSync(join(root, path));
  const p = Bun.spawnSync([process.execPath, "scripts/check-forbidden.ts"], { cwd: root, env });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("check-forbidden.ts", () => {
  test("a clean repo passes silently", () => {
    expect(run({ "README.md": "hello\n" })).toEqual({ code: 0, out: "", err: "" });
  });

  test("a hit in a file fails with file and line, never the term", () => {
    const r = run({ "docs/a.md": "ok\nthe Vexmorproject notes\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("forbidden: docs/a.md:2 contains a forbidden term");
    expect(r.err).toContain(sha256(WORD).slice(0, 8));
    expect(r.err.toLowerCase()).not.toContain(WORD);
  });

  test("a hit in a file path fails with the path masked", () => {
    const r = run({ "docs/vexmor-notes/a.md": `${WORD}\n` });
    expect(r.code).toBe(1);
    expect(r.err).toContain("forbidden: docs/******-notes/a.md (file path) contains");
    expect(r.err).toContain("forbidden: docs/******-notes/a.md:1 contains");
    expect(r.err.toLowerCase()).not.toContain(WORD);
  });

  test("hits are listed sorted by path, then line", () => {
    const r = run({ "b/vexmor.md": "clean\n", "a.md": `x\n${WORD}\n${WORD}\n` });
    expect(r.code).toBe(1);
    expect(r.err.trim().split("\n")).toEqual([
      expect.stringContaining("forbidden: a.md:2 "),
      expect.stringContaining("forbidden: a.md:3 "),
      expect.stringContaining("forbidden: b/******.md (file path) "),
    ]);
  });

  test("a tracked file deleted from the working tree is skipped", () => {
    const r = run({ "gone.md": "clean\n", "README.md": "clean\n" }, CONFIG, {
      deleteAfterAdd: ["gone.md"],
    });
    expect(r).toEqual({ code: 0, out: "", err: "" });
  });

  test("outside a git repository it fails", () => {
    const r = run({ "README.md": "clean\n" }, CONFIG, { git: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("forbidden: git ls-files failed");
  });

  test("bun.lock files and binary files are not read", () => {
    const binary = new Uint8Array([0, ...new TextEncoder().encode(` ${WORD}\n`)]);
    const r = run({
      "bun.lock": `${WORD}\n`,
      "apps/x/bun.lock": `${WORD}\n`,
      "img.png": binary,
      "README.md": "clean\n",
    });
    expect(r).toEqual({ code: 0, out: "", err: "" });
  });

  test("a text file whose name only ends in bun.lock is still read", () => {
    expect(run({ "notbun.lock": `${WORD}\n` }).code).toBe(1);
  });

  test.each([
    ["invalid JSON", "{"],
    ["the old flat format", { sha256: [sha256(WORD)] }],
    ["an entry without a length", { terms: [{ sha256: sha256(WORD) }] }],
  ])("a malformed config (%s) fails", (_name, config) => {
    const r = run({ "README.md": "clean\n" }, config);
    expect(r.code).toBe(1);
    // One clean line, not a crash with a stack trace.
    expect(r.err.trim().split("\n")).toEqual([
      expect.stringContaining("forbidden: bad config scripts/forbidden-terms.json: "),
    ]);
  });

  test("an empty term list passes with a warning", () => {
    const r = run({ "README.md": `${WORD}\n` }, { terms: [] });
    expect(r.code).toBe(0);
    expect(r.err).toContain("forbidden: warning:");
  });
});
