/**
 * Size caps for the text a trajectory keeps (decision 0021): user prompts,
 * model output (text, thinking, tool-call arguments) and tool results.
 *
 * Every text is redacted first, then capped at `MAX_TEXT_BYTES` UTF-8 bytes,
 * cut back to a code-point boundary so a CJK character or an emoji is never
 * split. The record keeps the head, the full size in bytes and the sha256 of
 * the full (redacted) text, so a replay can tell whether it has the whole.
 */

import { createHash } from "node:crypto";

/** UTF-8 bytes of one text kept in the trajectory; the rest is summarized by size and hash. */
export const MAX_TEXT_BYTES = 16 * 1024;

export type Redact = (text: string) => string;

const identity: Redact = (text) => text;

export interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
  /** UTF-8 bytes of the full text. */
  readonly bytes: number;
  /** sha256 (hex) of the full text's UTF-8 bytes. */
  readonly sha256: string;
}

/**
 * The longest head of `text` that fits in `maxBytes` UTF-8 bytes and ends on a
 * code-point boundary.
 */
export function utf8Head(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // UTF-8 continuation bytes are 0b10xxxxxx: back off to the start of the cut character.
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** `raw`, redacted, capped at `max` UTF-8 bytes, with its full size and hash. */
export function capText(raw: string, redact: Redact = identity, max = MAX_TEXT_BYTES): CappedText {
  const text = redact(raw);
  const bytes = Buffer.byteLength(text, "utf8");
  const truncated = bytes > max;
  return {
    text: truncated ? utf8Head(text, max) : text,
    truncated,
    bytes,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

/** Every string in `value`, redacted (keys included); other JSON values as they are. */
export function redactDeep(value: unknown, redact: Redact): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        redact(k),
        redactDeep(v, redact),
      ]),
    );
  }
  return value;
}

/**
 * Tool-call arguments: the redacted value when its JSON fits in `max` bytes,
 * else `{truncated: true, bytes, sha256, text}` with the head of its JSON.
 */
export function capJson(value: unknown, redact: Redact = identity, max = MAX_TEXT_BYTES): unknown {
  if (value === undefined) return null;
  const redacted = redactDeep(value, redact);
  const json = JSON.stringify(redacted) ?? "null";
  if (Buffer.byteLength(json, "utf8") <= max) return redacted;
  return capText(json, identity, max);
}
