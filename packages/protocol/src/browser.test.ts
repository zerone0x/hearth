import { describe, expect, test } from "bun:test";
import {
  BROWSER_METHODS,
  browserBudgetMs,
  checkHelloVersion,
  classifyToolError,
  DEFAULT_EXPECT_TIMEOUT_MS,
  decodeFrame,
  decodeToolParams,
  decodeToolResult,
  encodeFrame,
  formatBrowserRef,
  isBrowserMethod,
  isCompatible,
  isToolMethod,
  MAX_EXPECT_TIMEOUT_MS,
  MAX_SNAPSHOT_TEXT_BYTES,
  MUTATING_TOOL_METHODS,
  PROTOCOL_VERSION,
  parseBrowserRef,
  TOOL_DEADLINE_GRACE_MS,
  TOOL_ERRORS,
  TOOL_METHODS,
  toolDeadlineMs,
} from "./index";

const snapshot = {
  snapshotId: "s3",
  text: '- button "Save" [ref=s3e2]',
  totalBytes: 26,
  truncated: false,
  fullSnapshotPath: null,
};

const action = {
  tab: 0,
  url: "http://127.0.0.1:8000/",
  title: "Form",
  ok: true,
  outcome: "done",
  message: null,
  verified: true,
  dialogs: [],
  snapshot,
};

describe("browser methods (protocol 1.3)", () => {
  test("are tool methods, so they ride the tool RPC (ids, deadlines, classification)", () => {
    for (const method of BROWSER_METHODS) {
      expect(isToolMethod(method)).toBe(true);
      expect(isBrowserMethod(method)).toBe(true);
      expect(TOOL_METHODS).toContain(method);
    }
    expect(isBrowserMethod("tool.exec")).toBe(false);
    expect(isBrowserMethod("browser.fill")).toBe(false);
  });

  test("acting methods are mutating, observing ones are not", () => {
    for (const m of [
      "browser.navigate",
      "browser.click",
      "browser.type",
      "browser.select",
      "browser.press",
      "browser.tabs",
    ]) {
      expect(MUTATING_TOOL_METHODS.has(m as never)).toBe(true);
    }
    for (const m of ["browser.snapshot", "browser.find", "browser.wait", "browser.screenshot"]) {
      expect(MUTATING_TOOL_METHODS.has(m as never)).toBe(false);
    }
    // A lost click may have landed; a lost snapshot may be retried.
    expect(classifyToolError("tool.outcome-unknown", "browser.click").disposition).toBe("give-up");
    expect(classifyToolError("tool.outcome-unknown", "browser.snapshot").disposition).toBe("retry");
    expect(classifyToolError("browser.unavailable", "browser.snapshot").disposition).toBe("retry");
    expect(classifyToolError("browser.unavailable", "browser.click").disposition).toBe("give-up");
    expect(TOOL_ERRORS["browser.stale-ref"].owner).toBe("user");
  });

  test("a 1.2 peer is still compatible; the box answers what it does not know as unknown-method", () => {
    expect(PROTOCOL_VERSION).toEqual({ major: 1, minor: 3 });
    expect(isCompatible({ major: 1, minor: 2 })).toBe(true);
    expect(isCompatible({ major: 2, minor: 0 })).toBe(false);
    expect(checkHelloVersion({ version: { major: 1, minor: 2 } })).toBeNull();
    // A 1.3 rpc decodes as an ordinary rpc frame, so a 1.2 decoder takes it.
    const frame = {
      type: "rpc" as const,
      id: "tool_1",
      method: "browser.click",
      params: { callId: "c", ref: "s1e2", element: "Save" },
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
  });

  test("refs carry their snapshot generation", () => {
    expect(parseBrowserRef("s3e12")).toEqual({ generation: 3, local: "e12" });
    expect(parseBrowserRef("s10f2e7")).toEqual({ generation: 10, local: "f2e7" });
    for (const bad of ["e12", "s0e1", "s3", "s3x1", "s03e1", "S3e1", "s3e1 "]) {
      expect(parseBrowserRef(bad)).toBeUndefined();
    }
    expect(formatBrowserRef(4, "f1e2")).toBe("s4f1e2");
  });

  test("params are checked", () => {
    const good = [
      [
        "browser.navigate",
        { callId: "c", url: "http://x/", expect: { urlIncludes: "/x" }, expectTimeoutMs: 0 },
      ],
      ["browser.snapshot", { callId: "c", tab: 1, ref: "s1e2", depth: 3 }],
      ["browser.find", { callId: "c", text: "Save" }],
      ["browser.find", { callId: "c", regex: "^- button", max: 5 }],
      [
        "browser.click",
        { callId: "c", ref: "s1e2", element: "Save", button: "right", double: true },
      ],
      ["browser.type", { callId: "c", ref: "s1e2", element: "Name", text: "", submit: true }],
      ["browser.select", { callId: "c", ref: "s1e2", element: "Color", values: ["blue"] }],
      ["browser.press", { callId: "c", key: "Enter" }],
      ["browser.wait", { callId: "c", textGone: "Loading", timeoutMs: MAX_EXPECT_TIMEOUT_MS }],
      ["browser.screenshot", { callId: "c", fullPage: true }],
      ["browser.tabs", { callId: "c", action: "new", url: "about:blank" }],
      ["browser.tabs", { callId: "c", action: "close", index: 0 }],
    ] as const;
    for (const [method, params] of good) {
      const decoded = decodeToolParams(method, params as never);
      expect(decoded).toEqual({ ok: true, value: params as never });
    }
    const bad = [
      ["browser.navigate", { callId: "c", url: "" }],
      ["browser.navigate", { callId: "c", url: "http://x/\n" }],
      ["browser.navigate", { callId: "c", url: "http://x/", expect: {} }],
      [
        "browser.navigate",
        { callId: "c", url: "http://x/", expectTimeoutMs: MAX_EXPECT_TIMEOUT_MS + 1 },
      ],
      ["browser.find", { callId: "c" }],
      ["browser.find", { callId: "c", text: "a", regex: "b" }],
      ["browser.find", { callId: "c", regex: "(" }],
      ["browser.click", { callId: "c", ref: "s1e2" }],
      ["browser.click", { callId: "c", ref: "s1 e2", element: "x" }],
      ["browser.click", { callId: "c", ref: "s1e2", element: "x", button: "back" }],
      ["browser.select", { callId: "c", ref: "s1e2", element: "x", values: [] }],
      ["browser.select", { callId: "c", ref: "s1e2", element: "x", values: [1] }],
      ["browser.press", { callId: "c", key: "Enter", ref: "s1e2", tab: 0 }],
      ["browser.wait", { callId: "c", timeoutMs: 10 }],
      ["browser.screenshot", { callId: "c", ref: "s1e2", fullPage: true }],
      ["browser.tabs", { callId: "c", action: "select" }],
      ["browser.tabs", { callId: "c", action: "list", url: "http://x/" }],
      ["browser.snapshot", { callId: "c", tab: -1 }],
    ] as const;
    for (const [method, params] of bad) {
      expect(decodeToolParams(method, params as never).ok).toBe(false);
    }
  });

  test("results are checked, with the snapshot cap", () => {
    expect(decodeToolResult("browser.click", action).ok).toBe(true);
    expect(decodeToolResult("browser.click", { ...action, outcome: "maybe" }).ok).toBe(false);
    expect(decodeToolResult("browser.navigate", { ...action, status: 404 }).ok).toBe(true);
    expect(decodeToolResult("browser.click", { ...action, snapshot: null }).ok).toBe(true);
    expect(
      decodeToolResult("browser.click", { ...action, dialogs: [{ type: "alert", message: "hi" }] })
        .ok,
    ).toBe(true);
    expect(decodeToolResult("browser.click", { ...action, dialogs: [{ type: 1 }] }).ok).toBe(false);
    const at = (n: number) => ({
      tab: 0,
      url: "u",
      title: "t",
      snapshot: { ...snapshot, text: "x".repeat(n) },
    });
    expect(decodeToolResult("browser.snapshot", at(MAX_SNAPSHOT_TEXT_BYTES + 512)).ok).toBe(true);
    expect(decodeToolResult("browser.snapshot", at(MAX_SNAPSHOT_TEXT_BYTES + 513)).ok).toBe(false);
    expect(
      decodeToolResult("browser.tabs", {
        tabs: [{ index: 0, url: "about:blank", title: "", active: true }],
        active: 0,
      }).ok,
    ).toBe(true);
    expect(
      decodeToolResult("browser.screenshot", {
        tab: 0,
        url: "u",
        title: "t",
        data: "/9j/",
        mimeType: "image/png",
        bytes: 3,
        sha256: "a",
        width: 1,
        height: 1,
      }).ok,
    ).toBe(false);
  });

  test("each call has a named budget; the hub's deadline adds the grace", () => {
    const click = { callId: "c", ref: "s1e2", element: "x" };
    expect(toolDeadlineMs("browser.click", click)).toBe(
      browserBudgetMs("browser.click", click) + TOOL_DEADLINE_GRACE_MS,
    );
    expect(browserBudgetMs("browser.click", { ...click, expectTimeoutMs: 20_000 })).toBe(
      browserBudgetMs("browser.click", click) - DEFAULT_EXPECT_TIMEOUT_MS + 20_000,
    );
    expect(
      browserBudgetMs("browser.wait", { callId: "c", textVisible: "x", timeoutMs: 30_000 }),
    ).toBeGreaterThan(30_000);
    expect(browserBudgetMs("browser.navigate", { callId: "c", url: "http://x/" })).toBeGreaterThan(
      browserBudgetMs("browser.click", click),
    );
  });
});
