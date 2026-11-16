import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  configDrift,
  configVars,
  declaresTest,
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
    expect(isShippedCode("bun.lock")).toBe(false);
    expect(isShippedCode("apps/hub/bun.lock")).toBe(false);
    expect(isShippedCode(".github/workflows/ci.yml")).toBe(false);
  });

  test("shipped code includes .json files, root and nested", () => {
    expect(isShippedCode("package.json")).toBe(true);
    expect(isShippedCode("apps/hub/package.json")).toBe(true);
    expect(isShippedCode("apps/hub/src/testdata/x.json")).toBe(false);
    const json = [{ path: "package.json", text: '{"scripts":{"x":"HEARTH_J=1 bun x"}}' }];
    expect(configDrift(readmeConfigRows(README), json, json)).toContain(
      "HEARTH_J (package.json) is not in the README configuration table",
    );
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
| Three | 0003 | \`z.ts\` (a script check)<br>\`x.test.ts\` "first" |
| Four | 0004 | \`x.test.ts\` "first"<br>\`w.ts\` (a script check) |
`;

describe("docs/ARCHITECTURE.md invariants table", () => {
  test("reads each file and test name of a row", () => {
    expect(invariantRefs(ARCH)).toEqual([
      { promise: "One", file: "x.test.ts", test: "first" },
      { promise: "One", file: "x.test.ts", test: "second" },
      { promise: "One", file: "y.test.ts", test: "third" },
      { promise: "Two", file: "", test: "" },
      { promise: "Three", file: "z.ts", test: "" },
      { promise: "Three", file: "x.test.ts", test: "first" },
      { promise: "Four", file: "x.test.ts", test: "first" },
      { promise: "Four", file: "w.ts", test: "" },
    ]);
  });

  test("a missing file, a missing test name and a row without a test are drift", () => {
    const files: Record<string, string> = { "x.test.ts": 'test("first", () => {});' };
    expect(invariantDrift(invariantRefs(ARCH), (path) => files[path])).toEqual([
      'invariant "One": x.test.ts has no test "second"',
      'invariant "One": no file y.test.ts',
      'invariant "Two" names no test',
      'invariant "Three": no file z.ts',
      'invariant "Four": no file w.ts',
    ]);
    files["z.ts"] = "check();";
    expect(invariantDrift(invariantRefs(ARCH), (path) => files[path])).not.toContain(
      'invariant "Three": no file z.ts',
    );
  });

  test("a test name must be declared exactly, not as a substring or in a comment", () => {
    const text = [
      'test("first thing happens", () => {});',
      '// test("second") was renamed',
      "it('third', () => {});",
      'const label = "fourth";',
    ].join("\n");
    expect(declaresTest(text, "first thing happens")).toBe(true);
    expect(declaresTest(text, "first")).toBe(false);
    expect(declaresTest(text, "thing happens")).toBe(false);
    expect(declaresTest(text, "fourth")).toBe(false);
    expect(declaresTest(text, "second")).toBe(false);
    expect(declaresTest(`/*\n * test("block")\n */`, "block")).toBe(false);
    expect(
      declaresTest('  describe("g", () => {\n    test("indented", fn);\n  });', "indented"),
    ).toBe(true);
    expect(declaresTest('test("a.b (c)", fn)', "a.b (c)")).toBe(true);
    expect(declaresTest('test("axb (c)", fn)', "a.b (c)")).toBe(false);
    expect(declaresTest("it('third', fn)", "third")).toBe(true);
    expect(declaresTest('test(\n  "on the next line",\n  fn)', "on the next line")).toBe(true);
    expect(declaresTest("test('root\\'s box', fn)", "root's box")).toBe(true);
    const files = { "x.test.ts": text };
    const refs = [{ promise: "P", file: "x.test.ts", test: "first" }];
    expect(invariantDrift(refs, (path) => files[path as "x.test.ts"])).toEqual([
      'invariant "P": x.test.ts has no test "first"',
    ]);
  });

  test("a template that is mostly placeholders cannot be cited, so it never matches an unrelated name", () => {
    const text = "  test(`${frame.type} ${JSON.stringify(frame)}`, () => {});\n";
    expect(declaresTest(text, "file streams take workspace-relative paths")).toBe(false);
    expect(declaresTest(text, "a b")).toBe(false);
    // A short literal is not enough either: `${name} is never shown` would match any "x is never shown".
    expect(declaresTest("  test(`${a} is ${b}`, fn)", "anything is anywhere")).toBe(false);
    // Enough literal text keeps a template citable.
    const cited =
      "  test(`${path}: every directive is exactly the one 0017 justifies`, () => {});\n";
    expect(declaresTest(cited, "/: every directive is exactly the one 0017 justifies")).toBe(true);
  });

  test("a modifier, a describe and a template literal declare a name too", () => {
    expect(declaresTest('test.skipIf(me === 0)("skipped as root", fn)', "skipped as root")).toBe(
      true,
    );
    expect(
      declaresTest('test.skipIf(Bun.which("rg") === null)(\n  "needs rg",\n  fn)', "needs rg"),
    ).toBe(true);
    expect(declaresTest('test.each([1, 2])(\n  "seed %p", fn)', "seed %p")).toBe(true);
    expect(declaresTest('test.only("focused", fn)', "focused")).toBe(true);
    expect(declaresTest('describe("a group", () => {})', "a group")).toBe(true);
    expect(declaresTest('xtest("not a test", fn)', "not a test")).toBe(false);

    const built = "  test(`${path}: every directive holds`, fn)";
    expect(declaresTest(built, "/: every directive holds")).toBe(true);
    expect(declaresTest(built, "/index.html: every directive holds")).toBe(true);
    expect(declaresTest(built, ": every directive holds")).toBe(false);
    expect(declaresTest(built, "every directive holds")).toBe(false);
    expect(declaresTest(built, "/: every directive holds, mostly")).toBe(false);
    expect(declaresTest(built, "/: every directive")).toBe(false);
    expect(declaresTest("test(`${a} (x) answers it ${b}`, fn)", "1 (x) answers it 2")).toBe(true);
    expect(declaresTest("test(`${a} (x) answers it ${b}`, fn)", "1 yxy answers it 2")).toBe(false);
    expect(declaresTest("test(`a box ${x} b answers`, fn)", "a box 1 b answers")).toBe(true);
    expect(declaresTest("test(`a box ${x} b answers`, fn)", "za box 1 b answers")).toBe(false);
    expect(declaresTest("test(`plain`, fn)", "plain")).toBe(true);
    expect(declaresTest("// test(`${p}: in a comment`, fn)", "/: in a comment")).toBe(false);
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
