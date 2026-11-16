import { describe, expect, test } from "bun:test";
import { formatHit, scanText, sha256, tokens } from "./forbidden";

// Test-only made-up word; never a real forbidden term.
const WORD = "zorblax";
const SET: ReadonlySet<string> = new Set([sha256(WORD)]);
const lines = (text: string) => scanText("f.md", text, SET).map((h) => h.line);

test("sha256 is the standard hex digest", () => {
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

describe("tokens", () => {
  test("splits camelCase, snake_case, kebab-case and dotted forms", () => {
    expect(tokens("fooBar")).toContain("bar");
    expect(tokens("foo_bar")).toEqual(["foo", "foo", "bar", "bar"]);
    expect(tokens("foo-bar.baz")).toEqual(["foo", "foo", "bar", "bar", "baz", "baz"]);
    expect(tokens("HTTPServer2")).toEqual(["httpserver2", "http", "server", "2"]);
  });
  test("keeps the whole alphanumeric run", () => {
    expect(tokens("fooBar")).toContain("foobar");
  });
});

describe("scanText", () => {
  test("clean text passes", () => {
    expect(lines("hello world\nconst x = 1;")).toEqual([]);
  });
  test("catches a term in code and Markdown with the right line", () => {
    expect(lines(`a\nconst x = "${WORD}";\n# ${WORD} notes`)).toEqual([2, 3]);
  });
  test("catches mixed case", () => {
    expect(lines("ZoRbLaX")).toEqual([1]);
    expect(lines("ZORBLAX")).toEqual([1]);
  });
  test("catches the term inside camelCase, snake_case, kebab-case and dotted identifiers", () => {
    expect(lines("getZorblaxClient")).toEqual([1]);
    expect(lines("my_zorblax_id")).toEqual([1]);
    expect(lines("my-zorblax-id")).toEqual([1]);
    expect(lines("pkg.zorblax.io")).toEqual([1]);
  });
  test("catches the term in a digit-suffixed run but not as a substring of a longer word", () => {
    expect(lines("zorblax2")).toEqual([1]);
    expect(lines("xzorblaxy")).toEqual([]);
  });
  test("catches a joined multi-part term as a whole run", () => {
    const joined: ReadonlySet<string> = new Set([sha256("zorblaxquux")]);
    expect(scanText("f", "zorBlax_Quux zorblaxQuux", joined)).toHaveLength(1);
    expect(scanText("f", "zorblax-quux", joined)).toHaveLength(0);
  });
  test("does not match on a different hash", () => {
    expect(scanText("f", WORD, new Set([sha256("other")]))).toEqual([]);
  });
  test("report names file and line, never the term", () => {
    const [hit] = scanText("docs/a.md", `x\n${WORD}`, SET);
    const msg = formatHit(hit as NonNullable<typeof hit>);
    expect(msg).toContain("docs/a.md:2");
    expect(msg).toContain(sha256(WORD).slice(0, 8));
    expect(msg.toLowerCase()).not.toContain(WORD);
  });
});
