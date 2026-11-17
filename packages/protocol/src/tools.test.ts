import { describe, expect, test } from "bun:test";
import {
  classifyToolError,
  decodeFrame,
  decodeToolParams,
  decodeToolResult,
  encodeFrame,
  execEnvNameProblem,
  FS_DEADLINE_MS,
  isLiveOutputStreamId,
  LIVE_OUTPUT_STREAM_BASE,
  MAX_EXEC_ENV_NAME_LENGTH,
  MAX_EXEC_ENV_VALUE_LENGTH,
  MAX_EXEC_ENV_VARS,
  MAX_EXEC_TIMEOUT_MS,
  MUTATING_TOOL_METHODS,
  PROTOCOL_VERSION,
  SEARCH_TIMEOUT_MS,
  supportsExecEnv,
  TOOL_DEADLINE_GRACE_MS,
  TOOL_ERRORS,
  TOOL_METHODS,
  toolDeadlineMs,
  truncationMarker,
} from "./index";

describe("tool RPC", () => {
  test("is a minor bump of protocol 1 (1.1; traceparent made it 1.2; browser methods 1.3; live exec output 1.4; secret fill 1.5; exec env 1.6)", () => {
    expect(PROTOCOL_VERSION).toEqual({ major: 1, minor: 6 });
  });

  test("exec env (1.6): checked names and non-empty values; a failure never quotes a value", () => {
    const params = { callId: "call_1", command: "env", cwd: "/workspace", timeoutMs: 1000 };
    expect(decodeToolParams("tool.exec", { ...params, env: { GH_TOKEN: "tok-1" } })).toEqual({
      ok: true,
      value: { ...params, env: { GH_TOKEN: "tok-1" } },
    });
    expect(decodeToolParams("tool.exec", params)).toEqual({ ok: true, value: params });
    const value = "do-not-echo-this-value";
    const bad: unknown[] = [
      {},
      [],
      "GH_TOKEN=x",
      { gh_token: value },
      { "GH-TOKEN": value },
      { "1TOKEN": value },
      { PATH: value },
      { LD_PRELOAD: value },
      { BASH_ENV: value },
      { BASH_FUNC_x: value },
      { HEARTH_EXEC: value },
      { GIT_SSH_COMMAND: value },
      { GH_TOKEN: "" },
      { GH_TOKEN: 7 },
      { GH_TOKEN: `${value}\u0000` },
      { GH_TOKEN: "x".repeat(MAX_EXEC_ENV_VALUE_LENGTH + 1) },
      { [`A${"B".repeat(MAX_EXEC_ENV_NAME_LENGTH)}`]: value },
      Object.fromEntries(
        Array.from({ length: MAX_EXEC_ENV_VARS + 1 }, (_, i) => [`TOKEN_${i}`, value]),
      ),
    ];
    for (const env of bad) {
      const decoded = decodeToolParams("tool.exec", { ...params, env } as never);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.message).not.toContain(value);
    }
  });

  test("execEnvNameProblem: the pattern minus the reserved names and prefixes", () => {
    for (const ok of ["GH_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "A", "X1"]) {
      expect(execEnvNameProblem(ok)).toBeUndefined();
    }
    for (const no of [
      "",
      "gh_token",
      "_X",
      "9X",
      "A-B",
      "A B",
      "PATH",
      "HOME",
      "IFS",
      "LD_X",
      "LC_ALL",
      "DYLD_X",
      "XDG_X",
      "NODE_OPTIONS",
      "PWD",
      "PS4",
      "PROMPT_COMMAND",
    ]) {
      expect(execEnvNameProblem(no)).toBeDefined();
    }
  });

  test("supportsExecEnv: only a 1.6+ box of major 1", () => {
    expect(supportsExecEnv(undefined)).toBe(false);
    expect(supportsExecEnv({ major: 1, minor: 5 })).toBe(false);
    expect(supportsExecEnv({ major: 1, minor: 6 })).toBe(true);
    expect(supportsExecEnv({ major: 1, minor: 9 })).toBe(true);
    expect(supportsExecEnv({ major: 2, minor: 6 })).toBe(false);
  });

  test("exec may name a live output stream (1.4); only an even id in the live range", () => {
    const params = { callId: "c", command: "x", cwd: ".", timeoutMs: 1000 };
    const ok = decodeToolParams("tool.exec", {
      ...params,
      outputStream: LIVE_OUTPUT_STREAM_BASE + 2,
    });
    expect(ok).toEqual({
      ok: true,
      value: { ...params, outputStream: LIVE_OUTPUT_STREAM_BASE + 2 },
    });
    // Without the field the box answers once, as a 1.3 box does.
    expect(decodeToolParams("tool.exec", params)).toEqual({ ok: true, value: params });
    for (const bad of [
      2, // a desktop bridge id
      LIVE_OUTPUT_STREAM_BASE - 2,
      LIVE_OUTPUT_STREAM_BASE + 1, // odd: the box's range
      2 ** 32,
      "2147483650",
      1.5,
    ]) {
      expect(decodeToolParams("tool.exec", { ...params, outputStream: bad }).ok).toBe(false);
    }
    expect(isLiveOutputStreamId(LIVE_OUTPUT_STREAM_BASE)).toBe(true);
    expect(isLiveOutputStreamId(2 ** 32 - 2)).toBe(true);
    expect(isLiveOutputStreamId(LIVE_OUTPUT_STREAM_BASE - 2)).toBe(false);
    expect(isLiveOutputStreamId(LIVE_OUTPUT_STREAM_BASE + 3)).toBe(false);
    expect(isLiveOutputStreamId(2 ** 32)).toBe(false);
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
