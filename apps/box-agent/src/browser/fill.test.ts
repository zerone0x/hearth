/**
 * `browser.field` and `browser.fill` (protocol 1.5, decision 0039) on the fake
 * driver: the owner-frame origin and field-kind checks run before anything is
 * filled, the value never comes back in a result, an error or a spill, and
 * every later screenshot masks the filled element or is refused.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserParams } from "@hearth/protocol";
import { ToolCallError } from "../tools/errors";
import { DriverError, FakeDriver } from "./fake";
import { BrowserTools } from "./tools";

const SECRET = "hunter2-correct-horse";
const ORIGIN = "https://login.example";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(options: { maxSnapshotBytes?: number } = {}) {
  const driver = new FakeDriver(1);
  const root = mkdtempSync(join(tmpdir(), "hearth-fill-ws-"));
  roots.push(root);
  const tools = new BrowserTools({
    driver,
    root,
    ...(options.maxSnapshotBytes === undefined
      ? {}
      : { maxSnapshotBytes: options.maxSnapshotBytes }),
    now: () => 0,
    sleep: async () => {},
  });
  const page = driver.first;
  page.navigate(`${ORIGIN}/signin`, "Sign in");
  page.snapshotText = [
    "- generic [ref=e1]:",
    '  - textbox "User" [ref=e2]',
    '  - textbox "Password" [ref=e3]',
    '  - textbox "Notes" [ref=e4]',
  ].join("\n");
  page.targets.set("e2", { field: "username" });
  page.targets.set("e3", { field: "password" });
  page.targets.set("e4", { field: "other" });
  return { driver, tools, page, root };
}

async function fresh(tools: BrowserTools): Promise<string> {
  return (await tools.run("browser.snapshot", { callId: "snap" })).snapshot.snapshotId;
}

function fillParams(
  id: string,
  local: string,
  extra: Partial<BrowserParams["browser.fill"]> = {},
): BrowserParams["browser.fill"] {
  return {
    callId: "fill",
    ref: `${id}${local}`,
    element: "Password",
    value: SECRET,
    origins: [ORIGIN],
    fields: ["password"],
    ...extra,
  };
}

async function refusal(run: Promise<unknown>): Promise<ToolCallError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ToolCallError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("browser.field", () => {
  test("reports the field kind and its owner frame's origin", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    const result = await tools.run("browser.field", { callId: "f", ref: `${id}e3` });
    expect(result.field).toBe("password");
    expect(result.origin).toBe(ORIGIN);
    page.targets.set("e2", { field: "username", origin: "https://frame.example" });
    const framed = await tools.run("browser.field", { callId: "f", ref: `${id}e2` });
    expect(framed.origin).toBe("https://frame.example");
  });

  test("a stale ref is refused", async () => {
    const { tools } = setup();
    await fresh(tools);
    const error = await refusal(tools.run("browser.field", { callId: "f", ref: "s99e3" }));
    expect(error.code).toBe("browser.stale-ref");
  });
});

describe("browser.fill origin and field checks", () => {
  test("fills a password field on an allowed origin, marking it before the fill", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    const result = await tools.run("browser.fill", fillParams(id, "e3"));
    expect(result.ok).toBe(true);
    expect(page.actions).toEqual(["field e3", "mark e3", `fill e3 ${SECRET}`]);
  });

  test("submit presses Enter after the fill", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    await tools.run("browser.fill", fillParams(id, "e3", { submit: true }));
    expect(page.actions.at(-1)).toBe("press e3 Enter");
  });

  test("the page's origin is not on the list: refused, nothing filled", async () => {
    const { tools, page } = setup();
    page.navigate("https://evil.example/signin", "Sign in");
    page.targets.set("e3", { field: "password" });
    const id = await fresh(tools);
    const error = await refusal(tools.run("browser.fill", fillParams(id, "e3")));
    expect(error.code).toBe("browser.origin-mismatch");
    expect(error.message).not.toContain(SECRET);
    expect(page.actions.some((a) => a.startsWith("fill") || a.startsWith("mark"))).toBe(false);
  });

  test("the owner frame is checked, not the page: a foreign iframe on an allowed page is refused", async () => {
    const { tools, page } = setup();
    page.targets.set("e3", { field: "password", origin: "https://evil.example" });
    const id = await fresh(tools);
    const error = await refusal(tools.run("browser.fill", fillParams(id, "e3")));
    expect(error.code).toBe("browser.origin-mismatch");
    expect(page.actions.some((a) => a.startsWith("fill"))).toBe(false);
  });

  test("a frame with no web origin is refused", async () => {
    const { tools, page } = setup();
    page.targets.set("e3", { field: "password", origin: null });
    const id = await fresh(tools);
    const error = await refusal(tools.run("browser.fill", fillParams(id, "e3")));
    expect(error.code).toBe("browser.origin-mismatch");
  });

  test("a field of another kind is refused with browser.field-mismatch", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    const error = await refusal(tools.run("browser.fill", fillParams(id, "e4")));
    expect(error.code).toBe("browser.field-mismatch");
    const user = await refusal(tools.run("browser.fill", fillParams(id, "e2")));
    expect(user.code).toBe("browser.field-mismatch");
    expect(page.actions.some((a) => a.startsWith("fill"))).toBe(false);
  });

  test("an empty field list (allow_any_field) takes any text field, but never a non-field", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    const result = await tools.run("browser.fill", fillParams(id, "e4", { fields: [] }));
    expect(result.ok).toBe(true);
    page.targets.set("e5", { field: "none" });
    const id2 = await fresh(tools);
    const error = await refusal(tools.run("browser.fill", fillParams(id2, "e5", { fields: [] })));
    expect(error.code).toBe("browser.field-mismatch");
  });

  test("a hidden or read-only field is refused before the origin is even read", async () => {
    const { tools, page } = setup();
    page.targets.set("e3", { field: "password", editable: false });
    const id = await fresh(tools);
    const result = await tools.run("browser.fill", fillParams(id, "e3"));
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("not_actionable");
    expect(page.actions.some((a) => a.startsWith("fill"))).toBe(false);
  });
});

describe("the value is never echoed", () => {
  test("not in the closing snapshot, later snapshots, find lines, the URL or the title", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    // A page that shows the value: in its snapshot, its URL and its title.
    page.snapshotText = `- textbox "Password" [ref=e3]: ${SECRET}\n- text: echo ${JSON.stringify(SECRET)}`;
    page.pageTitle = `Welcome ${SECRET}`;
    const result = await tools.run("browser.fill", fillParams(id, "e3"));
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.snapshot?.text).toContain("[redacted]");
    page.pageUrl = `${ORIGIN}/signin?pw=${SECRET}`;
    const later = await tools.run("browser.snapshot", { callId: "s2" });
    expect(JSON.stringify(later)).not.toContain(SECRET);
    const found = await tools.run("browser.find", { callId: "f", text: "Password" });
    expect(JSON.stringify(found)).not.toContain(SECRET);
    const tabs = await tools.run("browser.tabs", { callId: "t", action: "list" });
    expect(JSON.stringify(tabs)).not.toContain(SECRET);
  });

  test("not in a spilled snapshot file", async () => {
    const { tools, page } = setup({ maxSnapshotBytes: 64 });
    const id = await fresh(tools);
    page.snapshotText = `${"- generic\n".repeat(20)}- textbox "Password" [ref=e3]: ${SECRET}`;
    const result = await tools.run("browser.fill", fillParams(id, "e3"));
    const path = result.snapshot?.fullSnapshotPath;
    expect(typeof path).toBe("string");
    const spilled = readFileSync(path as string, "utf8");
    expect(spilled).toContain("[redacted]");
    expect(spilled).not.toContain(SECRET);
  });

  test("not in an error a later call raises", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    await tools.run("browser.fill", fillParams(id, "e3"));
    page.failSnapshot = new DriverError("failed", `page said ${SECRET}`);
    const error = await refusal(tools.run("browser.snapshot", { callId: "s" }));
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("[redacted]");
  });

  test("not in the fill's own failure", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    page.failNext = new DriverError("failed", `cannot fill ${SECRET}`);
    const error = await refusal(tools.run("browser.fill", fillParams(id, "e3")));
    expect(error.message).not.toContain(SECRET);
  });
});

describe("screenshot masks", () => {
  test("every later screenshot masks the filled element", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    await tools.run("browser.fill", fillParams(id, "e3"));
    await tools.run("browser.screenshot", { callId: "shot" });
    expect(page.actions.at(-1)).toBe("screenshot q70 masks=e3");
  });

  test("a filled element that is gone refuses the screenshot", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    await tools.run("browser.fill", fillParams(id, "e3"));
    page.targets.set("e3", { found: false });
    const error = await refusal(tools.run("browser.screenshot", { callId: "shot" }));
    expect(error.code).toBe("browser.mask-missing");
    expect(page.actions.at(-1)).toBe("screenshot refused");
  });

  test("after the page navigates the mark ends, and screenshots work again", async () => {
    const { tools, page } = setup();
    const id = await fresh(tools);
    await tools.run("browser.fill", fillParams(id, "e3"));
    page.targets.set("e3", { found: false });
    page.navigate(`${ORIGIN}/home`, "Home");
    const shot = await tools.run("browser.screenshot", { callId: "shot" });
    expect(shot.bytes).toBeGreaterThan(0);
    expect(page.actions.at(-1)).toBe("screenshot q70");
  });

  test("a refused fill marks nothing", async () => {
    const { tools, page } = setup();
    page.targets.set("e3", { field: "password", origin: "https://evil.example" });
    const id = await fresh(tools);
    await refusal(tools.run("browser.fill", fillParams(id, "e3")));
    expect(page.marks).toEqual([]);
  });
});
