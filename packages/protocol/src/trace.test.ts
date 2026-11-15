import { describe, expect, test } from "bun:test";
import { decodeFrame, encodeFrame } from "./codec";
import type { RpcFrame } from "./frames";
import { formatTraceparent, parseTraceparent } from "./trace";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const GOOD = `00-${TRACE}-${SPAN}-01`;

describe("traceparent", () => {
  test("parses and formats a version-00 header", () => {
    expect(parseTraceparent(GOOD)).toEqual({ traceId: TRACE, spanId: SPAN, flags: 1 });
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, flags: 1 })).toBe(GOOD);
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, flags: 0 })).toBe(
      `00-${TRACE}-${SPAN}-00`,
    );
  });

  test("refuses malformed and all-zero ids", () => {
    for (const bad of [
      "",
      `01-${TRACE}-${SPAN}-01`,
      `00-${TRACE.toUpperCase()}-${SPAN}-01`,
      `00-${"0".repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${"0".repeat(16)}-01`,
      `00-${TRACE}-${SPAN}-01-extra`,
      `00-${TRACE.slice(1)}-${SPAN}-01`,
    ]) {
      expect(parseTraceparent(bad)).toBeUndefined();
    }
    expect(() => formatTraceparent({ traceId: "0".repeat(32), spanId: SPAN, flags: 1 })).toThrow();
  });

  test("an rpc frame carries it across the codec (protocol 1.2)", () => {
    const frame: RpcFrame = {
      type: "rpc",
      id: "tool_1",
      method: "tool.exists",
      params: { callId: "c", path: "/workspace" },
      traceparent: GOOD,
    };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded.ok && decoded.frame).toEqual(frame);
  });

  test("a malformed traceparent is dropped, the call still decodes", () => {
    const decoded = decodeFrame(
      JSON.stringify({ type: "rpc", id: "tool_1", method: "m", params: {}, traceparent: "nope" }),
    );
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && "traceparent" in decoded.frame).toBe(false);
  });

  test("a frame without one decodes as before (1.1 peer)", () => {
    const decoded = decodeFrame(
      JSON.stringify({ type: "rpc", id: "tool_1", method: "m", params: {} }),
    );
    expect(decoded.ok && decoded.frame).toEqual({
      type: "rpc",
      id: "tool_1",
      method: "m",
      params: {},
    });
  });
});
