import { describe, expect, test } from "bun:test";
import { checkPins, type Manifest } from "./pins";

const m = (path: string, json: Manifest["json"]): Manifest => ({ path, json });

describe("checkPins", () => {
  test("accepts all pi packages on one exact version", () => {
    const report = checkPins(
      [
        m("a/package.json", { dependencies: { "@earendil-works/pi-ai": "1.5.2", hono: "^4" } }),
        m("b/package.json", { devDependencies: { "@earendil-works/pi-coding-agent": "1.5.2" } }),
      ],
      `"@earendil-works/pi-ai": ["@earendil-works/pi-ai@1.5.2", ...]`,
    );
    expect(report).toEqual({ version: "1.5.2", errors: [] });
  });

  test("rejects the frozen @mariozechner names in manifests and the lockfile", () => {
    const report = checkPins(
      [m("a/package.json", { dependencies: { "@mariozechner/pi-ai": "0.73.1" } })],
      `"@mariozechner/pi-ai": ["@mariozechner/pi-ai@0.73.1"]`,
    );
    expect(report.errors).toHaveLength(2);
    expect(report.errors[0]).toContain("a/package.json: dependencies.@mariozechner/pi-ai");
    expect(report.errors[1]).toContain("bun.lock");
  });

  test("rejects ranges", () => {
    for (const spec of ["^1.5.2", "~1.5.2", "latest", "1.5.x", ">=1.5.2"]) {
      const report = checkPins(
        [m("a/package.json", { dependencies: { "@earendil-works/pi-ai": spec } })],
        undefined,
      );
      expect(report.errors).toEqual([
        `a/package.json: dependencies.@earendil-works/pi-ai is "${spec}"; pi packages need an exact version`,
      ]);
    }
  });

  test("rejects pi packages pinned to different versions", () => {
    const report = checkPins(
      [
        m("a/package.json", { dependencies: { "@earendil-works/pi-ai": "1.5.2" } }),
        m("b/package.json", { dependencies: { "@earendil-works/pi-agent-core": "1.5.1" } }),
      ],
      undefined,
    );
    expect(report.version).toBeUndefined();
    expect(report.errors[0]).toContain("pinned to different versions");
  });

  test("rejects a lockfile that resolves pi to another version", () => {
    const report = checkPins(
      [m("a/package.json", { dependencies: { "@earendil-works/pi-ai": "1.5.2" } })],
      `"@earendil-works/pi-tui": ["@earendil-works/pi-tui@1.4.0"]`,
    );
    expect(report.errors).toEqual([
      "bun.lock: @earendil-works/pi-tui resolves to 1.4.0, expected 1.5.2",
    ]);
  });
});
