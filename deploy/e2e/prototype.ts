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
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright";
import { desktopProblem, desktopStats } from "./desktop-pixels";
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
  // The named trigger already carries the status in its accessible name; its badge
  // may sit outside the button, so only the unnamed (older) card is filtered by text.
  return page
    .getByRole("button", { name: `Tool call ${tool}: done` })
    .or(
      page
        .getByRole("group")
        .filter({ hasText: tool })
        .filter({ hasText: target })
        .filter({ hasText: "done" }),
    )
    .first();
}

/** Opens a tool call to show its output, in either UI (see `toolDone`). */
async function expandTool(page: Page, tool: string, target: string): Promise<void> {
  const named = page.getByRole("button", { name: `Tool call ${tool}: done` });
  if ((await named.count()) > 0) await named.first().click();
  else await page.getByRole("group").filter({ hasText: target }).getByText(target).click();
}

/** Every CSP violation a page of the run reports (decision 0017); the run fails on any. */
const cspViolations: string[] = [];

async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(STEP_MS);
  // Fail closed on CSP: a listener installed before any page script sees
  // every blocked load or eval, even one the page code catches.
  await context.exposeBinding("__hearthCspViolation", (_source, report: string) => {
    cspViolations.push(report);
  });
  await context.addInitScript({
    content: `document.addEventListener("securitypolicyviolation", (event) => {
      void globalThis.__hearthCspViolation(
        event.effectiveDirective + " blocked " + (event.blockedURI || "(inline)") +
          " on " + event.documentURI,
      );
    });`,
  });
  return context;
}

/** Pixels of the noVNC canvas, sampled every 8 px, as flat RGB. */
async function sampleCanvas(canvas: Locator): Promise<number[]> {
  return await canvas.evaluate((c) => {
    const el = c as unknown as {
      width: number;
      height: number;
      getContext(kind: "2d"): {
        getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
      } | null;
    };
    const data = el.getContext("2d")?.getImageData(0, 0, el.width, el.height).data;
    const out: number[] = [];
    if (data === undefined) return out;
    for (let y = 4; y < el.height; y += 8) {
      for (let x = 4; x < el.width; x += 8) {
        const at = (y * el.width + x) * 4;
        out.push(data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0);
      }
    }
    return out;
  });
}

/** The URLs of the pages open in the box's Chromium, read over its CDP port inside the box. */
function boxBrowserUrls(box: string): string[] {
  const script =
    'const r = await fetch("http://127.0.0.1:9222/json/list");' +
    'console.log(JSON.stringify((await r.json()).filter((t) => t.type === "page").map((t) => t.url)));';
  return JSON.parse(docker("exec", box, "bun", "-e", script)) as string[];
}

/** Waits until the box's Chromium shows `url`, or returns what it shows. */
async function waitForBoxUrl(box: string, url: string, ms: number): Promise<string[]> {
  let urls: string[] = [];
  for (const end = Date.now() + ms; Date.now() < end; ) {
    urls = boxBrowserUrls(box);
    if (urls.includes(url)) return urls;
    await Bun.sleep(500);
  }
  return urls;
}

const KEY = { control: 0xffe3, delete: 0xffff, enter: 0xff0d, l: 0x6c } as const;

/** RFB key events that focus Chromium's address bar, type `url` and open it. */
function addressBarKeys(url: string): [number, boolean][] {
  const keys: [number, boolean][] = [
    [KEY.control, true],
    [KEY.l, true],
    [KEY.l, false],
    [KEY.control, false],
  ];
  // Printable ASCII keysyms are the characters' own codes.
  for (const ch of url) keys.push([ch.charCodeAt(0), true], [ch.charCodeAt(0), false]);
  // Delete drops an inline autocompletion; Enter opens the typed URL.
  keys.push([KEY.delete, true], [KEY.delete, false], [KEY.enter, true], [KEY.enter, false]);
  return keys;
}

/**
 * A second, hand-written RFB client on the desktop WebSocket, in the signed-in
 * page: it ignores the UI's view-only switch and sends `keys` regardless, so
 * only the hub's filter decides whether they reach the box.
 */
async function rawKeys(page: Page, sessionId: string, keys: [number, boolean][]): Promise<string> {
  const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/desktop`, BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return await page.evaluate(
    async ({ url, keys }) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      const buf: number[] = [];
      let stage = 0;
      return await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          ws.close();
          resolve(`timed out at stage ${stage}`);
        }, 20_000);
        ws.onclose = (event) => {
          clearTimeout(timer);
          resolve(`closed ${event.code} at stage ${stage}`);
        };
        ws.onmessage = (event) => {
          buf.push(...new Uint8Array(event.data as ArrayBuffer));
          for (;;) {
            if (stage === 0 && buf.length >= 12) {
              buf.splice(0, 12);
              ws.send(new TextEncoder().encode("RFB 003.008\n"));
              stage = 1;
            } else if (stage === 1 && buf.length >= 1 && buf.length >= 1 + (buf[0] ?? 0)) {
              buf.splice(0, 1 + (buf[0] ?? 0));
              ws.send(Uint8Array.of(1)); // security None
              stage = 2;
            } else if (stage === 2 && buf.length >= 4) {
              buf.splice(0, 4);
              ws.send(Uint8Array.of(1)); // ClientInit, shared
              stage = 3;
            } else if (stage === 3 && buf.length >= 24) {
              const n =
                (((buf[20] ?? 0) << 24) |
                  ((buf[21] ?? 0) << 16) |
                  ((buf[22] ?? 0) << 8) |
                  (buf[23] ?? 0)) >>>
                0;
              if (buf.length < 24 + n) return;
              buf.splice(0, 24 + n);
              stage = 4;
              // One message per key, paced like a typist: a burst can reach the
              // page before Ctrl+L has moved the focus to the address bar.
              const send = async () => {
                for (const [i, [sym, down]] of keys.entries()) {
                  ws.send(
                    Uint8Array.of(
                      4,
                      down ? 1 : 0,
                      0,
                      0,
                      (sym >>> 24) & 255,
                      (sym >>> 16) & 255,
                      (sym >>> 8) & 255,
                      sym & 255,
                    ),
                  );
                  await new Promise((r) => setTimeout(r, i === 3 ? 500 : 30));
                }
                await new Promise((r) => setTimeout(r, 2_000));
                clearTimeout(timer);
                ws.onclose = null;
                ws.close();
                resolve("sent");
              };
              void send();
            } else {
              return;
            }
          }
        };
      });
    },
    { url: url.toString(), keys },
  );
}

/**
 * M2 takeover (#120, decision 0033): Take over, type into the box Chromium's
 * address bar through noVNC, see the page change (its URL over CDP, and the
 * start page's accent gone from the canvas), then Release; input is dropped
 * again, even from a client that ignores the UI and sends key events anyway.
 */
async function takeOver(page: Page, box: string, sessionId: string): Promise<void> {
  try {
    await takeOverSteps(page, box, sessionId);
  } catch (error) {
    // What the box and the hub saw, for a failed run.
    await shot(page, "3x-takeover-failed");
    const run = (...args: string[]) => {
      const out = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
      return `${out.stdout.toString()}${out.stderr.toString()}`;
    };
    console.log(
      `e2e: active window: ${run("exec", "-e", "DISPLAY=:1", box, "xprop", "-root", "_NET_ACTIVE_WINDOW")}`,
    );
    console.log(`e2e: box xvnc.log:\n${run("exec", box, "tail", "-n", "40", "/tmp/xvnc.log")}`);
    console.log(
      `e2e: box chromium.log:\n${run("exec", box, "tail", "-n", "20", "/tmp/chromium.log")}`,
    );
    const hub = run("ps", "-q", "--filter", "name=hub").trim().split("\n")[0] ?? "";
    const logs = run("logs", "--tail", "400", hub)
      .split("\n")
      .filter((l) => /desktop|lock|vnc|stream/i.test(l))
      .slice(-60);
    console.log(`e2e: hub desktop log:\n${logs.join("\n")}`);
    throw error;
  }
}

/**
 * Ctrl+L with a lowercase l: Playwright's "Control+L" sends the key "L", noVNC
 * turns that into the keysym for capital L, and Xvnc adds Shift to type it, so
 * Chromium sees Ctrl+Shift+L and the address bar never takes focus (#120).
 */
const FOCUS_ADDRESS_BAR = "Control+l";

async function takeOverSteps(page: Page, box: string, sessionId: string): Promise<void> {
  step("5b. take over the desktop and type into the box browser's address bar");
  const desktop = page.getByRole("region", { name: "Desktop" });
  const canvas = desktop.locator("canvas");
  const start = boxBrowserUrls(box);
  check(
    start.some((u) => u.startsWith("file:///usr/share/hearth/start.html")),
    `the box browser is not on its start page: ${start.join(", ")}`,
  );
  // View-only first: typing through noVNC reaches nothing.
  await canvas.click();
  await page.keyboard.press(FOCUS_ADDRESS_BAR);
  await page.keyboard.type("file:///etc/\n");
  await page.waitForTimeout(2_000);
  check(!boxBrowserUrls(box).includes("file:///etc/"), "view-only typing reached the box browser");

  await page.getByRole("button", { name: "Take over" }).click();
  await page.getByRole("button", { name: "Release" }).waitFor();
  const typed = "file:///workspace/";
  await canvas.click();
  await page.keyboard.press(FOCUS_ADDRESS_BAR);
  // The omnibox takes focus a moment after Ctrl+L; a key sent before that is
  // lost (a CI run dropped the first "f"). A person types slower than this.
  await page.waitForTimeout(500);
  await page.keyboard.type(typed, { delay: 30 });
  await page.waitForTimeout(1_000);
  await shot(page, "3a-typed");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Enter");
  let urls = await waitForBoxUrl(box, typed, 20_000);
  check(urls.includes(typed), `the typed URL did not open in the box browser: ${urls.join(", ")}`);
  // The page changed on the desktop too: the start page's accent band is gone.
  let accent = 1;
  for (let i = 0; i < 20 && accent >= 0.005; i++) {
    if (i > 0) await page.waitForTimeout(500);
    accent = desktopStats(await sampleCanvas(canvas)).accentShare;
  }
  await shot(page, "3b-desktop-taken-over");
  check(accent < 0.005, `the desktop still shows the start page (accent ${accent})`);

  step("5c. a raw RFB client of the same login types too while the lock is held");
  const held = "file:///tmp/";
  const sent = await rawKeys(page, sessionId, addressBarKeys(held));
  check(sent === "sent", `the raw RFB client did not get to send: ${sent}`);
  urls = await waitForBoxUrl(box, held, 20_000);
  check(urls.includes(held), `the raw client's keys did not reach the box: ${urls.join(", ")}`);

  step("5d. release: input is dropped again");
  await page.getByRole("button", { name: "Release" }).click();
  await page.getByRole("button", { name: "Take over" }).waitFor();
  const lock = await page.request.get(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/desktop/lock`, BASE).toString(),
    { headers: { origin: BASE.origin } },
  );
  check(lock.ok(), `reading the desktop lock answered ${lock.status()}`);
  check(
    ((await lock.json()) as { lock: { held: boolean } }).lock.held === false,
    "the lock is still held after Release",
  );
  const dropped = "file:///usr/";
  const after = await rawKeys(page, sessionId, addressBarKeys(dropped));
  check(after === "sent", `the raw RFB client did not get to send: ${after}`);
  await canvas.click();
  await page.keyboard.press(FOCUS_ADDRESS_BAR);
  await page.keyboard.type(`${dropped}\n`);
  urls = await waitForBoxUrl(box, dropped, 5_000);
  check(!urls.includes(dropped), `input reached the box after Release: ${urls.join(", ")}`);
  check(urls.includes(held), `the box browser left ${held}: ${urls.join(", ")}`);
}

/** The `tool_call` trajectory step of `toolCallId` (decision 0021), read over the events API. */
async function toolStep(
  page: Page,
  sessionId: string,
  toolCallId: string,
): Promise<Record<string, unknown> | undefined> {
  const res = await page.request.get(
    new URL(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?after=0&limit=1000`,
      BASE,
    ).toString(),
    { headers: { origin: BASE.origin } },
  );
  check(res.ok(), `reading events answered ${res.status()}`);
  const { events } = (await res.json()) as {
    events: { type: string; payload: Record<string, unknown> }[];
  };
  return events.find(
    (e) =>
      e.type === "runner.step" &&
      e.payload["kind"] === "tool_call" &&
      e.payload["tool_call_id"] === toolCallId,
  )?.payload;
}

/**
 * #126 (decision 0035): while the owner holds the desktop, an agent
 * `browser_*` call is refused with `desktop.locked` and the trajectory says
 * so; after Release the same tool runs in the box's Chromium again.
 */
async function browserToolUnderLock(page: Page, sessionId: string): Promise<void> {
  step("5e. a browser tool refuses while the desktop is taken over, and works after Release");
  await page.getByRole("button", { name: "Take over" }).click();
  await page.getByRole("button", { name: "Release" }).waitFor();
  await script([
    {
      toolCalls: [{ id: "call_tabs_locked", name: "browser_tabs", arguments: { action: "list" } }],
    },
    { text: "The user is in control of the desktop; I will wait." },
  ]);
  await page.getByLabel("Message").fill("List the browser tabs");
  await page.getByRole("button", { name: "Send" }).click();
  await page
    .getByText("The user is in control of the desktop; I will wait.")
    .waitFor({ timeout: TURN_MS });
  const locked = await toolStep(page, sessionId, "call_tabs_locked");
  check(locked !== undefined, "no trajectory step for the locked browser_tabs call");
  check(
    locked?.["outcome"] === "desktop-locked" && locked?.["refused_code"] === "desktop.locked",
    `the locked browser_tabs call was not refused with desktop.locked: ${JSON.stringify(locked)}`,
  );
  check(
    String((locked?.["result"] as { text?: unknown } | undefined)?.text).includes(
      "user is in control",
    ),
    `the model was not told the user is in control: ${JSON.stringify(locked?.["result"])}`,
  );
  check(
    JSON.stringify(locked?.["rpcs"]) === "[]",
    `the locked call reached the box: ${JSON.stringify(locked?.["rpcs"])}`,
  );
  await shot(page, "3c-browser-tool-locked");

  await page.getByRole("button", { name: "Release" }).click();
  await page.getByRole("button", { name: "Take over" }).waitFor();
  await script([
    { toolCalls: [{ id: "call_tabs_free", name: "browser_tabs", arguments: { action: "list" } }] },
    { text: "Listed the browser tabs." },
  ]);
  await page.getByLabel("Message").fill("List the browser tabs again");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("Listed the browser tabs.").waitFor({ timeout: TURN_MS });
  const free = await toolStep(page, sessionId, "call_tabs_free");
  check(
    free?.["outcome"] === "ok",
    `browser_tabs did not work after Release: ${JSON.stringify(free)}`,
  );
  check(
    (free?.["rpcs"] as { method?: string }[] | undefined)?.some(
      (r) => r.method === "browser.tabs",
    ) === true,
    `browser_tabs after Release made no browser.tabs rpc: ${JSON.stringify(free?.["rpcs"])}`,
  );
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

  step("5. the box's desktop is visible and drawn: the browser on its start page");
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
  // Something is drawn (#92): not one colour, and the box's Chromium shows its
  // start page. Sampled every 8 px; the browser may still be starting, so poll.
  let problem: string | null = "not sampled yet";
  for (let i = 0; i < 60 && problem !== null; i++) {
    if (i > 0) await page.waitForTimeout(1000);
    problem = desktopProblem(desktopStats(await sampleCanvas(canvas)));
  }
  await shot(page, "3-desktop");
  check(problem === null, `the desktop is not drawn: ${problem}`);

  await takeOver(page, box, sessionId);
  await browserToolUnderLock(page, sessionId);

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
  check(cspViolations.length === 0, `CSP violations: ${cspViolations.join("; ")}`);
}

/**
 * Everything the session API holds right now, through the signed-in context, minus the
 * box lifecycle (state, last activity, `session.state` and `box.*` events). The hub's
 * idle timer moves those on its own, so they say nothing about a refused request.
 */
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
  const sessionList = (await sessions.json()) as { sessions: Record<string, unknown>[] };
  const eventPage = (await events.json()) as { events: { type: string }[] };
  const lifecycle = (type: string) => type === "session.state" || type.startsWith("box.");
  return {
    sessions: JSON.stringify(
      sessionList.sessions.map(({ state: _s, lastActivityAt: _l, boxId: _b, ...rest }) => rest),
    ),
    events: JSON.stringify(eventPage.events.filter((e) => !lifecycle(e.type))),
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
  check(
    after.sessions === before.sessions,
    `a refused request created or changed a session:\nbefore ${before.sessions}\nafter  ${after.sessions}`,
  );
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
  check(cspViolations.length === 0, `CSP violations: ${cspViolations.join("; ")}`);
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
