/**
 * The web UI's e2e (#46) against a real hub (harness.ts) in Chromium:
 * first-run setup → sign out → sign in → Settings: add a model key, save the
 * model with it, rotate the key, add a token usable by box commands and rotate
 * it back off, delete another secret, set the access mode default → create a
 * session → set its access mode override in the header → send a message →
 * see the tool card → open the desktop → take it over, type, release → reload, and the session continues
 * (the chat is rebuilt from the event log and a second turn runs) → the box
 * goes away and the desktop says it is asleep → wake. Along the way: the
 * chat and noVNC load only when needed (#84), a link in a reply opens in a new
 * tab, the action bar has no regenerate or edit but exports Markdown, an
 * interrupted tool call shows as interrupted, and a session page chunk that
 * fails to load (404) leaves the app shell with a Reload button.
 *
 *   bun run build:web && bun run e2e:web
 *
 * Env: `HEARTH_E2E_CHROMIUM` (a Chromium/headless-shell binary; default:
 * Playwright's own), `HEARTH_E2E_SCREENSHOTS` (a directory for screenshots at
 * device scale factor 2). Exits non-zero on the first failed step.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_WORKSPACE_ID } from "@hearth/core";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { startE2eHub } from "./harness";

const WEB_ROOT = join(import.meta.dir, "../dist");
/** The badge a token usable by box commands carries (SettingsPage.tsx `BOX_ENV_WARNING`). */
const BOX_ENV_WARNING = "visible to commands in the box";
const PASSWORD = "correct horse battery staple";
const STEP_MS = 15_000;

/** The lazy chunks (#84): the session page (chat, markdown) and noVNC's RFB client. */
const SESSION_CHUNK = /\/assets\/SessionPage-[^/]*\.js$/;
const NOVNC_CHUNK = /\/assets\/rfb-[^/]*\.js$/;

const shots = process.env["HEARTH_E2E_SCREENSHOTS"];
if (shots) mkdirSync(shots, { recursive: true });

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

function step(name: string): void {
  console.log(`e2e: ${name}`);
}

/** Every CSP violation any page of the run reports; the run fails on any. */
const cspViolations: string[] = [];

/**
 * Collects CSP violations from every page of `context`, two ways. A
 * `securitypolicyviolation` listener installed before any page script runs
 * sees each blocked load or eval, even one the page code catches
 * (`try { new Function("") } catch {}` logs nothing to the console). The
 * console listener stays as a second net for reports the event misses.
 */
async function watchCsp(context: BrowserContext): Promise<void> {
  await context.exposeBinding("__hearthCspViolation", (_source, report: string) => {
    cspViolations.push(report);
  });
  // A string, not a function: this project has no DOM types. It runs in the
  // page before any of the page's scripts, and Playwright's injection is not
  // itself subject to the page's CSP.
  await context.addInitScript({
    content: `document.addEventListener("securitypolicyviolation", (event) => {
      void globalThis.__hearthCspViolation(
        event.effectiveDirective + " blocked " + (event.blockedURI || "(inline)") +
          " at " + event.sourceFile + ":" + event.lineNumber + " on " + event.documentURI,
      );
    });`,
  });
  context.on("console", (msg) => {
    if (/Content Security Policy/i.test(msg.text())) cspViolations.push(msg.text());
  });
}

if (!existsSync(join(WEB_ROOT, "index.html"))) {
  console.error("e2e: apps/web/dist is missing; run `bun run build:web` first");
  process.exit(1);
}

const e2e = await startE2eHub(WEB_ROOT);
let browser: Browser | undefined;
let code = 0;
try {
  const executablePath = process.env["HEARTH_E2E_CHROMIUM"];
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  context.setDefaultTimeout(STEP_MS);
  await watchCsp(context);
  const page = await context.newPage();
  const base = e2e.url.toString();
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });
  const loaded = (chunk: RegExp) => scripts.some((path) => chunk.test(path));

  step("first-run setup with the setup token");
  await page.goto(base);
  await page.getByRole("heading", { name: "Set up Hearth" }).waitFor();
  await shot(page, "1-setup");
  await page.getByLabel("Setup token").fill(e2e.setupToken);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByRole("button", { name: "New session" }).waitFor();

  step("sign out, then sign in with the password");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.getByLabel("Password").fill("wrong password!!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").filter({ hasText: "wrong password" }).waitFor();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  step("sign-in and the session list load neither the chat nor noVNC");
  if (loaded(SESSION_CHUNK) || loaded(NOVNC_CHUNK)) {
    throw new Error(`the session list loaded a lazy chunk: ${scripts.join(", ")}`);
  }

  step(
    "settings: add a model key, save the model with it, rotate it, box-env token, delete a secret",
  );
  // Each dialog and select opens here, so a scroll lock's injected <style> (CSP) fails the run.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Secrets" }).waitFor();
  const addSecret = async (name: string, kind: string, value: string, boxEnv = false) => {
    await page.getByRole("button", { name: "Add secret" }).click();
    const form = page.getByRole("form", { name: "Add secret" });
    await form.getByLabel("Kind").selectOption({ label: kind });
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Value").fill(value);
    if (boxEnv) {
      const toggle = form.getByRole("switch", { name: "Usable by box commands" });
      await toggle.click();
      if ((await toggle.getAttribute("aria-checked")) !== "true") {
        throw new Error("the box-command switch did not turn on");
      }
      await form.getByText(BOX_ENV_WARNING).waitFor();
    }
    await form.getByRole("button", { name: "Add" }).click();
    await form.getByRole("status").filter({ hasText: "Saved. Fingerprint" }).waitFor();
    await page.keyboard.press("Escape");
    await form.waitFor({ state: "detached" });
    await page.getByTestId("secret-row").filter({ hasText: name }).waitFor();
  };
  await addSecret("e2e-model-key", "Model key", "sk-e2e-model-key-1");
  await addSecret("e2e-token", "Token", "e2e-token-value-1");
  // A token usable by box commands (decision 0041): its row carries the warning badge
  // until a rotate turns the switch off.
  await addSecret("e2e-gh", "Token", "e2e-gh-value-1", true);
  const ghRow = page.getByTestId("secret-row").filter({ hasText: "e2e-gh" });
  await ghRow.getByText(BOX_ENV_WARNING).waitFor();
  if ((await page.getByTestId("secret-row").getByText(BOX_ENV_WARNING).count()) !== 1) {
    throw new Error("the box-command badge is on a row it does not belong to");
  }
  await ghRow.getByRole("button", { name: "Rotate" }).click();
  const rotateGh = page.getByRole("form", { name: "Rotate secret" });
  const ghToggle = rotateGh.getByRole("switch", { name: "Usable by box commands" });
  if ((await ghToggle.getAttribute("aria-checked")) !== "true") {
    throw new Error("the rotate dialog does not show the token as usable by box commands");
  }
  await ghToggle.click();
  await rotateGh.getByLabel("Value").fill("e2e-gh-value-2");
  await rotateGh.getByRole("button", { name: "Rotate" }).click();
  await rotateGh.getByRole("status").filter({ hasText: "Rotated to version 2" }).waitFor();
  await page.keyboard.press("Escape");
  await rotateGh.waitFor({ state: "detached" });
  await ghRow.getByText(BOX_ENV_WARNING).waitFor({ state: "detached" });
  const model = page.getByRole("form", { name: "Model" });
  await model.getByLabel("Provider").fill("faux");
  await model.getByLabel("Model").fill(e2e.faux.getModel().id);
  await model.getByLabel("Key").click();
  await model.getByLabel("Key").selectOption("vault:e2e-model-key");
  await model.getByRole("button", { name: "Save" }).click();
  await model
    .getByRole("status")
    .filter({ hasText: `Saved. New turns use faux/${e2e.faux.getModel().id}.` })
    .waitFor();
  await page
    .getByTestId("secret-row")
    .filter({ hasText: "e2e-model-key" })
    .getByRole("button", { name: "Rotate" })
    .click();
  const rotate = page.getByRole("form", { name: "Rotate secret" });
  await rotate.getByLabel("Value").fill("sk-e2e-model-key-2");
  await rotate.getByRole("button", { name: "Rotate" }).click();
  await rotate.getByRole("status").filter({ hasText: "Rotated to version 2" }).waitFor();
  await page.keyboard.press("Escape");
  await rotate.waitFor({ state: "detached" });
  await page
    .getByTestId("secret-row")
    .filter({ hasText: "e2e-token" })
    .getByRole("button", { name: "Delete" })
    .click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await page
    .getByTestId("secret-row")
    .filter({ hasText: "e2e-token" })
    .waitFor({ state: "detached" });
  // The access mode default (decision 0045): `ask` until saved, then `yolo` for this run.
  const access = page.getByRole("form", { name: "Access mode" });
  const accessSelect = access.getByLabel("Default for sessions");
  if ((await accessSelect.inputValue()) !== "ask") {
    throw new Error("a new install does not default to the ask access mode");
  }
  await accessSelect.click();
  await accessSelect.selectOption("yolo");
  await access.getByRole("button", { name: "Save" }).click();
  await access
    .getByRole("status")
    .filter({ hasText: "Sessions that follow the default use yolo" })
    .waitFor();
  await shot(page, "1b-settings");
  for (const value of [
    "sk-e2e-model-key-1",
    "sk-e2e-model-key-2",
    "e2e-token-value-1",
    "e2e-gh-value-1",
    "e2e-gh-value-2",
  ]) {
    if ((await page.content()).includes(value)) throw new Error("a secret value is in the page");
  }
  if (cspViolations.length > 0) {
    throw new Error(`CSP violations on Settings: ${cspViolations.join("; ")}`);
  }
  await page.goto(base);
  await page.getByRole("button", { name: "New session" }).waitFor();

  step("create a session");
  await page.getByLabel("New session title").fill("Say hello");
  await page.getByRole("button", { name: "New session" }).click();
  await page.waitForURL(/#\/s\//);
  const sessionUrl = page.url();
  const sessionId = decodeURIComponent(sessionUrl.split("#/s/")[1] ?? "");

  step("the session header shows the access mode; the override applies to the next tool call");
  const accessMode = page.getByTestId("access-mode");
  const sessionAccess = page.getByLabel("Access", { exact: true });
  await accessMode.and(page.locator('[data-mode="yolo"]')).waitFor();
  if ((await sessionAccess.locator("option:checked").textContent()) !== "Default (yolo)") {
    throw new Error("the session header does not show that it follows the yolo default");
  }
  await sessionAccess.click();
  await sessionAccess.selectOption("ask");
  await accessMode.and(page.locator('[data-mode="ask"]')).waitFor();
  if (e2e.hub.accessModes.resolve(sessionId) !== "ask") {
    throw new Error("the session's override did not reach the hub's resolver");
  }

  step("send a message; the tool call shows as a card");
  e2e.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "bash",
          { command: "echo 'hello from the box' > hello.txt && cat hello.txt" },
          { id: "call_hello" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("I wrote hello.txt in the workspace."),
  ]);
  await page.getByLabel("Message").fill("Write hello.txt and show it");
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByTestId("tool-card").first();
  await card.and(page.locator('[data-status="ok"]')).waitFor();
  await page.getByText("I wrote hello.txt in the workspace.").waitFor();
  await card.getByRole("button", { name: "Tool call bash: done" }).click();
  await card
    .locator('[data-slot="tool-fallback-result"]', { hasText: "hello from the box" })
    .waitFor();
  if (readFileSync(join(e2e.workspace, "hello.txt"), "utf8") !== "hello from the box\n") {
    throw new Error("the tool call did not run in the box's workspace");
  }
  // The call ran under the session's override, and its record says so (decision 0045).
  const steps = await e2e.hub.events.read(
    { workspaceId: DEFAULT_WORKSPACE_ID },
    sessionId,
    0,
    1000,
  );
  const recorded = steps.events
    .filter((e) => e.type === "runner.step")
    .map((e) => e.payload as { kind?: string; access_mode?: unknown })
    .filter((p) => p.kind === "tool_call")
    .map((p) => p.access_mode);
  if (JSON.stringify(recorded) !== '["ask"]') {
    throw new Error(`the tool call's access_mode is ${JSON.stringify(recorded)}, not ["ask"]`);
  }
  if (!steps.events.some((e) => e.type === "session.access_mode")) {
    throw new Error("the override wrote no session.access_mode event");
  }
  // Back to following the default.
  await sessionAccess.selectOption("default");
  await accessMode.and(page.locator('[data-mode="yolo"]')).waitFor();

  if (!loaded(SESSION_CHUNK)) throw new Error("the session page chunk never loaded");
  if (loaded(NOVNC_CHUNK)) throw new Error("noVNC loaded before the desktop was opened");
  // Hearth cannot regenerate or edit yet: the registry's buttons for them stay out.
  for (const name of ["Refresh", "Edit"]) {
    if ((await page.getByRole("button", { name, exact: true }).count()) !== 0) {
      throw new Error(`the action bar shows an unsupported "${name}" button`);
    }
  }
  await page.getByRole("button", { name: "Copy", exact: true }).first().waitFor();

  step('the "…" menu exports the reply as Markdown, in the browser');
  await page.getByText("I wrote hello.txt in the workspace.").hover();
  await page.getByRole("button", { name: "More", exact: true }).last().click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
  const exported = await (await download).path();
  if (!readFileSync(exported, "utf8").includes("I wrote hello.txt in the workspace.")) {
    throw new Error("Export as Markdown should download the reply's text");
  }

  step("open the view-only desktop");
  await page.getByRole("button", { name: "Open desktop" }).click();
  await page.locator('[data-testid="desktop"][data-phase="open"] canvas').waitFor();
  if (!loaded(NOVNC_CHUNK)) throw new Error("the desktop opened without loading the noVNC chunk");
  await page.waitForTimeout(500);
  await shot(page, "2-session-desktop");

  step("take over the desktop: typing reaches the box; release: it no longer does");
  const desktopRegion = page.getByRole("region", { name: "Desktop" });
  const keysym = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
  // View-only before Take over: nothing typed reaches the desktop.
  await desktopRegion.locator("canvas").click();
  await page.keyboard.type("no");
  await page.waitForTimeout(300);
  if (e2e.vncInput.keys.length !== 0 || e2e.vncInput.pointers !== 0) {
    throw new Error(`view-only input reached the desktop: ${JSON.stringify(e2e.vncInput)}`);
  }
  await page.getByRole("button", { name: "Take over" }).click();
  await page.getByRole("button", { name: "Release" }).waitFor();
  await desktopRegion.locator("canvas").click();
  await page.keyboard.type("hearth");
  const typed = keysym("hearth");
  for (let i = 0; i < 50 && e2e.vncInput.keys.length < typed.length; i++) {
    await page.waitForTimeout(100);
  }
  if (JSON.stringify(e2e.vncInput.keys) !== JSON.stringify(typed)) {
    throw new Error(`typed keys did not reach the desktop: ${JSON.stringify(e2e.vncInput.keys)}`);
  }
  if (e2e.vncInput.pointers === 0) throw new Error("the click did not reach the desktop");
  await shot(page, "2b-desktop-in-control");
  await page.getByRole("button", { name: "Release" }).click();
  await page.getByRole("button", { name: "Take over" }).waitFor();
  const before = { keys: e2e.vncInput.keys.length, pointers: e2e.vncInput.pointers };
  await desktopRegion.locator("canvas").click();
  await page.keyboard.type("after");
  await page.waitForTimeout(300);
  if (e2e.vncInput.keys.length !== before.keys || e2e.vncInput.pointers !== before.pointers) {
    throw new Error("input reached the desktop after Release");
  }

  step("reload: the chat is rebuilt from the event log and the session continues");
  await page.reload();
  await page.getByText("I wrote hello.txt in the workspace.").waitFor();
  if ((await page.getByTestId("tool-card").count()) !== 1) {
    throw new Error("after a reload the chat should show the one tool card again");
  }
  e2e.faux.setResponses([fauxAssistantMessage("Still here: hello.txt says hello from the box.")]);
  await page.getByLabel("Message").fill("Are you still there?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("Still here: hello.txt says hello from the box.").waitFor();
  if (page.url() !== sessionUrl) throw new Error("the reload should stay on the session");

  step("a link in a reply opens in a new tab");
  e2e.faux.setResponses([fauxAssistantMessage("See [the pi docs](https://example.com/pi).")]);
  await page.getByLabel("Message").fill("Where are the docs?");
  await page.getByRole("button", { name: "Send" }).click();
  const link = page.getByRole("link", { name: "the pi docs" });
  await link.waitFor();
  if (
    (await link.getAttribute("target")) !== "_blank" ||
    (await link.getAttribute("rel")) !== "noopener noreferrer"
  ) {
    throw new Error("a link in a reply should open in a new tab, without opener or referrer");
  }

  step("interrupt a running tool call: its card says interrupted, not error");
  e2e.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "call_sleep" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("This turn was interrupted, so this never shows."),
  ]);
  await page.getByLabel("Message").fill("Sleep for a while");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Tool call bash: running" }).waitFor();
  await page.getByRole("button", { name: "Interrupt" }).click();
  const cut = page.getByTestId("tool-card").and(page.locator('[data-status="interrupted"]'));
  await cut.getByRole("button", { name: "Tool call bash: interrupted" }).waitFor();
  await page.getByRole("button", { name: "Send" }).waitFor();
  if ((await page.locator('[data-testid="tool-card"][data-status="error"]').count()) !== 0) {
    throw new Error("an interrupted tool call should not show as an error");
  }
  // The composer floats over the bottom of the thread: centre the card for the shot
  // (instantly: the viewport scrolls smoothly).
  await cut.evaluate("(card) => card.scrollIntoView({ block: 'center', behavior: 'instant' })");
  await shot(page, "3-interrupted-tool");

  step("the box goes away: the desktop says it is asleep (4410), Wake reconnects");
  await page.getByRole("button", { name: "Open desktop" }).click();
  await page.locator('[data-testid="desktop"][data-phase="open"]').waitFor();
  await e2e.boxes.stopAll();
  await page.getByTestId("desktop-asleep").waitFor();
  await shot(page, "4-desktop-asleep");
  await page.getByRole("button", { name: "Wake" }).click();
  await page.locator('[data-testid="desktop"][data-phase="open"]').waitFor();

  step("mobile: sign in on a phone-sized screen and open the session list");
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  phone.setDefaultTimeout(STEP_MS);
  await watchCsp(phone);
  const mobile = await phone.newPage();
  await mobile.goto(base);
  await mobile.getByLabel("Password").fill(PASSWORD);
  await mobile.getByRole("button", { name: "Sign in" }).click();
  await mobile.getByTestId("session-row").first().waitFor();
  await shot(mobile, "5-mobile-sessions");
  await mobile.getByTestId("session-row").first().getByRole("link").click();
  await mobile.getByText("Still here: hello.txt says hello from the box.").waitFor();
  await shot(mobile, "6-mobile-session");

  step("the session page chunk 404s (a hub upgrade replaced it): the shell stays, Reload works");
  const stale = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  stale.setDefaultTimeout(STEP_MS);
  await watchCsp(stale);
  await stale.route(SESSION_CHUNK, (route) => route.fulfill({ status: 404, body: "gone" }));
  const failed = async (tab: Page, how: string) => {
    await tab
      .getByRole("alert")
      .filter({ hasText: "The session page did not load." })
      .waitFor()
      .catch(() => {
        throw new Error(`${how}: a session page chunk that 404s should show an alert`);
      });
    for (const [role, name] of [
      ["button", "Reload"],
      ["link", "Sessions"],
      ["button", "Sign out"],
    ] as const) {
      if (!(await tab.getByRole(role, { name, exact: true }).isVisible())) {
        throw new Error(`${how}: the "${name}" ${role} should stay visible`);
      }
    }
  };
  // Direct navigation: the tab opens on the session URL.
  const direct = await stale.newPage();
  await direct.goto(base);
  await direct.getByLabel("Password").fill(PASSWORD);
  await direct.getByRole("button", { name: "Sign in" }).click();
  await direct.getByTestId("session-row").first().waitFor();
  await direct.goto(sessionUrl);
  await failed(direct, "direct navigation");
  await shot(direct, "7-session-chunk-404");
  await direct.getByRole("link", { name: "Sessions", exact: true }).click();
  await direct.getByTestId("session-row").first().waitFor();
  // In-app navigation: a fresh tab opens the list, then the session from it.
  const inApp = await stale.newPage();
  await inApp.goto(base);
  await inApp.getByTestId("session-row").first().getByRole("link").click();
  await failed(inApp, "in-app navigation");
  // The chunk is back (the tab reloads onto the new build): Reload opens the session.
  await stale.unroute(SESSION_CHUNK);
  await inApp.getByRole("button", { name: "Reload", exact: true }).click();
  await inApp.getByText("Still here: hello.txt says hello from the box.").waitFor();
  await stale.close();

  if (cspViolations.length > 0) {
    throw new Error(`CSP violations: ${cspViolations.join("; ")}`);
  }
  step("passed");
} catch (error) {
  code = 1;
  console.error(`e2e failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
} finally {
  step("closing the browser");
  await browser?.close();
  step("stopping the hub");
  await e2e.stop();
}
process.exit(code);
