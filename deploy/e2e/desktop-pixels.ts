/**
 * What the compose e2e reads off the box desktop (#92): pixels sampled from the
 * noVNC canvas, as flat `[r, g, b, r, g, b, ...]`.
 *
 * A desktop that is one colour (black: nothing painted, or the bare background:
 * no browser) is not a desktop the owner can use, so the e2e asks for two
 * things: no single colour covers more than `MAX_DOMINANT_SHARE` of the
 * samples, and the start page's accent band (`START_PAGE_ACCENT`, the header of
 * apps/box-agent/image/start.html) covers at least `MIN_ACCENT_SHARE`, which
 * only Chromium drawing that page puts there.
 */

/** The header colour of the box's start page, `#d9480f`. */
export const START_PAGE_ACCENT: readonly [number, number, number] = [0xd9, 0x48, 0x0f];
/** Per-channel tolerance for the accent: noVNC may receive lossy (JPEG) tiles. */
export const ACCENT_TOLERANCE = 40;
export const MAX_DOMINANT_SHARE = 0.95;
export const MIN_ACCENT_SHARE = 0.02;

export interface DesktopStats {
  readonly samples: number;
  readonly distinct: number;
  /** The most common exact colour, as `#rrggbb`, and its share of the samples. */
  readonly dominant: string;
  readonly dominantShare: number;
  readonly accentShare: number;
}

export function desktopStats(rgb: ArrayLike<number>): DesktopStats {
  const counts = new Map<number, number>();
  let accent = 0;
  const samples = Math.floor(rgb.length / 3);
  for (let i = 0; i < samples; i++) {
    const r = rgb[i * 3] ?? 0;
    const g = rgb[i * 3 + 1] ?? 0;
    const b = rgb[i * 3 + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (
      Math.abs(r - START_PAGE_ACCENT[0]) <= ACCENT_TOLERANCE &&
      Math.abs(g - START_PAGE_ACCENT[1]) <= ACCENT_TOLERANCE &&
      Math.abs(b - START_PAGE_ACCENT[2]) <= ACCENT_TOLERANCE
    ) {
      accent++;
    }
  }
  let dominant = 0;
  let dominantCount = 0;
  for (const [key, count] of counts) {
    if (count > dominantCount) {
      dominant = key;
      dominantCount = count;
    }
  }
  return {
    samples,
    distinct: counts.size,
    dominant: `#${dominant.toString(16).padStart(6, "0")}`,
    dominantShare: samples === 0 ? 1 : dominantCount / samples,
    accentShare: samples === 0 ? 0 : accent / samples,
  };
}

/** Why the desktop does not look drawn, or null when it does. */
export function desktopProblem(stats: DesktopStats): string | null {
  if (stats.samples === 0) return "no pixels were sampled";
  if (stats.dominantShare > MAX_DOMINANT_SHARE) {
    return `the desktop is one colour: ${stats.dominant} covers ${(stats.dominantShare * 100).toFixed(1)}% of ${stats.samples} samples`;
  }
  if (stats.accentShare < MIN_ACCENT_SHARE) {
    return `the browser's start page is not on the desktop: its accent covers ${(stats.accentShare * 100).toFixed(1)}% of ${stats.samples} samples`;
  }
  return null;
}
