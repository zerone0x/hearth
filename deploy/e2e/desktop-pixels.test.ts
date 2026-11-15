import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktopProblem, desktopStats, START_PAGE_ACCENT } from "./desktop-pixels";

/** `n` samples of one colour. */
function fill(n: number, rgb: readonly [number, number, number]): number[] {
  return Array.from({ length: n }, () => [...rgb]).flat();
}

describe("desktop pixel check (#92)", () => {
  test("a black desktop fails: the empty desktop the issue reported", () => {
    const problem = desktopProblem(desktopStats(fill(16_000, [0, 0, 0])));
    expect(problem).toContain("one colour: #000000 covers 100.0%");
  });

  test("a bare background with a cursor fails: no browser", () => {
    const pixels = [...fill(15_990, [0x3b, 0x4a, 0x5c]), ...fill(10, [255, 255, 255])];
    expect(desktopProblem(desktopStats(pixels))).toContain("one colour: #3b4a5c");
  });

  test("a drawn desktop without the start page fails", () => {
    const pixels = [
      ...fill(8_000, [255, 255, 255]),
      ...fill(6_000, [0xde, 0xe1, 0xe6]),
      ...fill(2_000, [0x20, 0x21, 0x24]),
    ];
    expect(desktopProblem(desktopStats(pixels))).toContain("start page is not on the desktop");
  });

  test("the browser on its start page passes, also with lossy colours", () => {
    const [r, g, b] = START_PAGE_ACCENT;
    const pixels = [
      ...fill(1_600, [0xde, 0xe1, 0xe6]),
      ...fill(1_000, [r - 20, g + 15, b + 30]),
      ...fill(900, [r, g, b]),
      ...fill(12_000, [0xf7, 0xf4, 0xef]),
      ...fill(500, [0x1f, 0x29, 0x33]),
    ];
    const stats = desktopStats(pixels);
    expect(stats.accentShare).toBeCloseTo(1_900 / 16_000);
    expect(desktopProblem(stats)).toBeNull();
  });

  test("the accent is the start page's header colour", () => {
    const page = readFileSync(
      join(import.meta.dir, "../../apps/box-agent/image/start.html"),
      "utf8",
    );
    const hex = START_PAGE_ACCENT.map((c) => c.toString(16).padStart(2, "0")).join("");
    expect(page).toContain(`header { background: #${hex};`);
  });

  test("no samples is a failure, not a pass", () => {
    expect(desktopProblem(desktopStats([]))).toBe("no pixels were sampled");
  });
});
