import { describe, expect, test } from "bun:test";
import { forbiddenOf, formatHit, mask, parseConfig, scanPath, scanText, sha256 } from "./forbidden";

// Test-only made-up words; never real forbidden terms.
const WORD = "zorblax";
const OTHER = "quux";
const SET = forbiddenOf(WORD);
const lines = (text: string) => scanText("f.md", text, SET).map((h) => h.line);

test("sha256 is the standard hex digest", () => {
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

describe("parseConfig", () => {
  const entry = { sha256: sha256(WORD), length: 7 };
  test("groups hashes by length and lowercases them", () => {
    const f = parseConfig({ terms: [{ ...entry, sha256: entry.sha256.toUpperCase() }] });
    expect([...f.keys()]).toEqual([7]);
    expect(f.get(7)?.has(entry.sha256)).toBe(true);
  });
  test("an empty list is valid and checks nothing", () => {
    expect(parseConfig({ terms: [] }).size).toBe(0);
  });
  test.each([
    ["the old flat list", { sha256: [entry.sha256] }],
    ["null", null],
    ["a bare hash", { terms: [entry.sha256] }],
    ["a short hash", { terms: [{ ...entry, sha256: "abc" }] }],
    ["a missing length", { terms: [{ sha256: entry.sha256 }] }],
    ["a zero length", { terms: [{ ...entry, length: 0 }] }],
    ["a fractional length", { terms: [{ ...entry, length: 6.5 }] }],
    ["a string length", { terms: [{ ...entry, length: "7" }] }],
  ])("rejects %s", (_name, config) => {
    expect(() => parseConfig(config)).toThrow();
  });
});

describe("scanText", () => {
  test("clean text passes", () => {
    expect(lines("hello world\nconst x = 1;\nzorbla x zorbl-a")).toEqual([]);
  });
  test("catches a term in code and Markdown with the right line", () => {
    expect(lines(`a\nconst x = "${WORD}";\n# ${WORD} notes`)).toEqual([2, 3]);
  });
  test("catches mixed case", () => {
    expect(lines("ZoRbLaX")).toEqual([1]);
    expect(lines("ZORBLAX")).toEqual([1]);
  });
  test.each([
    "zorblaxs",
    "xzorblax",
    "ZorblaxDesktop",
    "zorblaxdesktop",
    "thezorblaxproject",
    "Zorblaxes",
    "zorblax2",
    "getZorblaxClient",
  ])("catches the term embedded in the longer word %s", (word) => {
    expect(lines(`see ${word} here`)).toEqual([1]);
  });
  test.each(["zor-blax", "zor_blax", "zor.blax", "Zor--Blax", "my_zorblax_id", "pkg.zorblax.io"])(
    "catches the term across separators in %s",
    (word) => {
      expect(lines(word)).toEqual([1]);
    },
  );
  test("does not join across spaces or other punctuation (documented limit)", () => {
    expect(lines("zor blax, zor/blax, zor'blax, zor+blax")).toEqual([]);
  });
  test("joined chunks do not run into the next word", () => {
    expect(lines("zor-bla x")).toEqual([]);
    expect(lines("a.zor b_lax")).toEqual([]);
  });
  test("checks every configured length", () => {
    const both = forbiddenOf(WORD, OTHER);
    expect(scanText("f", "aquuxb", both).map((h) => h.hash)).toEqual([sha256(OTHER)]);
    expect(scanText("f", "zorblaxy", both).map((h) => h.hash)).toEqual([sha256(WORD)]);
  });
  test("reports every distinct term on a line, each once", () => {
    const both = forbiddenOf(WORD, OTHER);
    const hits = scanText("f", `${WORD} ${OTHER} ${WORD}s x${OTHER}`, both);
    expect(hits.map((h) => h.hash)).toEqual([sha256(WORD), sha256(OTHER)]);
    expect(hits.map((h) => h.line)).toEqual([1, 1]);
  });
  test("does not match on a different hash or the wrong length", () => {
    expect(scanText("f", WORD, forbiddenOf("other"))).toEqual([]);
    const wrongLength = parseConfig({ terms: [{ sha256: sha256(WORD), length: 6 }] });
    expect(scanText("f", WORD, wrongLength)).toEqual([]);
  });
  test("report names file and line, never the term", () => {
    const [hit] = scanText("docs/a.md", `x\n${WORD}`, SET);
    const msg = formatHit(hit as NonNullable<typeof hit>);
    expect(msg).toContain("docs/a.md:2");
    expect(msg).toContain(sha256(WORD).slice(0, 8));
    expect(msg.toLowerCase()).not.toContain(WORD);
  });
});

describe("paths", () => {
  test("mask hides every character of every term, separators inside it included", () => {
    expect(mask("docs/Zorblax-notes/zor_blax.md", SET)).toBe("docs/*******-notes/********.md");
    expect(mask("docs/plain.md", SET)).toBe("docs/plain.md");
  });
  test("scanPath reports a masked path with line 0", () => {
    expect(scanPath("a/b.md", SET)).toEqual([]);
    const hits = scanPath("apps/xZorblaxy/x.ts", SET);
    expect(hits).toEqual([{ path: "apps/x*******y/x.ts", line: 0, hash: sha256(WORD) }]);
    const msg = formatHit(hits[0] as NonNullable<(typeof hits)[0]>);
    expect(msg).toContain("apps/x*******y/x.ts (file path)");
    expect(msg.toLowerCase()).not.toContain(WORD);
  });
});
