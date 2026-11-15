/**
 * The web UI's e2e (#46) against a real hub (harness.ts) in Chromium:
 * first-run setup → sign out → sign in → create a session → send a message →
 * see the tool card → open the desktop → reload, and the session continues
 * (the chat is rebuilt from the event log and a second turn runs) → the box
 * goes away and the desktop says it is asleep → wake.
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
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { startE2eHub } from "./harness";

const WEB_ROOT = join(import.meta.dir, "../dist");
const PASSWORD = "correct horse battery staple";
const STEP_MS = 15_000;

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

  step("create a session");
  await page.getByLabel("New session title").fill("Say hello");
  await page.getByRole("button", { name: "New session" }).click();
  await page.waitForURL(/#\/s\//);
  const sessionUrl = page.url();

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
  await card.locator("summary").click();
  await card.locator("pre", { hasText: "hello from the box" }).waitFor();
  if (readFileSync(join(e2e.workspace, "hello.txt"), "utf8") !== "hello from the box\n") {
    throw new Error("the tool call did not run in the box's workspace");
  }

  step("open the view-only desktop");
  await page.getByRole("button", { name: "Open desktop" }).click();
  await page.locator('[data-testid="desktop"][data-phase="open"] canvas').waitFor();
  await page.waitForTimeout(500);
  await shot(page, "2-session-desktop");

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

  step("the box goes away: the desktop says it is asleep (4410), Wake reconnects");
  await page.getByRole("button", { name: "Open desktop" }).click();
  await page.locator('[data-testid="desktop"][data-phase="open"]').waitFor();
  await e2e.boxes.stopAll();
  await page.getByTestId("desktop-asleep").waitFor();
  await shot(page, "3-desktop-asleep");
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
  await shot(mobile, "4-mobile-sessions");
  await mobile.getByTestId("session-row").first().getByRole("link").click();
  await mobile.getByText("Still here: hello.txt says hello from the box.").waitFor();
  await shot(mobile, "5-mobile-session");

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
