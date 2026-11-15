/**
 * The prototype exit e2e (PRD §11.1, #47, decision 0020) against a hub
 * installed with deploy/compose.yaml by following docs/install.md. CI runs it
 * on a GitHub runner after `docker compose up`; the model is the faux model
 * server (faux-model.ts) that the install's models file points at.
 *
 *   bun deploy/e2e/prototype.ts install    # exit criteria on a fresh install
 *   bun deploy/e2e/prototype.ts upgrade    # after `docker compose up --build` again
 *
 * The UI is driven by role, label and accessible name only (getByRole,
 * getByLabel), so a rewrite of apps/web that keeps those names keeps this test.
 *
 * Env:
 * - `HEARTH_URL` (default http://127.0.0.1:8787): the hub as the owner opens it.
 * - `HEARTH_SETUP_TOKEN` (install): the setup token from the hub's log.
 * - `HEARTH_FAUX_URL` (default http://127.0.0.1:18080): the faux model server.
 * - `HEARTH_FAUX_KEY`: the key written to deploy/secrets/model_key; the faux
 *   model must have received it as the bearer token.
 * - `HEARTH_E2E_STATE` (default $TMPDIR/hearth-compose-e2e.json): what the
 *   install phase hands to the upgrade phase (password, session).
 * - `HEARTH_E2E_SCREENSHOTS`: a directory for screenshots.
 * - `HEARTH_E2E_CHROMIUM`: a Chromium binary instead of Playwright's.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { FauxReply, FauxRequest } from "./faux-model";

const BASE = new URL(process.env["HEARTH_URL"] ?? "http://127.0.0.1:8787/");
const FAUX = process.env["HEARTH_FAUX_URL"] ?? "http://127.0.0.1:18080";
const STATE = process.env["HEARTH_E2E_STATE"] ?? join(tmpdir(), "hearth-compose-e2e.json");
const PASSWORD = "compose e2e owner password";
const TITLE = "Prototype exit";
/** A cold box start (container, desktop, box-agent dial-in) is part of the first turn. */
const TURN_MS = 120_000;
const STEP_MS = 30_000;

const shots = process.env["HEARTH_E2E_SCREENSHOTS"];
if (shots) mkdirSync(shots, { recursive: true });

interface State {
  readonly sessionUrl: string;
  readonly sessionId: string;
}

function step(name: string): void {
  console.log(`e2e: ${name}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function script(replies: FauxReply[]): Promise<void> {
  const res = await fetch(`${FAUX}/faux/script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(replies),
  });
  check(res.ok, `the faux model refused the script: ${res.status}`);
}

async function fauxRequests(): Promise<FauxRequest[]> {
  return (await (await fetch(`${FAUX}/faux/requests`)).json()) as FauxRequest[];
}

/** Runs `docker` on the host (the e2e runs next to the install). */
function docker(...args: string[]): string {
  const out = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${out.stderr.toString()}`);
  }
  return out.stdout.toString().trim();
}

/**
 * Files in the session box that contain `key`: every process's environment
 * and every file under /workspace, /home and /tmp. Runs as privileged root in
 * the box (the box drops every capability, and reading another user's
 * environment needs CAP_SYS_PTRACE), so no process is hidden. The key is an
 * argument of the scanning shell, never in its environment.
 */
function keyInBox(box: string, key: string): string[] {
  const scan = [
    'key="$1"',
    'grep -lsF -e "$key" /proc/[0-9]*/environ',
    'grep -rlsF -e "$key" /workspace /home /tmp',
    "true",
  ].join("; ");
  const out = docker("exec", "--privileged", "-u", "0", box, "sh", "-c", scan, "sh", key);
  return out === "" ? [] : out.split("\n");
}

async function signIn(page: Page): Promise<void> {
  await page.goto(BASE.toString());
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New session" }).waitFor();
}

/**
 * A finished tool call in the chat. The current UI shows it as a `<details>`
 * group whose summary has the tool, its target and the status; the UI of #77
 * names it as a button, "Tool call <tool>: done". Either one counts.
 */
function toolDone(page: Page, tool: string, target: string) {
  return page
    .getByRole("button", { name: `Tool call ${tool}: done` })
    .or(page.getByRole("group").filter({ hasText: tool }).filter({ hasText: target }))
    .filter({ hasText: "done" })
    .first();
}

/** Opens a tool call to show its output, in either UI (see `toolDone`). */
async function expandTool(page: Page, tool: string, target: string): Promise<void> {
  const named = page.getByRole("button", { name: `Tool call ${tool}: done` });
  if ((await named.count()) > 0) await named.first().click();
  else await page.getByRole("group").filter({ hasText: target }).getByText(target).click();
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(STEP_MS);
  return context;
}

async function install(browser: Browser): Promise<void> {
  const setupToken = process.env["HEARTH_SETUP_TOKEN"];
  check(setupToken !== undefined && setupToken !== "", "HEARTH_SETUP_TOKEN is required");

  step("1. a fresh compose up gives a working hub: /healthz, then the setup page");
  const health = await fetch(new URL("/healthz", BASE));
  check(health.ok, `/healthz answered ${health.status}`);
  const healthBody = (await health.json()) as { boxEgress?: string };
  check(healthBody.boxEgress === "filtered", `boxEgress is ${healthBody.boxEgress}, not filtered`);
  const context = await newContext(browser);
  let page = await context.newPage();
  await page.goto(BASE.toString());
  await page.getByRole("heading", { name: "Set up Hearth" }).waitFor();
  await shot(page, "1-setup");

  step("2. log in: set the owner password with the setup token, sign out, sign in");
  await page.getByLabel("Setup token").fill(setupToken ?? "");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page);

  step("3. create a session in the web UI");
  await page.getByLabel("New session title").fill(TITLE);
  await page.getByRole("button", { name: "New session" }).click();
  await page.waitForURL(/#\/s\//);
  const sessionUrl = page.url();
  const sessionId = decodeURIComponent(new URL(sessionUrl).hash.replace(/^#\/s\//, ""));
  check(sessionId.length > 0, `no session id in ${sessionUrl}`);

  step("4. pi edits a file and runs a command in the box's /workspace; the chat shows both");
  const before = (await fauxRequests()).length;
  await script([
    {
      toolCalls: [
        {
          id: "call_write",
          name: "write",
          arguments: { path: "hello.txt", content: "hello from the compose box\n" },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_bash",
          name: "bash",
          arguments: { command: "pwd && cat hello.txt && uname -n" },
        },
      ],
    },
    { text: "Wrote hello.txt in /workspace and read it back." },
  ]);
  await page.getByLabel("Message").fill("Write hello.txt, then show it");
  await page.getByRole("button", { name: "Send" }).click();
  await page
    .getByText("Wrote hello.txt in /workspace and read it back.")
    .waitFor({ timeout: TURN_MS });
  await toolDone(page, "write", "hello.txt").waitFor();
  await toolDone(page, "bash", "pwd && cat hello.txt").waitFor();
  await expandTool(page, "bash", "pwd && cat hello.txt");
  // The command's output: it ran in /workspace and read the file written there.
  await page.getByText(/^\s*\/workspace\s+hello from the compose box\s/).waitFor();
  await shot(page, "2-tool-calls");
  const requests = (await fauxRequests()).slice(before);
  check(requests.length === 3, `expected 3 model requests for the turn, got ${requests.length}`);
  const key = process.env["HEARTH_FAUX_KEY"];
  if (key !== undefined) {
    check(
      requests.every((r) => r.authorization === `Bearer ${key}`),
      "the hub did not send the key from deploy/secrets/model_key",
    );
  }
  // The file is in the box's workspace volume, not on the hub: read it from
  // the session's box container, found by the provider's labels (0007).
  const box = docker(
    "ps",
    "-q",
    "--filter",
    "label=dev.hearth.managed=true",
    "--filter",
    `label=dev.hearth.session.id=${sessionId}`,
  );
  check(box !== "" && !box.includes("\n"), `expected one running box for ${sessionId}: "${box}"`);
  const content = docker("exec", box, "cat", "/workspace/hello.txt");
  check(content === "hello from the compose box", `the box's /workspace/hello.txt is "${content}"`);
  // The box runs no model credentials (PRD §8): the key is not in its
  // configured environment, in any running process's environment, or in a
  // file under /workspace, /home or /tmp.
  if (key !== undefined) {
    const env = docker("inspect", "--format", "{{json .Config.Env}}", box);
    check(!env.includes(key), "the model key reached the box's environment");
    const found = keyInBox(box, key);
    check(found.length === 0, `the model key is in the box: ${found.join(", ")}`);
    // Positive controls: the same scan finds the key once it is there, in the
    // environment of a process of the box user (uid 1000, not the scanner's)
    // and in a file, so the empty result above is real.
    const canaryPid = "/workspace/.hearth-e2e-canary.pid";
    docker(
      "exec",
      "-d",
      "-u",
      "1000",
      "-e",
      `HEARTH_E2E_CANARY=${key}`,
      box,
      "sh",
      "-c",
      `echo $$ > ${canaryPid}; exec sleep 120`,
    );
    let inEnv: string[] = [];
    for (let i = 0; i < 40 && !inEnv.some((f) => /^\/proc\/\d+\/environ$/.test(f)); i++) {
      await Bun.sleep(250);
      inEnv = keyInBox(box, key);
    }
    docker("exec", "-u", "1000", box, "sh", "-c", `kill "$(cat ${canaryPid})"; rm -f ${canaryPid}`);
    check(
      inEnv.some((f) => /^\/proc\/\d+\/environ$/.test(f)),
      `the scan missed the key in a box process's environment: ${inEnv.join(", ")}`,
    );
    const canaryFile = "/tmp/hearth-e2e-canary";
    docker("exec", "-u", "0", box, "sh", "-c", `printf %s "$1" > ${canaryFile}`, "sh", key);
    const inFile = keyInBox(box, key);
    docker("exec", "-u", "0", box, "rm", "-f", canaryFile);
    check(inFile.includes(canaryFile), `the scan missed the key in /tmp: ${inFile.join(", ")}`);
    const after = keyInBox(box, key);
    check(after.length === 0, `the canaries were not removed: ${after.join(", ")}`);
  }

  step("5. the box's desktop is visible");
  const desktop = page.getByRole("region", { name: "Desktop" });
  await desktop.getByRole("button", { name: "Open desktop" }).click();
  // Open: the status overlay and its buttons are gone, and noVNC drew the
  // box's framebuffer (Xvnc's 1280x800, HEARTH_SCREEN in the box image).
  await desktop.getByRole("button").waitFor({ state: "detached", timeout: TURN_MS });
  const canvas = desktop.locator("canvas");
  await canvas.waitFor();
  const size = await canvas.evaluate((c) => {
    const el = c as unknown as { width: number; height: number };
    return [el.width, el.height];
  });
  check(size[0] === 1280 && size[1] === 800, `desktop framebuffer is ${size.join("x")}`);
  check(await canvas.isVisible(), "the desktop canvas is not visible");
  await page.waitForTimeout(1000);
  await shot(page, "3-desktop");

  step("6. closing and reopening the page continues the session");
  await page.close();
  page = await context.newPage();
  await page.goto(BASE.toString());
  await page.getByRole("link", { name: new RegExp(TITLE) }).click();
  await page.getByText("Wrote hello.txt in /workspace and read it back.").waitFor();
  check(page.url() === sessionUrl, `reopened at ${page.url()}, not ${sessionUrl}`);
  await toolDone(page, "bash", "pwd && cat hello.txt").waitFor();
  await script([{ text: "Still here after the reload." }]);
  await page.getByLabel("Message").fill("Are you still there?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("Still here after the reload.").waitFor({ timeout: TURN_MS });
  await shot(page, "4-reopened");

  step("7. an unauthenticated or cross-origin request cannot create a session or run a command");
  await refusals(context, page, sessionId);

  writeFileSync(STATE, JSON.stringify({ sessionUrl, sessionId } satisfies State));
  await context.close();
}

/** Everything the session API holds right now, through the signed-in context. */
async function snapshot(context: BrowserContext, sessionId: string) {
  const origin = { origin: BASE.origin };
  const sessions = await context.request.get(new URL("/v1/sessions", BASE).toString(), {
    headers: origin,
  });
  check(sessions.ok(), `listing sessions answered ${sessions.status()}`);
  const events = await context.request.get(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=1000`, BASE).toString(),
    { headers: origin },
  );
  check(events.ok(), `reading events answered ${events.status()}`);
  return {
    sessions: JSON.stringify(await sessions.json()),
    events: JSON.stringify(await events.json()),
    model: (await fauxRequests()).length,
  };
}

async function refusals(context: BrowserContext, page: Page, sessionId: string): Promise<void> {
  const before = await snapshot(context, sessionId);
  const sessionsUrl = new URL("/v1/sessions", BASE).toString();
  const messagesUrl = new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
    BASE,
  ).toString();
  const json = { "content-type": "application/json", origin: BASE.origin };
  await script([{ toolCalls: [{ id: "call_evil", name: "bash", arguments: { command: "id" } }] }]);

  // No login: a fresh request context has no cookie.
  const anonymous = await (await import("playwright")).request.newContext();
  for (const [url, body] of [
    [sessionsUrl, { title: "anonymous" }],
    [messagesUrl, { text: "run id" }],
  ] as const) {
    const res = await anonymous.post(url, { headers: json, data: body });
    check(res.status() === 401, `unauthenticated POST ${url} answered ${res.status()}`);
  }
  await anonymous.dispose();

  // Signed in, but from another origin, or as a form/text post (CSRF shapes).
  for (const [url, body] of [
    [sessionsUrl, { title: "cross-origin" }],
    [messagesUrl, { text: "run id" }],
  ] as const) {
    const foreign = await context.request.post(url, {
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      data: body,
    });
    check(foreign.status() === 403, `cross-origin POST ${url} answered ${foreign.status()}`);
    const text = await context.request.post(url, {
      headers: { "content-type": "text/plain", origin: BASE.origin },
      data: JSON.stringify(body),
    });
    check(text.status() === 415, `text/plain POST ${url} answered ${text.status()}`);
  }

  // A real page on another origin (the faux model's port: same site, so the
  // SameSite=Strict cookie is sent, and only the Origin check stands).
  await page.goto(`${FAUX}/faux/blank`);
  const statuses = await page.evaluate(
    async ({ sessionsUrl, messagesUrl }) => {
      const out: string[] = [];
      for (const [url, body] of [
        [sessionsUrl, '{"title":"from another origin"}'],
        [messagesUrl, '{"text":"run id"}'],
      ] as const) {
        // A simple request: no preflight, the cookie goes along, the answer is opaque.
        await fetch(url, {
          method: "POST",
          mode: "no-cors",
          credentials: "include",
          headers: { "content-type": "text/plain" },
          body,
        }).then(
          (r) => out.push(`no-cors ${r.type}`),
          (e) => out.push(`no-cors error ${String(e)}`),
        );
        // A JSON request: CORS preflight, which the hub does not grant.
        await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body,
        }).then(
          (r) => out.push(`cors ${r.status}`),
          (e) => out.push(`cors error ${String(e)}`),
        );
      }
      return out;
    },
    { sessionsUrl, messagesUrl },
  );
  console.log(`e2e: cross-origin page fetches: ${statuses.join(", ")}`);
  check(!statuses.some((s) => /^cors 2/.test(s)), `a cross-origin fetch succeeded: ${statuses}`);

  // Nothing changed: no session created, no message stored, no turn run.
  await page.waitForTimeout(2000);
  const after = await snapshot(context, sessionId);
  check(after.sessions === before.sessions, "a refused request created or changed a session");
  check(after.events === before.events, "a refused request added events to the session");
  check(after.model === before.model, "a refused request reached the model");
  await script([]);
}

async function upgrade(browser: Browser): Promise<void> {
  const state = JSON.parse(readFileSync(STATE, "utf8")) as State;
  step("after an upgrade (compose up --build): the password, the session and its chat are kept");
  const context = await newContext(browser);
  const page = await context.newPage();
  await signIn(page);
  await page.getByRole("link", { name: new RegExp(TITLE) }).click();
  check(page.url() === state.sessionUrl, `opened ${page.url()}, not ${state.sessionUrl}`);
  await page.getByText("Still here after the reload.").waitFor();
  await script([{ text: "Still here after the upgrade." }]);
  await page.getByLabel("Message").fill("And after the upgrade?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("Still here after the upgrade.").waitFor({ timeout: TURN_MS });
  await shot(page, "5-after-upgrade");
  await context.close();
}

const phase = process.argv[2];
let browser: Browser | undefined;
let code = 0;
try {
  if (phase !== "install" && phase !== "upgrade") {
    throw new Error("usage: bun deploy/e2e/prototype.ts install|upgrade");
  }
  const executablePath = process.env["HEARTH_E2E_CHROMIUM"];
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  await (phase === "install" ? install(browser) : upgrade(browser));
  step("passed");
} catch (error) {
  code = 1;
  console.error(`e2e failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
} finally {
  await browser?.close();
}
process.exit(code);
