import { describe, expect, test } from "bun:test";
import {
  classifyToolError,
  decodeFrame,
  decodeToolParams,
  decodeToolResult,
  encodeFrame,
  FS_DEADLINE_MS,
  MAX_EXEC_TIMEOUT_MS,
  MUTATING_TOOL_METHODS,
  PROTOCOL_VERSION,
  SEARCH_TIMEOUT_MS,
  TOOL_DEADLINE_GRACE_MS,
  TOOL_ERRORS,
  TOOL_METHODS,
  toolDeadlineMs,
  truncationMarker,
} from "./index";

describe("tool RPC", () => {
  test("is a minor bump of protocol 1", () => {
    expect(PROTOCOL_VERSION).toEqual({ major: 1, minor: 1 });
  });

  test("exec params never carry an environment", () => {
    const decoded = decodeToolParams("tool.exec", {
      callId: "call_1",
      command: "env",
      cwd: "/workspace",
      timeoutMs: 1000,
      env: { SECRET: "hub" },
    });
    expect(decoded).toEqual({
      ok: true,
      value: { callId: "call_1", command: "env", cwd: "/workspace", timeoutMs: 1000 },
    });
  });

  test("params are checked: call id, paths, limits", () => {
    const bad = [
      ["tool.readFile", { path: "a" }],
      ["tool.readFile", { callId: "c", path: "" }],
      ["tool.readFile", { callId: "c", path: "a\u0000b" }],
      ["tool.exec", { callId: "c", command: "x", cwd: ".", timeoutMs: MAX_EXEC_TIMEOUT_MS + 1 }],
      ["tool.glob", { callId: "c", pattern: "*", cwd: ".", ignore: [1], limit: 1 }],
      [
        "tool.grep",
        {
          callId: "c",
          pattern: "x",
          path: ".",
          ignoreCase: false,
          literal: false,
          context: 0,
          limit: 0,
        },
      ],
      ["tool.cancel", { callId: "c", target: "has space" }],
    ] as const;
    for (const [method, params] of bad) {
      expect(decodeToolParams(method, params).ok).toBe(false);
    }
  });

  test("results are checked", () => {
    expect(
      decodeToolResult("tool.exec", {
        outcome: "exited",
        exitCode: 0,
        output: "x",
        truncatedBytes: 0,
        fullOutputPath: null,
      }).ok,
    ).toBe(true);
    expect(
      decodeToolResult("tool.exec", {
        outcome: "lost",
        exitCode: 0,
        output: "",
        truncatedBytes: 0,
        fullOutputPath: null,
      }).ok,
    ).toBe(false);
    expect(decodeToolResult("tool.stat", { isDirectory: true }).ok).toBe(false);
  });

  test("tool calls travel as ordinary rpc frames", () => {
    const frame = {
      type: "rpc" as const,
      id: "tool_1",
      method: "tool.readFile",
      params: { callId: "c", path: "a.txt" },
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
  });

  test("each call has a named deadline from its own budget", () => {
    const exec = { callId: "c", command: "x", cwd: ".", timeoutMs: 42_000 };
    expect(toolDeadlineMs("tool.exec", exec)).toBe(42_000 + TOOL_DEADLINE_GRACE_MS);
    expect(toolDeadlineMs("tool.readFile", { callId: "c", path: "a" })).toBe(FS_DEADLINE_MS);
    expect(
      toolDeadlineMs("tool.grep", {
        callId: "c",
        pattern: "x",
        path: ".",
        ignoreCase: false,
        literal: false,
        context: 0,
        limit: 1,
      }),
    ).toBe(SEARCH_TIMEOUT_MS + TOOL_DEADLINE_GRACE_MS);
  });

  test("errors are classified; a lost read may be retried, a lost write may not", () => {
    for (const code of Object.keys(TOOL_ERRORS)) {
      expect(classifyToolError(code, "tool.readFile").owner).toBeDefined();
    }
    expect(classifyToolError("tool.outcome-unknown", "tool.exec")).toEqual({
      owner: "box",
      disposition: "give-up",
    });
    expect(classifyToolError("tool.outcome-unknown", "tool.stat")).toEqual({
      owner: "box",
      disposition: "retry",
    });
    expect(classifyToolError("tool.path-escape", "tool.readFile")).toEqual({
      owner: "user",
      disposition: "give-up",
    });
    expect(classifyToolError("made-up", "tool.readFile")).toEqual({
      owner: "box",
      disposition: "give-up",
    });
    expect([...MUTATING_TOOL_METHODS].every((m) => TOOL_METHODS.includes(m))).toBe(true);
  });

  test("the truncation marker names the omitted bytes and the spill file", () => {
    expect(truncationMarker(10)).toBe("[hearth: 10 bytes of earlier output omitted]\n");
    expect(truncationMarker(10, "/workspace/.hearth/exec/a.log")).toContain(
      "/workspace/.hearth/exec/a.log",
    );
  });
});
