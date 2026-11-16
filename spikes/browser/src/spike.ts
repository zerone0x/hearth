/**
 * Throwaway spike for issue #107: drive a CDP-enabled Chromium from Bun with
 * playwright-core's connectOverCDP, the way box-agent would drive the box's
 * browser on 127.0.0.1:9222 (DECISIONS 0026). Not for merge.
 *
 * It starts a static server for ./fixtures, starts Chromium with CDP on
 * loopback (like the box entrypoint does), connects over CDP and runs
 * snapshot -> act (by ref) -> verify through a tiny tool layer shaped like the
 * proposed `browser.*` tools. The "model" is scripted: it reads refs out of
 * the snapshot text with a regex.
 *
 *   CHROMIUM=/path/to/chrome bun src/spike.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";

const CHROMIUM = process.env.CHROMIUM ?? "chromium";
const CDP_PORT = Number(process.env.SPIKE_CDP_PORT ?? 9333);
const FIXTURES = join(import.meta.dir, "..", "fixtures");

// ---- box side: fake vault. The model only ever names "vault:fixture-login".
const VAULT: Record<string, { username: string; password: string }> = {
  "vault:fixture-login": { username: "alice", password: "correct horse" },
};

// ---- tool layer -----------------------------------------------------------

interface Expect {
  /** Substring of the page URL after the action. */
  urlIncludes?: string;
  /** Text that must be visible on the page after the action. */
  textVisible?: string;
}

interface ActResult {
  ok: boolean;
  verified: boolean | null;
  error?: string;
  url: string;
  title: string;
  ms: number;
}

async function snapshot(page: Page) {
  const t0 = performance.now();
  const text = await page.ariaSnapshot({ mode: "ai", timeout: 5000 });
  return {
    url: page.url(),
    title: await page.title(),
    snapshot: text,
    chars: text.length,
    ms: Math.round(performance.now() - t0),
  };
}

async function verify(page: Page, expect: Expect, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const urlOk = expect.urlIncludes === undefined || page.url().includes(expect.urlIncludes);
    let textOk = true;
    if (expect.textVisible !== undefined) {
      textOk = await page
        .getByText(expect.textVisible)
        .first()
        .isVisible()
        .catch(() => false);
    }
    if (urlOk && textOk) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

type Action =
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; value: string }
  | { kind: "fillSecret"; ref: string; secret: string; field: "username" | "password" }
  | { kind: "select"; ref: string; value: string }
  | { kind: "check"; ref: string };

async function act(page: Page, action: Action, expect?: Expect): Promise<ActResult> {
  const t0 = performance.now();
  const target = page.getByRef(action.ref);
  try {
    switch (action.kind) {
      case "click":
        await target.click({ timeout: 3000 });
        break;
      case "fill":
        await target.fill(action.value, { timeout: 3000 });
        break;
      case "fillSecret": {
        const entry = VAULT[action.secret];
        if (!entry) throw new Error(`unknown secret ${action.secret}`);
        await target.fill(entry[action.field], { timeout: 3000 });
        break;
      }
      case "select":
        await target.selectOption(action.value, { timeout: 3000 });
        break;
      case "check":
        await target.check({ timeout: 3000 });
        break;
    }
  } catch (error) {
    return {
      ok: false,
      verified: null,
      error: (error as Error).message.split("\n")[0],
      url: page.url(),
      title: await page.title(),
      ms: Math.round(performance.now() - t0),
    };
  }
  const verified = expect ? await verify(page, expect, 3000) : null;
  return {
    ok: verified !== false,
    verified,
    url: page.url(),
    title: await page.title(),
    ms: Math.round(performance.now() - t0),
  };
}

async function screenshot(page: Page) {
  const jpeg = await page.screenshot({ type: "jpeg", quality: 60, timeout: 5000 });
  const png = await page.screenshot({ type: "png", timeout: 5000 });
  return { jpegBytes: jpeg.byteLength, pngBytes: png.byteLength };
}

// ---- scripted "model": read a ref from the snapshot ------------------------

function ref(snap: string, role: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = snap.match(new RegExp(`${role} "${escaped}"[^\\n]*\\[ref=(\\w+)\\]`));
  if (!m?.[1]) throw new Error(`no ${role} "${name}" in snapshot:\n${snap}`);
  return m[1];
}

// ---- harness ---------------------------------------------------------------

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("CDP did not come up");
}

async function main() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/+/, "") || "login.html";
      if (!/^[a-z]+\.html$/.test(path)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(join(FIXTURES, path)));
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const profile = mkdtempSync(join(tmpdir(), "spike-browser-"));
  // Like the box entrypoint (0026): CDP on loopback only, own profile.
  const chrome = spawn(
    CHROMIUM,
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1280,800",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  let browser: Browser | undefined;
  try {
    await waitForCdp(CDP_PORT, 15000);
    const t0 = performance.now();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    console.log(`connectOverCDP: ${Math.round(performance.now() - t0)} ms`);
    // Reuse the browser's default context and its tab, as box-agent would
    // with the desktop browser the owner can watch.
    const context = browser.contexts()[0];
    if (!context) throw new Error("no default context");
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(`${base}/login.html`);
    let s = await snapshot(page);
    console.log(`\n# snapshot 1 (${s.chars} chars, ${s.ms} ms) ${s.url}\n${s.snapshot}`);
    const shot = await screenshot(page);
    console.log(`screenshot 1280x800: jpeg q60 ${shot.jpegBytes} B, png ${shot.pngBytes} B`);

    // 1. Wrong password: the action "succeeds" but the check says no.
    const user = ref(s.snapshot, "textbox", "Username");
    const pass = ref(s.snapshot, "textbox", "Password");
    const signIn = ref(s.snapshot, "button", "Sign in");
    console.log("\nfill username:", await act(page, { kind: "fill", ref: user, value: "alice" }));
    console.log("fill password:", await act(page, { kind: "fill", ref: pass, value: "wrong" }));
    const bad = await act(page, { kind: "click", ref: signIn }, { urlIncludes: "/profile.html" });
    console.log("click Sign in, expect /profile.html:", bad);
    s = await snapshot(page);
    console.log(`\n# snapshot 2 after failed sign-in (${s.chars} chars)\n${s.snapshot}`);

    // 2. Sign in with a vault reference; the model never sees the password.
    console.log(
      "\nfillSecret username:",
      await act(page, { kind: "fillSecret", ref: user, secret: "vault:fixture-login", field: "username" }),
    );
    console.log(
      "fillSecret password:",
      await act(page, { kind: "fillSecret", ref: pass, secret: "vault:fixture-login", field: "password" }),
    );
    s = await snapshot(page);
    console.log(
      `snapshot after secret fill contains the password: ${s.snapshot.includes("correct horse")}; contains the username: ${s.snapshot.includes("alice")}`,
    );
    const good = await act(
      page,
      { kind: "click", ref: signIn },
      { urlIncludes: "/profile.html", textVisible: "Welcome, alice" },
    );
    console.log("click Sign in, expect /profile.html + 'Welcome, alice':", good);

    // 3. A ref from the previous document is stale after navigation.
    console.log("\nstale ref click:", await act(page, { kind: "click", ref: signIn }));

    // 4. Multi-field form, then a delayed result.
    s = await snapshot(page);
    console.log(`\n# snapshot 3 (${s.chars} chars, ${s.ms} ms) ${s.url}\n${s.snapshot}`);
    const steps: Array<[Action, Expect | undefined]> = [
      [{ kind: "fill", ref: ref(s.snapshot, "textbox", "Full name"), value: "Alice Example" }, undefined],
      [{ kind: "fill", ref: ref(s.snapshot, "textbox", "Email"), value: "alice@example.test" }, undefined],
      [{ kind: "select", ref: ref(s.snapshot, "combobox", "Plan"), value: "Pro" }, undefined],
      [
        { kind: "click", ref: ref(s.snapshot, "button", "Save profile") },
        { textVisible: "Saved:" },
      ],
    ];
    for (const [a, e] of steps) console.log(a.kind, a.ref, "->", await act(page, a, e));
    const terms = ref(s.snapshot, "checkbox", "I agree to the terms");
    console.log("check terms ->", await act(page, { kind: "check", ref: terms }));
    const save = ref(s.snapshot, "button", "Save profile");
    console.log(
      "click Save again, expect 'Saved: Alice Example <alice@example.test> on Pro' ->",
      await act(page, { kind: "click", ref: save }, { textVisible: "Saved: Alice Example <alice@example.test> on Pro" }),
    );
    s = await snapshot(page);
    console.log(`\n# final snapshot (${s.chars} chars)\n${s.snapshot}`);
  } finally {
    // Disconnect only: connectOverCDP's close() detaches and leaves the
    // browser running, which is what box-agent must do with the desktop browser.
    await browser?.close();
    if (chrome.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
