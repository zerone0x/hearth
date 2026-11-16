import { describe, expect, test } from "bun:test";
import { formatVersion, isCompatible, PROTOCOL_VERSION } from "./index";

describe("protocol version", () => {
  test("accepts the same major with any minor", () => {
    expect(isCompatible({ major: 1, minor: 0 }, { major: 1, minor: 3 })).toBe(true);
    expect(isCompatible({ major: 1, minor: 7 }, { major: 1, minor: 0 })).toBe(true);
  });

  test("rejects a different major", () => {
    expect(isCompatible({ major: 2, minor: 0 }, { major: 1, minor: 0 })).toBe(false);
    expect(isCompatible({ major: 0, minor: 9 }, { major: 1, minor: 0 })).toBe(false);
  });

  test("defaults to this build's version", () => {
    expect(isCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(formatVersion(PROTOCOL_VERSION)).toBe("1.4");
  });
});
