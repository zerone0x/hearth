import { describe, expect, test } from "bun:test";
import { assertNever } from "./index";

type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };

function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.r * shape.r;
    case "square":
      return shape.side * shape.side;
    default:
      return assertNever(shape, "shape");
  }
}

describe("assertNever", () => {
  test("is unreachable for handled variants", () => {
    expect(area({ kind: "square", side: 3 })).toBe(9);
  });

  test("throws and names the unexpected value when a variant slips through", () => {
    const bogus = { kind: "triangle" } as unknown as Shape;
    expect(() => area(bogus)).toThrow('Unexpected shape: {"kind":"triangle"}');
  });
});
