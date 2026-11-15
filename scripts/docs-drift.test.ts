import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  configDrift,
  configVars,
  invariantDrift,
  invariantRefs,
  isShippedCode,
  readmeConfigRows,
  type SourceFile,
} from "./docs-drift";

const root = join(import.meta.dir, "..");

/** Every tracked file outside the docs, read from the working tree. */
function trackedFiles(): SourceFile[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "" && !path.endsWith(".md") && path !== "bun.lock")
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

const README = `# X

## Configuration

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| \`HEARTH_A\` | \`1\` | \`a.ts\` | a |
| \`OTEL_B\` | unset | \`a.ts\`, \`b.sh\` | b |

## Layout

| \`HEARTH_C\` | | \`a.ts\` | not in the configuration section |
`;

describe("README configuration table", () => {
  test("reads the variables and files of the Configuration section only", () => {
    expect(readmeConfigRows(README)).toEqual([
      { vars: ["HEARTH_A"], files: ["a.ts"] },
      { vars: ["OTEL_B"], files: ["a.ts", "b.sh"] },
    ]);
  });

  test("finds variables, not template prefixes", () => {
    const vars = configVars([
      { path: "a.ts", text: 'env["HEARTH_A"]; env[`OTEL_X_${s}_Y`]; "HEARTH_"; OTEL_B' },
    ]);
    expect([...vars.keys()].sort()).toEqual(["HEARTH_A", "OTEL_B"]);
  });

  test("shipped code excludes tests, test data, e2e harnesses and docs", () => {
    expect(isShippedCode("apps/hub/src/main.ts")).toBe(true);
    expect(isShippedCode("apps/box-agent/image/entrypoint.sh")).toBe(true);
    expect(isShippedCode("deploy/compose.yaml")).toBe(true);
    expect(isShippedCode("apps/hub/src/main.test.ts")).toBe(false);
    expect(isShippedCode("apps/web/src/web.dom.tsx")).toBe(false);
    expect(isShippedCode("apps/box-agent/src/testdata/stream-agent.ts")).toBe(false);
    expect(isShippedCode("deploy/e2e/prototype.ts")).toBe(false);
    expect(isShippedCode("docs/install.md")).toBe(false);
    expect(isShippedCode(".github/workflows/ci.yml")).toBe(false);
  });

  test("a variable the code reads and the table lacks is drift", () => {
    const code = [{ path: "a.ts", text: 'env["HEARTH_A"]; env["HEARTH_NEW"]; OTEL_B' }];
    const both = [...code, { path: "b.sh", text: "$OTEL_B" }];
    expect(configDrift(readmeConfigRows(README), code, both)).toEqual([
      "HEARTH_NEW (a.ts) is not in the README configuration table",
    ]);
  });

  test("a row whose variable is gone, or whose file does not mention it, is drift", () => {
    const files = [
      { path: "a.ts", text: "OTEL_B" },
      { path: "b.sh", text: "" },
    ];
    expect(configDrift(readmeConfigRows(README), files, files)).toEqual([
      "HEARTH_A is in the README configuration table but nowhere in the repo",
      "README row HEARTH_A: a.ts does not mention it",
      "README row OTEL_B: b.sh does not mention it",
    ]);
  });

  test("a row with an empty Read by cell is drift", () => {
    const readme = `## Configuration

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| \`HEARTH_A\` | \`1\` |  | a |
`;
    const files = [{ path: "a.ts", text: 'env["HEARTH_A"]' }];
    expect(configDrift(readmeConfigRows(readme), files, files)).toEqual([
      "README row HEARTH_A names no file that reads it",
    ]);
  });

  test("lists every variable the code reads, each with a file that reads it", () => {
    const files = trackedFiles();
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const rows = readmeConfigRows(readme);
    const shipped = files.filter((f) => isShippedCode(f.path));
    expect(rows.length).toBeGreaterThan(40);
    expect(configVars(shipped).size).toBeGreaterThan(40);
    expect(configDrift(rows, shipped, files)).toEqual([]);
  });
});

const ARCH = `# A

## Invariants and tests

| Promise | Decisions | Guarded by |
| --- | --- | --- |
| One | 0001 | \`x.test.ts\` "first"; "second"<br>\`y.test.ts\` "third" |
| Two | 0002 | nothing named |
`;

describe("docs/ARCHITECTURE.md invariants table", () => {
  test("reads each file and test name of a row", () => {
    expect(invariantRefs(ARCH)).toEqual([
      { promise: "One", file: "x.test.ts", test: "first" },
      { promise: "One", file: "x.test.ts", test: "second" },
      { promise: "One", file: "y.test.ts", test: "third" },
      { promise: "Two", file: "", test: "" },
    ]);
  });

  test("a missing file, a missing test name and a row without a test are drift", () => {
    const files: Record<string, string> = { "x.test.ts": 'test("first", () => {});' };
    expect(invariantDrift(invariantRefs(ARCH), (path) => files[path])).toEqual([
      'invariant "One": x.test.ts has no test "second"',
      'invariant "One": no file y.test.ts',
      'invariant "Two" names no test',
    ]);
  });

  test("no table is drift", () => {
    expect(invariantDrift(invariantRefs("# A\n"), () => "")).toEqual([
      "docs/ARCHITECTURE.md has no invariants table",
    ]);
  });

  test("every row names a test file that exists and a test that is in it", () => {
    const arch = readFileSync(join(root, "docs/ARCHITECTURE.md"), "utf8");
    const refs = invariantRefs(arch);
    expect(refs.length).toBeGreaterThan(12);
    const read = (path: string) =>
      existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined;
    expect(invariantDrift(refs, read)).toEqual([]);
  });
});
