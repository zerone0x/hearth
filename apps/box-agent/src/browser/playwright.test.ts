/**
 * The browser tools on `playwright-core` against a real Chromium over CDP,
 * started the way the box entrypoint starts it (decision 0026: CDP on
 * loopback, own profile). Runs only when `HEARTH_CHROMIUM` names a Chromium
 * or chrome-headless-shell binary; CI's web-e2e job sets it after installing
 * Playwright's headless shell. The Docker e2e covers the real box image.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserActionResult } from "@hearth/protocol";
import { PlaywrightDriver } from "./playwright";
import { BrowserTools } from "./tools";

const chromiumPath = process.env["HEARTH_CHROMIUM"];

const PAGES: Record<string, string> = {
  "/form": `<!doctype html><title>Form</title>
<h1>Profile</h1>
<label>Name <input id="name"></label>
<label>Color <select id="color"><option>red</option><option>blue</option></select></label>
<button id="save" onclick="document.getElementById('out').textContent = 'Saved: ' + document.getElementById('name').value + '/' + document.getElementById('color').value">Save</button>
<button disabled>Archived</button>
<p id="out"></p>
<a href="/next">Next page</a>`,
  "/covered": `<!doctype html><title>Covered</title>
<button>Under</button>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.3)">Cookie banner</div>`,
  "/next": `<!doctype html><title>Next</title><h1>Next</h1><button>Other</button>`,
};

function refOf(text: string, line: RegExp): string {
  for (const l of text.split("\n")) {
    if (!line.test(l)) continue;
    const match = /\[ref=(s\d+(?:f\d+)?e\d+)\]/.exec(l);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`no ${line} in:\n${text}`);
}

async function waitForCdp(port: number): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("CDP did not come up");
}

describe.skipIf(chromiumPath === undefined || chromiumPath === "")(
  "browser tools on a real Chromium",
  () => {
    const port = 19_000 + Math.floor(Math.random() * 5000);
    let profile: string;
    let chrome: ChildProcess | undefined;
    let server: ReturnType<typeof Bun.serve>;
    let base: string;
    let driver: PlaywrightDriver;
    let tools: BrowserTools;

    const startChrome = async () => {
      chrome = spawn(
        chromiumPath as string,
        [
          "--headless=new",
          "--no-sandbox",
          "--no-first-run",
          "--remote-debugging-address=127.0.0.1",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          "--window-size=1280,800",
          "about:blank",
        ],
        { detached: true, stdio: "ignore" },
      );
      await waitForCdp(port);
    };
    const killChrome = async () => {
      const child = chrome;
      if (child?.pid === undefined) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      await exited;
      chrome = undefined;
    };

    beforeAll(async () => {
      profile = mkdtempSync(join(tmpdir(), "hearth-browser-"));
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req) => {
          const page = PAGES[new URL(req.url).pathname];
          return page === undefined
            ? new Response("not found", { status: 404 })
            : new Response(page, { headers: { "content-type": "text/html" } });
        },
      });
      base = `http://127.0.0.1:${server.port}`;
      await startChrome();
      driver = new PlaywrightDriver({
        endpoint: `http://127.0.0.1:${port}`,
        connectTimeoutMs: 10_000,
      });
      tools = new BrowserTools({ driver, root: profile });
    });

    afterAll(async () => {
      await tools?.close();
      await killChrome();
      server?.stop(true);
      rmSync(profile, { recursive: true, force: true });
    });

    test("navigate, type, select and click by ref, verified", async () => {
      const nav = await tools.run("browser.navigate", {
        callId: "c",
        url: `${base}/form`,
        expect: { titleIncludes: "Form" },
      });
      expect(nav).toMatchObject({
        ok: true,
        outcome: "done",
        verified: true,
        status: 200,
        title: "Form",
      });
      let snap = nav.snapshot?.text ?? "";
      const typed = await tools.run("browser.type", {
        callId: "c",
        ref: refOf(snap, /textbox "Name"/),
        element: "Name field",
        text: "alice",
      });
      expect(typed.outcome).toBe("done");
      snap = typed.snapshot?.text ?? "";
      const selected = await tools.run("browser.select", {
        callId: "c",
        ref: refOf(snap, /combobox "Color"/),
        element: "Color",
        values: ["blue"],
      });
      expect(selected.outcome).toBe("done");
      snap = selected.snapshot?.text ?? "";
      const clicked = await tools.run("browser.click", {
        callId: "c",
        ref: refOf(snap, /button "Save"/),
        element: "Save button",
        expect: { textVisible: "Saved: alice/blue" },
      });
      expect(clicked).toMatchObject({ ok: true, outcome: "done", verified: true });
      expect(clicked.snapshot?.text).toContain("Saved: alice/blue");
    }, 60_000);

    test("a disabled button and a covered one are refused fast, nothing clicked", async () => {
      const nav = await tools.run("browser.navigate", { callId: "c", url: `${base}/form` });
      const started = Date.now();
      const disabled = await tools.run("browser.click", {
        callId: "c",
        ref: refOf(nav.snapshot?.text ?? "", /button "Archived"/),
        element: "Archived",
      });
      expect(disabled).toMatchObject({ ok: false, outcome: "not_actionable" });
      expect(disabled.message).toContain("disabled");
      const covered = await tools.run("browser.navigate", { callId: "c", url: `${base}/covered` });
      const under = await tools.run("browser.click", {
        callId: "c",
        ref: refOf(covered.snapshot?.text ?? "", /button "Under"/),
        element: "Under",
      });
      expect(under).toMatchObject({ ok: false, outcome: "not_actionable" });
      expect(under.message).toContain("covers");
      // Playwright alone would wait out its 10 s action timeout on each.
      expect(Date.now() - started).toBeLessThan(5_000);
    }, 60_000);

    test("a ref from before a navigation is refused at once", async () => {
      const nav = await tools.run("browser.navigate", { callId: "c", url: `${base}/form` });
      const next = refOf(nav.snapshot?.text ?? "", /link "Next page"/);
      const old = refOf(nav.snapshot?.text ?? "", /button "Save"/);
      const moved = await tools.run("browser.click", {
        callId: "c",
        ref: next,
        element: "Next page",
        expect: { urlIncludes: "/next" },
      });
      expect(moved).toMatchObject({ ok: true, verified: true });
      const started = Date.now();
      const stale = (await tools.run("browser.click", {
        callId: "c",
        ref: old,
        element: "Save",
      })) as BrowserActionResult;
      expect(stale.outcome).toBe("stale_ref");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(stale.snapshot?.text).toContain('button "Other"');
    }, 60_000);

    test("a screenshot is a JPEG of the viewport", async () => {
      const shot = await tools.run("browser.screenshot", { callId: "c" });
      expect(shot.mimeType).toBe("image/jpeg");
      expect(shot.width).toBeGreaterThan(100);
      expect(shot.height).toBeGreaterThan(100);
      expect(Buffer.from(shot.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    }, 60_000);

    test("after the browser restarts, the next call reconnects and old refs are stale", async () => {
      const nav = await tools.run("browser.navigate", { callId: "c", url: `${base}/form` });
      const old = refOf(nav.snapshot?.text ?? "", /button "Save"/);
      const before = driver.connects;
      await killChrome();
      await startChrome();
      const stale = await tools.run("browser.click", { callId: "c", ref: old, element: "Save" });
      expect(stale.outcome).toBe("stale_ref");
      expect(driver.connects).toBe(before + 1);
      const again = await tools.run("browser.navigate", { callId: "c", url: `${base}/next` });
      expect(again.outcome).toBe("done");
    }, 60_000);
  },
);

describe("no browser on the CDP port", () => {
  test("a call fails with browser.unavailable after the connect timeout, and the next one dials again", async () => {
    // A port nobody listens on: bind one, then close it.
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const driver = new PlaywrightDriver({
      endpoint: `http://127.0.0.1:${port}`,
      connectTimeoutMs: 600,
    });
    const tools = new BrowserTools({ driver, root: "/nonexistent" });
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      const error = await tools.run("browser.snapshot", { callId: "c" }).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("browser.unavailable");
      // It kept dialing for the whole connect timeout, not one refused attempt.
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
    expect(driver.connects).toBe(0);
  }, 20_000);
});
