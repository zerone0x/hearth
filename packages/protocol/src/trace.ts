/**
 * W3C Trace Context `traceparent` (https://www.w3.org/TR/trace-context/),
 * carried on tool `rpc` frames since protocol 1.2 (decision 0021), so the box's
 * log lines for a call share the hub's trace id. Pure string handling, no I/O.
 */

/** The parsed parts of a `traceparent`. */
export interface TraceParent {
  /** 32 lowercase hex characters, not all zero. */
  readonly traceId: string;
  /** 16 lowercase hex characters, not all zero: the caller's span. */
  readonly spanId: string;
  /** The trace flags byte; bit 0 is "sampled". */
  readonly flags: number;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** Longest `traceparent` the codec accepts (version 00 is exactly 55 characters). */
export const TRACEPARENT_LENGTH = 55;

/**
 * Parse a version-00 `traceparent`. Returns `undefined` for anything else,
 * including the all-zero ids the spec calls invalid.
 */
export function parseTraceparent(value: string): TraceParent | undefined {
  const m = TRACEPARENT.exec(value);
  if (m === null) return undefined;
  const [, traceId, spanId, flags] = m as unknown as [string, string, string, string];
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return { traceId, spanId, flags: Number.parseInt(flags, 16) };
}

/** Format a version-00 `traceparent`. Throws on ids `parseTraceparent` would refuse. */
export function formatTraceparent(parent: TraceParent): string {
  const flags = (parent.flags & 0xff).toString(16).padStart(2, "0");
  const text = `00-${parent.traceId}-${parent.spanId}-${flags}`;
  if (parseTraceparent(text) === undefined) {
    throw new Error(`not a valid trace context: ${text}`);
  }
  return text;
}
