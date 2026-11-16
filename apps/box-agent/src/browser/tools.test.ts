import { describe, expect, test } from "bun:test";
import {
  type BrowserActionResult,
  MAX_SCREENSHOT_BYTES,
  MAX_SNAPSHOT_TEXT_BYTES,
} from "@hearth/protocol";
import { ToolCallError } from "../tools/errors";
import { DriverError, FakeDriver, type FakeTab } from "./fake";
import { BrowserTools } from "./tools";

const FORM = [
  "- generic [ref=e1]:",
  '  - textbox "Name" [ref=e2]',
  '  - button "Save" [ref=e3]',
  '  - button "Off" [disabled] [ref=e4]',
].join("\n");

function setup(options: { maxSnapshotBytes?: number; tabs?: number } = {}) {
  const driver = new FakeDriver(options.tabs ?? 1);
  const spilled: Array<{ name: string; text: string }> = [];
  let clock = 0;
  const tools = new BrowserTools({
    driver,
    root: "/workspace",
    spill: async (name, text) => {
      spilled.push({ name, text });
      return `/workspace/.hearth/browser/${name}`;
    },
    ...(options.maxSnapshotBytes === undefined
      ? {}
      : { maxSnapshotBytes: options.maxSnapshotBytes }),
    // An injected clock: polling advances it, so no test sleeps for real.
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const page = driver.first;
  page.navigate("http://127.0.0.1:8000/form", "Form");
  page.snapshotText = FORM;
  page.targets.set("e2", {});
  page.targets.set("e3", {});
  page.targets.set("e4", { enabled: false });
  return { driver, tools, page, spilled, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function snapshotId(tools: BrowserTools): Promise<string> {
  return (await tools.run("browser.snapshot", { callId: "c" })).snapshot.snapshotId;
}

describe("snapshots and refs", () => {
  test("refs carry the snapshot's generation, and every snapshot gets a new one", async () => {
    const { tools } = setup();
    const first = await tools.run("browser.snapshot", { callId: "c" });
    expect(first.snapshot.snapshotId).toBe("s1");
    expect(first.snapshot.text).toContain('textbox "Name" [ref=s1e2]');
    expect(first.snapshot.text).not.toContain("[ref=e2]");
    expect(first).toMatchObject({ tab: 0, url: "http://127.0.0.1:8000/form", title: "Form" });
    const second = await tools.run("browser.snapshot", { callId: "c" });
    expect(second.snapshot.snapshotId).toBe("s2");
    expect(second.snapshot.text).toContain("[ref=s2e3]");
  });

  test("frame refs keep their frame part", async () => {
    const { tools, page } = setup();
    page.snapshotText = '- button "In frame" [ref=f1e7]';
    const result = await tools.run("browser.snapshot", { callId: "c" });
    expect(result.snapshot.text).toBe('- button "In frame" [ref=s1f1e7]');
  });

  test("a ref of the latest snapshot acts, and the result carries a fresh snapshot", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    const result = await tools.run("browser.click", { callId: "c", ref: "s1e3", element: "Save" });
    expect(page.actions).toEqual(["click e3 left"]);
    expect(result).toMatchObject({ ok: true, outcome: "done", verified: null, message: null });
    expect(result.snapshot?.snapshotId).toBe("s2");
  });

  test("a ref from an older snapshot is refused at once, before anything is dispatched", async () => {
    const { tools, page, now } = setup();
    await snapshotId(tools); // s1
    await snapshotId(tools); // s2
    const result = await tools.run("browser.click", { callId: "c", ref: "s1e3", element: "Save" });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("stale_ref");
    expect(result.message).toContain("s1");
    expect(page.actions).toEqual([]);
    expect(now()).toBe(0); // nothing waited
    // The refusal brings the fresh snapshot, so the model can act on it.
    expect(result.snapshot?.snapshotId).toBe("s3");
    const retry = await tools.run("browser.click", { callId: "c", ref: "s3e3", element: "Save" });
    expect(retry.outcome).toBe("done");
  });

  test("an action makes the refs before it stale (snapshot last)", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    await tools.run("browser.click", { callId: "c", ref: "s1e3", element: "Save" });
    const again = await tools.run("browser.click", { callId: "c", ref: "s1e3", element: "Save" });
    expect(again.outcome).toBe("stale_ref");
    expect(page.actions).toEqual(["click e3 left"]);
  });

  test("a navigation after the snapshot makes its refs stale", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    page.navigate("http://127.0.0.1:8000/other", "Other");
    const result = await tools.run("browser.type", {
      callId: "c",
      ref: "s1e2",
      element: "Name",
      text: "x",
    });
    expect(result.outcome).toBe("stale_ref");
    expect(result.message).toContain("navigated");
    expect(page.actions).toEqual([]);
  });

  test("a ref of another tab's older snapshot is stale; the other tab's latest is not", async () => {
    const { tools, driver, page } = setup({ tabs: 2 });
    const second = driver.pages[1] as FakeTab;
    second.snapshotText = '- button "Go" [ref=e9]';
    second.targets.set("e9", {});
    await snapshotId(tools); // s1, tab 0
    const other = await tools.run("browser.snapshot", { callId: "c", tab: 1 }); // s2, tab 1
    expect(other.tab).toBe(1);
    // Tab 0's s1 is still its latest; tab 1's s2 is its latest.
    expect(
      (await tools.run("browser.click", { callId: "c", ref: "s2e9", element: "Go" })).outcome,
    ).toBe("done");
    expect(second.actions).toEqual(["click e9 left"]);
    // The click's closing snapshot was of tab 1 (s3); tab 0 still has s1.
    expect(
      (await tools.run("browser.click", { callId: "c", ref: "s1e3", element: "Save" })).outcome,
    ).toBe("done");
    expect(page.actions).toEqual(["click e3 left"]);
  });

  test("a ref from a closed tab is stale", async () => {
    const { tools, driver } = setup({ tabs: 2 });
    (driver.pages[1] as FakeTab).targets.set("e1", {});
    await tools.run("browser.snapshot", { callId: "c", tab: 1 });
    await tools.run("browser.tabs", { callId: "c", action: "close", index: 1 });
    const result = await tools.run("browser.click", { callId: "c", ref: "s1e1", element: "x" });
    expect(result.outcome).toBe("stale_ref");
  });

  test("a ref that is not ours is stale, never passed to Playwright", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    for (const ref of ["e3", "s0e3", "s99e3", "s1x3"]) {
      const result = await tools.run("browser.click", { callId: "c", ref, element: "Save" });
      expect(result.outcome).toBe("stale_ref");
    }
    expect(page.actions).toEqual([]);
  });

  test("subtree snapshots and screenshots refuse a stale ref with browser.stale-ref", async () => {
    const { tools } = setup();
    await snapshotId(tools);
    await snapshotId(tools);
    for (const call of [
      () => tools.run("browser.snapshot", { callId: "c", ref: "s1e1" }),
      () => tools.run("browser.screenshot", { callId: "c", ref: "s1e1" }),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).code).toBe("browser.stale-ref");
    }
  });

  test("a subtree snapshot passes Playwright's ref and the depth, and starts a new generation", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    const sub = await tools.run("browser.snapshot", { callId: "c", ref: "s1e1", depth: 2 });
    expect(page.snapshots.at(-1)).toEqual({ ref: "e1", depth: 2 });
    expect(sub.snapshot.snapshotId).toBe("s2");
  });
});

describe("fail closed before acting", () => {
  const cases: Array<[string, Record<string, unknown>, "browser.click" | "browser.type", string]> =
    [
      ["gone", { found: false }, "browser.click", "stale_ref"],
      ["hidden", { visible: false }, "browser.click", "not_actionable"],
      ["disabled", { enabled: false }, "browser.click", "not_actionable"],
      ["covered", { covered: true }, "browser.click", "not_actionable"],
      ["not editable", { editable: false }, "browser.type", "not_actionable"],
    ];
  for (const [name, state, method, outcome] of cases) {
    test(`a ${name} target is refused with ${outcome} and nothing is dispatched`, async () => {
      const { tools, page } = setup();
      page.targets.set("e3", state);
      await snapshotId(tools);
      const result = await tools.run(method, {
        callId: "c",
        ref: "s1e3",
        element: "Save",
        text: "x",
      } as never);
      expect(result).toMatchObject({ ok: false, outcome });
      expect(result.message).toContain("Nothing was done");
      expect(page.actions).toEqual([]);
    });
  }

  test("a covered or non-editable target can still take a key press; a covered one can be typed into", async () => {
    const { tools, page } = setup();
    page.targets.set("e2", { covered: true });
    await snapshotId(tools);
    const typed = await tools.run("browser.type", {
      callId: "c",
      ref: "s1e2",
      element: "Name",
      text: "x",
    });
    expect(typed.outcome).toBe("done");
    expect(page.actions).toEqual(["fill e2 x"]);
  });

  test("a disabled select is refused", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    const result = await tools.run("browser.select", {
      callId: "c",
      ref: "s1e4",
      element: "Off",
      values: ["a"],
    });
    expect(result.outcome).toBe("not_actionable");
    expect(page.actions).toEqual([]);
  });
});

describe("verified actions", () => {
  test("expect holds: ok and verified", async () => {
    const { tools, page } = setup();
    page.targets.set("e3", { onClick: (tab) => tab.visibleText.add("Saved: alice") });
    await snapshotId(tools);
    const result = await tools.run("browser.click", {
      callId: "c",
      ref: "s1e3",
      element: "Save",
      expect: { textVisible: "Saved:", urlIncludes: "/form", titleIncludes: "Form" },
    });
    expect(result).toMatchObject({ ok: true, outcome: "done", verified: true });
  });

  test("the click ran but the page said no: not ok, not verified, after the expect timeout", async () => {
    const { tools, page, now } = setup();
    page.targets.set("e3", { onClick: (tab) => tab.visibleText.add("Please accept the terms") });
    await snapshotId(tools);
    const result = await tools.run("browser.click", {
      callId: "c",
      ref: "s1e3",
      element: "Save",
      expect: { textVisible: "Saved:" },
      expectTimeoutMs: 500,
    });
    expect(page.actions).toEqual(["click e3 left"]);
    expect(result).toMatchObject({ ok: false, outcome: "not_verified", verified: false });
    expect(result.message).toContain("not done");
    expect(now()).toBeGreaterThanOrEqual(500);
    expect(now()).toBeLessThan(700);
  });

  test("a condition that comes true while polling verifies", async () => {
    const { tools, page, advance } = setup();
    let polls = 0;
    page.textVisible = async (text) => {
      polls++;
      if (polls === 3) advance(0);
      return polls >= 3 && text === "Saved:";
    };
    await snapshotId(tools);
    const result = await tools.run("browser.click", {
      callId: "c",
      ref: "s1e3",
      element: "Save",
      expect: { textVisible: "Saved:" },
    });
    expect(result.verified).toBe(true);
    expect(polls).toBe(3);
  });

  test("textGone and a zero timeout check exactly once", async () => {
    const { tools, page } = setup();
    page.visibleText.add("Loading");
    let polls = 0;
    const original = page.textVisible.bind(page);
    page.textVisible = async (text) => {
      polls++;
      return await original(text);
    };
    const result = await tools.run("browser.wait", {
      callId: "c",
      textGone: "Loading",
      timeoutMs: 0,
    });
    expect(result).toMatchObject({ ok: false, outcome: "not_verified", verified: false });
    expect(polls).toBe(1);
  });

  test("browser.wait verifies a URL", async () => {
    const { tools } = setup();
    const result = await tools.run("browser.wait", {
      callId: "c",
      urlIncludes: "/form",
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ ok: true, outcome: "done", verified: true });
    expect(result.snapshot?.text).toContain("[ref=s1e2]");
  });

  test("type with submit fills and presses Enter on the field", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    await tools.run("browser.type", {
      callId: "c",
      ref: "s1e2",
      element: "Name",
      text: "alice",
      submit: true,
    });
    expect(page.actions).toEqual(["fill e2 alice", "press e2 Enter"]);
  });

  test("press without a ref goes to the page; select passes its values", async () => {
    const { tools, page } = setup();
    await tools.run("browser.press", { callId: "c", key: "Escape" });
    await snapshotId(tools);
    const sid = (await snapshotId(tools)).slice(1);
    await tools.run("browser.select", {
      callId: "c",
      ref: `s${sid}e2`,
      element: "Name",
      values: ["a", "b"],
    });
    expect(page.actions).toEqual(["press page Escape", "select e2 a,b"]);
  });

  test("double and right clicks reach the driver", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    const r = await tools.run("browser.click", {
      callId: "c",
      ref: "s1e3",
      element: "Save",
      button: "right",
      double: true,
    });
    expect(r.outcome).toBe("done");
    expect(page.actions).toEqual(["click e3 right double"]);
  });

  test("a Playwright timeout is the outcome timeout, with a snapshot", async () => {
    const { tools, page } = setup();
    await snapshotId(tools);
    page.failNext = new DriverError("timeout", "click: Timeout 10000ms exceeded.");
    const result = await tools.run("browser.click", { callId: "c", ref: "s1e3", element: "Save" });
    expect(result).toMatchObject({ ok: false, outcome: "timeout", verified: null });
    expect(result.snapshot).not.toBeNull();
  });

  test("a failure that is no outcome is the call's error", async () => {
    const { tools, page } = setup();
    page.failNext = new DriverError("failed", 'Unknown key: "Nope"');
    const error = await tools.run("browser.press", { callId: "c", key: "Nope" }).catch((e) => e);
    expect((error as ToolCallError).code).toBe("browser.failed");
  });

  test("dialogs during the call are reported", async () => {
    const { tools, page } = setup();
    page.targets.set("e3", { onClick: (tab) => tab.dialog("confirm", "Delete?") });
    page.dialog("alert", "old, from before the call");
    await snapshotId(tools);
    const result = await tools.run("browser.click", { callId: "c", ref: "s1e3", element: "Save" });
    expect(result.dialogs).toEqual([{ type: "confirm", message: "Delete?" }]);
  });
});

describe("navigate", () => {
  test("loads the URL, verifies and returns the status and snapshot", async () => {
    const { tools, page } = setup();
    page.snapshotText = '- heading "Next" [ref=e1]';
    const result = await tools.run("browser.navigate", {
      callId: "c",
      url: "http://127.0.0.1:8000/next",
      expect: { urlIncludes: "/next" },
    });
    expect(page.actions).toEqual(["goto http://127.0.0.1:8000/next"]);
    expect(result).toMatchObject({ ok: true, outcome: "done", verified: true, status: 200 });
    expect(result.snapshot?.text).toBe('- heading "Next" [ref=s1e1]');
  });

  test("a network error is navigation_failed", async () => {
    const { tools, page } = setup();
    page.failNext = new DriverError("navigation", "page.goto: net::ERR_CONNECTION_REFUSED");
    const result = await tools.run("browser.navigate", { callId: "c", url: "http://10.0.0.1/" });
    expect(result).toMatchObject({ ok: false, outcome: "navigation_failed", status: null });
    expect(result.message).toContain("ERR_CONNECTION_REFUSED");
  });

  test("only http, https and about:blank are opened", async () => {
    const { tools, page } = setup();
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "chrome://settings",
    ]) {
      const error = await tools.run("browser.navigate", { callId: "c", url }).catch((e) => e);
      expect((error as ToolCallError).code).toBe("browser.bad-url");
    }
    await tools.run("browser.navigate", { callId: "c", url: "about:blank" });
    await tools.run("browser.navigate", { callId: "c", url: "HTTPS://example.com/" });
    expect(page.actions).toEqual(["goto about:blank", "goto HTTPS://example.com/"]);
  });

  test("no browser is browser.unavailable, from the driver", async () => {
    const { tools, driver } = setup();
    driver.down = new ToolCallError("browser.unavailable", "no CDP");
    const error = await tools.run("browser.snapshot", { callId: "c" }).catch((e) => e);
    expect((error as ToolCallError).code).toBe("browser.unavailable");
  });
});

describe("snapshot cap", () => {
  function lines(n: number): string {
    return Array.from({ length: n }, (_, i) => `- listitem "row ${i}" [ref=e${i + 1}]`).join("\n");
  }

  test("a snapshot within the cap is whole", async () => {
    const { tools, page, spilled } = setup();
    page.snapshotText = lines(10);
    const { snapshot } = await tools.run("browser.snapshot", { callId: "c" });
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.fullSnapshotPath).toBeNull();
    expect(spilled).toEqual([]);
  });

  test("exactly the cap is whole; one byte more is cut at a line end and spilled", async () => {
    const tagged = (text: string) => text.replace(/\[ref=e/g, "[ref=s1e");
    const text = lines(40);
    const max = Buffer.byteLength(tagged(text));
    {
      const { tools, page } = setup({ maxSnapshotBytes: max });
      page.snapshotText = text;
      expect((await tools.run("browser.snapshot", { callId: "c" })).snapshot.truncated).toBe(false);
    }
    const { tools, page, spilled } = setup({ maxSnapshotBytes: max - 1 });
    page.snapshotText = text;
    const { snapshot } = await tools.run("browser.snapshot", { callId: "c" });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.totalBytes).toBe(max);
    expect(snapshot.fullSnapshotPath).toBe("/workspace/.hearth/browser/s1.txt");
    expect(spilled).toEqual([{ name: "s1.txt", text: tagged(text) }]);
    const [head, marker] = snapshot.text.split("\n[hearth: ");
    expect(tagged(text).startsWith(`${head}\n`)).toBe(true);
    expect(head?.endsWith('"row 38" [ref=s1e39]')).toBe(true);
    expect(marker).toContain(`of ${max} bytes`);
    expect(marker).toContain("/workspace/.hearth/browser/s1.txt");
  });

  test("the default cap is MAX_SNAPSHOT_TEXT_BYTES, for acting results too", async () => {
    const { tools, page } = setup();
    page.snapshotText = lines(2000);
    const result = (await tools.run("browser.press", {
      callId: "c",
      key: "End",
    })) as BrowserActionResult;
    const snapshot = result.snapshot;
    expect(snapshot?.truncated).toBe(true);
    const head = snapshot?.text.split("\n[hearth: ")[0] ?? "";
    expect(Buffer.byteLength(head)).toBeLessThanOrEqual(MAX_SNAPSHOT_TEXT_BYTES);
    expect(Buffer.byteLength(head)).toBeGreaterThan(MAX_SNAPSHOT_TEXT_BYTES - 100);
  });

  test("a spill that fails still returns the cut snapshot, without a path", async () => {
    const driver = new FakeDriver();
    const tools = new BrowserTools({
      driver,
      root: "/workspace",
      maxSnapshotBytes: 10,
      spill: async () => {
        throw new Error("disk full");
      },
    });
    driver.first.snapshotText = lines(5);
    const { snapshot } = await tools.run("browser.snapshot", { callId: "c" });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.fullSnapshotPath).toBeNull();
  });
});

describe("find", () => {
  test("returns matching lines of a fresh snapshot, with its refs", async () => {
    const { tools, page } = setup();
    await snapshotId(tools); // s1
    const found = await tools.run("browser.find", { callId: "c", text: "BUTTON" });
    expect(found.snapshotId).toBe("s2");
    expect(found.lines).toEqual([
      '- button "Save" [ref=s2e3]',
      '- button "Off" [disabled] [ref=s2e4]',
    ]);
    expect(found).toMatchObject({ matches: 2, limitReached: false });
    // The find's snapshot is the latest: s1 is stale now, s2 acts.
    expect(
      (await tools.run("browser.click", { callId: "c", ref: "s1e3", element: "Save" })).outcome,
    ).toBe("stale_ref");
    expect(page.actions).toEqual([]);
  });

  test("a regex and a max", async () => {
    const { tools } = setup();
    const found = await tools.run("browser.find", {
      callId: "c",
      regex: 'button "(Save|Off)"',
      max: 1,
    });
    expect(found.lines).toEqual(['- button "Save" [ref=s1e3]']);
    expect(found).toMatchObject({ matches: 2, limitReached: true });
  });
});

describe("screenshots", () => {
  test("a JPEG with its hash and size", async () => {
    const { tools, page } = setup();
    const shot = await tools.run("browser.screenshot", { callId: "c" });
    expect(shot).toMatchObject({ mimeType: "image/jpeg", bytes: 1000, width: 1280, height: 800 });
    const data = Buffer.from(shot.data, "base64");
    expect(data.length).toBe(1000);
    expect(shot.sha256).toBe(new Bun.CryptoHasher("sha256").update(data).digest("hex"));
    expect(page.actions).toEqual(["screenshot q70"]);
  });

  test("too large: lower quality, then the viewport instead of the full page, then too-large", async () => {
    const { tools, page } = setup();
    page.screenshotBytes = (quality, fullPage) =>
      fullPage || quality > 30 ? MAX_SCREENSHOT_BYTES + 1 : MAX_SCREENSHOT_BYTES;
    const shot = await tools.run("browser.screenshot", { callId: "c", fullPage: true });
    expect(shot.bytes).toBe(MAX_SCREENSHOT_BYTES);
    expect(page.actions).toEqual([
      "screenshot q70 full",
      "screenshot q50 full",
      "screenshot q30 full",
      "screenshot q70",
      "screenshot q50",
      "screenshot q30",
    ]);
    page.screenshotBytes = () => MAX_SCREENSHOT_BYTES + 1;
    const error = await tools.run("browser.screenshot", { callId: "c" }).catch((e) => e);
    expect((error as ToolCallError).code).toBe("tool.too-large");
  });
});

describe("tabs", () => {
  test("list, new, select and close; the active tab is the default target", async () => {
    const { tools, driver } = setup();
    let list = await tools.run("browser.tabs", { callId: "c", action: "list" });
    expect(list.tabs).toEqual([
      { index: 0, url: "http://127.0.0.1:8000/form", title: "Form", active: false },
    ]);
    list = await tools.run("browser.tabs", {
      callId: "c",
      action: "new",
      url: "http://127.0.0.1:8000/x",
    });
    expect(list.active).toBe(1);
    expect(list.tabs[1]).toMatchObject({ url: "http://127.0.0.1:8000/x", active: true });
    expect((await tools.run("browser.snapshot", { callId: "c" })).tab).toBe(1);
    list = await tools.run("browser.tabs", { callId: "c", action: "select", index: 0 });
    expect(list.active).toBe(0);
    expect((driver.pages[0] as FakeTab).actions).toContain("front");
    list = await tools.run("browser.tabs", { callId: "c", action: "close", index: 0 });
    expect(list.tabs).toHaveLength(1);
    expect(list.active).toBeNull();
    const error = await tools
      .run("browser.tabs", { callId: "c", action: "select", index: 5 })
      .catch((e) => e);
    expect((error as ToolCallError).code).toBe("browser.no-tab");
  });

  test("with no tab open, the first call opens one", async () => {
    const driver = new FakeDriver(0);
    const tools = new BrowserTools({ driver, root: "/w" });
    const result = await tools.run("browser.snapshot", { callId: "c" });
    expect(result.tab).toBe(0);
    expect(driver.pages).toHaveLength(1);
  });
});

describe("one call at a time", () => {
  test("calls run in arrival order, never interleaved", async () => {
    const { tools, page } = setup();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    page.goto = async (url) => {
      order.push(`start ${url}`);
      await gate;
      order.push(`end ${url}`);
      return { status: 200 };
    };
    const a = tools.run("browser.navigate", { callId: "a", url: "http://a/" });
    const b = tools.run("browser.navigate", { callId: "b", url: "http://b/" });
    await Bun.sleep(5);
    expect(order).toEqual(["start http://a/"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start http://a/", "end http://a/", "start http://b/", "end http://b/"]);
  });

  test("a call whose deadline passed while it waited never runs; a failed call does not block the next", async () => {
    const { tools, page, advance, now } = setup();
    page.failNext = new DriverError("failed", "boom");
    const failed = tools.run("browser.press", { callId: "a", key: "x" }).catch((e) => e);
    const late = tools
      .run("browser.press", { callId: "b", key: "y" }, { deadline: now() - 1 })
      .catch((e) => e);
    expect(((await failed) as ToolCallError).code).toBe("browser.failed");
    expect(((await late) as ToolCallError).code).toBe("tool.deadline");
    advance(1);
    const controller = new AbortController();
    controller.abort();
    const aborted = await tools
      .run("browser.press", { callId: "c", key: "z" }, { signal: controller.signal })
      .catch((e) => e);
    expect((aborted as ToolCallError).code).toBe("tool.internal");
    await tools.run("browser.press", { callId: "d", key: "Enter" });
    expect(page.actions).toEqual(["press page x", "press page Enter"]);
  });
});
