/**
 * Extension allowlist (decision 0015): the runner's own extension names are
 * reserved, so an allowlisted extension cannot take their place. That
 * includes `hearth-trace`, the trajectory observer (decision 0021).
 */

import { describe, expect, test } from "bun:test";
import { type PinnedExtension, RESERVED_EXTENSION_NAMES, selectExtensions } from "./extensions";

function ext(name: string, version = "1.0.0"): PinnedExtension {
  return { name, version, factory: () => {} };
}

describe("selectExtensions", () => {
  test("the runner's own names are reserved, even when allowlisted at the right version", () => {
    const names = ["hearth-tools", "hearth-access", "codemode", "hearth-trace"];
    expect([...RESERVED_EXTENSION_NAMES].sort()).toEqual([...names].sort());
    const result = selectExtensions(
      names.map((n) => ext(n)),
      names.map((name) => ({ name, version: "1.0.0" })),
    );
    expect(result.loaded).toEqual([]);
    expect(result.refused).toEqual(names.map((name) => ({ name, reason: "reserved name" })));
  });

  test("an allowlisted extension at its pinned version loads; others are refused with a reason", () => {
    const result = selectExtensions(
      [ext("a"), ext("b", "2.0.0"), ext("c")],
      [
        { name: "a", version: "1.0.0" },
        { name: "b", version: "1.0.0" },
      ],
    );
    expect(result.loaded.map((e) => e.name)).toEqual(["a"]);
    expect(result.refused).toEqual([
      { name: "b", reason: "allowlist pins 1.0.0, hub has 2.0.0" },
      { name: "c", reason: "not in the allowlist" },
    ]);
  });
});
