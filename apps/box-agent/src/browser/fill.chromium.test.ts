/**
 * `browser.field`, `browser.fill` and the screenshot masks (decision 0039) on
 * `playwright-core` against a real Chromium. Runs only when `HEARTH_CHROMIUM`
 * names a Chromium or chrome-headless-shell binary, like `playwright.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ToolCallError } from "../tools/errors";
import { TestChromium } from "./chromium.testkit";
import { PlaywrightDriver } from "./playwright";
import { BrowserTools } from "./tools";

const chromiumPath = process.env["HEARTH_CHROMIUM"] ?? "";
const SECRET = "chromium-fill-pw-41a9";

const BOX =
  "width:200px;height:40px;box-sizing:border-box;border:0;margin:0;padding:0;display:block";

function pages(frameOrigin: string): Record<string, string> {
  return {
    "/signin": `<!doctype html><title>Sign in</title>
<label>User <input id="user" autocomplete="username"></label>
<label>Password <input id="pw" type="password" style="${BOX};background:#fff;color:#000;font-size:30px"></label>
<label>Code <input id="code" autocomplete="one-time-code"></label>
<div id="black" role="img" aria-label="Black" style="${BOX};background:#000"></div>
<button onclick="document.getElementById('pw').remove()">Remove</button>
<button onclick="document.getElementById('pw').removeAttribute('data-hearth-mask')">Strip</button>
<iframe src="${frameOrigin}/inner" style="width:400px;height:80px"></iframe>`,
    "/inner": `<!doctype html><title>Inner</title><label>Framed <input type="password"></label>`,
    "/plain": `<!doctype html><title>Plain</title><p>after</p>`,
  };
}

function refOf(text: string, line: RegExp): string {
  for (const l of text.split("\n")) {
    if (!line.test(l)) continue;
    const match = /\[ref=(s\d+(?:f\d+)?e\d+)\]/.exec(l);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`no ${line} in:\n${text}`);
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

describe.skipIf(chromiumPath === "")("browser_fill on a real Chromium", () => {
  let chromium: TestChromium;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let driver: PlaywrightDriver;
  let tools: BrowserTools;

  beforeAll(async () => {
    chromium = new TestChromium(chromiumPath);
    let frameOrigin = "";
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const page = pages(frameOrigin)[new URL(req.url).pathname];
        return page === undefined
          ? new Response("not found", { status: 404 })
          : new Response(page, { headers: { "content-type": "text/html" } });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    // The same server under another host name: another origin for the iframe.
    frameOrigin = `http://localhost:${server.port}`;
    await chromium.start();
    driver = new PlaywrightDriver({ endpoint: chromium.endpoint, connectTimeoutMs: 10_000 });
    tools = new BrowserTools({ driver, root: chromium.profile });
  });

  afterAll(async () => {
    await tools?.close();
    await chromium?.stop();
    server?.stop(true);
  });

  async function open(): Promise<string> {
    const nav = await tools.run("browser.navigate", { callId: "c", url: `${base}/signin` });
    expect(nav.ok).toBe(true);
    // The iframe's content is in the snapshot once it loaded.
    for (let i = 0; i < 50; i++) {
      const snap = (await tools.run("browser.snapshot", { callId: "c" })).snapshot.text;
      if (/Framed/.test(snap)) return snap;
      await Bun.sleep(100);
    }
    throw new Error("the iframe did not load");
  }

  test("field kinds and owner-frame origins", async () => {
    const snap = await open();
    const field = (ref: string) => tools.run("browser.field", { callId: "f", ref });
    expect(await field(refOf(snap, /textbox "Password"/))).toMatchObject({
      field: "password",
      origin: base,
    });
    expect((await field(refOf(snap, /textbox "User"/))).field).toBe("username");
    expect((await field(refOf(snap, /textbox "Code"/))).field).toBe("one-time-code");
    expect((await field(refOf(snap, /button "Remove"/))).field).toBe("none");
    expect(await field(refOf(snap, /textbox "Framed"/))).toMatchObject({
      field: "password",
      origin: `http://localhost:${server.port}`,
    });
  });

  test("a password field in a foreign iframe is refused on the page's origin", async () => {
    const snap = await open();
    const error = await refusal(
      tools.run("browser.fill", {
        callId: "c",
        ref: refOf(snap, /textbox "Framed"/),
        element: "Framed",
        value: SECRET,
        origins: [base],
        fields: ["password"],
      }),
    );
    expect(error.code).toBe("browser.origin-mismatch");
  });

  test("fills, never echoes, masks in screenshots, and refuses when the field is gone", async () => {
    let snap = await open();
    const filled = await tools.run("browser.fill", {
      callId: "c",
      ref: refOf(snap, /textbox "Password"/),
      element: "Password",
      value: SECRET,
      origins: [base],
      fields: ["password"],
    });
    expect(filled.ok).toBe(true);
    expect(JSON.stringify(filled)).not.toContain(SECRET);
    snap = filled.snapshot?.text ?? "";

    // The masked field looks exactly like a black box of the same size: its pixels are gone.
    const shot = async (ref: string) =>
      (await tools.run("browser.screenshot", { callId: "s", ref })).sha256;
    const masked = await shot(refOf(snap, /textbox "Password"/));
    const black = await shot(refOf(snap, /img "Black"/));
    expect(masked).toBe(black);
    const whole = await tools.run("browser.screenshot", { callId: "s" });
    expect(whole.bytes).toBeGreaterThan(0);

    // The page drops the mark: refused, not shown unmasked.
    await tools.run("browser.click", {
      callId: "c",
      ref: refOf(snap, /button "Strip"/),
      element: "Strip",
    });
    expect((await refusal(tools.run("browser.screenshot", { callId: "s" }))).code).toBe(
      "browser.mask-missing",
    );
  });

  test("a removed field refuses screenshots until the page navigates", async () => {
    let snap = await open();
    const filled = await tools.run("browser.fill", {
      callId: "c",
      ref: refOf(snap, /textbox "Password"/),
      element: "Password",
      value: SECRET,
      origins: [base],
      fields: ["password"],
    });
    snap = filled.snapshot?.text ?? "";
    await tools.run("browser.click", {
      callId: "c",
      ref: refOf(snap, /button "Remove"/),
      element: "Remove",
    });
    expect((await refusal(tools.run("browser.screenshot", { callId: "s" }))).code).toBe(
      "browser.mask-missing",
    );
    await tools.run("browser.navigate", { callId: "c", url: `${base}/plain` });
    const after = await tools.run("browser.screenshot", { callId: "s" });
    expect(createHash("sha256").update(Buffer.from(after.data, "base64")).digest("hex")).toBe(
      after.sha256,
    );
  });
});
