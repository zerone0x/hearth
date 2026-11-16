/**
 * Pure helpers of the browser tools: turning Playwright's refs into
 * generation refs, capping snapshot text, picking lines for `browser.find`,
 * and reading a JPEG's size.
 */

import { formatBrowserRef, MAX_FIND_LINE_LENGTH } from "@hearth/protocol";

const PLAYWRIGHT_REF = /\[ref=((?:f[0-9]+)?e[0-9]+)\]/g;

/** Prefixes every `[ref=…]` of a snapshot with its generation: `[ref=e5]` → `[ref=s3e5]`. */
export function tagRefs(text: string, generation: number): string {
  return text.replace(
    PLAYWRIGHT_REF,
    (_, local: string) => `[ref=${formatBrowserRef(generation, local)}]`,
  );
}

export interface CappedText {
  readonly text: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/** The marker that ends a snapshot cut at `keptBytes` of `totalBytes`. */
export function snapshotCutMarker(
  keptBytes: number,
  totalBytes: number,
  path: string | null,
): string {
  const where = path === null ? "" : `; the whole snapshot is in the box at ${path}`;
  return (
    `\n[hearth: snapshot cut at ${keptBytes} of ${totalBytes} bytes${where}. ` +
    "Use browser_find, or browser_snapshot with a ref or a depth, to see the rest.]"
  );
}

/**
 * Keeps the head of `text` within `maxBytes` UTF-8 bytes, cut at a line end
 * (or inside the first line when it alone is longer). The caller appends the
 * marker; `maxBytes` is for the text without it.
 */
export function capText(text: string, maxBytes: number): CappedText {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, totalBytes: bytes.length, truncated: false };
  // Cut on a character boundary: back off over UTF-8 continuation bytes.
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--;
  let head = bytes.subarray(0, end).toString("utf8");
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > 0) head = head.slice(0, lastNewline);
  return { text: head, totalBytes: bytes.length, truncated: true };
}

/** Lines of `text` matching `match`, trimmed of their indent and cut to a sane length. */
export function findLines(
  text: string,
  match: (line: string) => boolean,
  max: number,
): { readonly lines: string[]; readonly matches: number } {
  const lines: string[] = [];
  let matches = 0;
  for (const raw of text.split("\n")) {
    if (!match(raw)) continue;
    matches++;
    if (lines.length >= max) continue;
    const line = raw.trimStart();
    lines.push(
      line.length > MAX_FIND_LINE_LENGTH ? `${line.slice(0, MAX_FIND_LINE_LENGTH)} […]` : line,
    );
  }
  return { lines, matches };
}

/** Width and height from a JPEG's first start-of-frame segment, or `undefined`. */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < data.length) {
    if (data[at] !== 0xff) return undefined;
    const marker = data[at + 1] as number;
    if (marker === 0xff) {
      at++;
      continue;
    }
    const length = data.readUInt16BE(at + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}
