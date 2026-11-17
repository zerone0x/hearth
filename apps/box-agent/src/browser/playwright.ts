/**
 * `BrowserDriver` on `playwright-core` (decision 0032): one `connectOverCDP`
 * connection to the box's Chromium (decision 0026), opened on the first call.
 *
 * - **Reconnect.** When the supervisor restarts Chromium the connection's
 *   `disconnected` event drops it, and the next call connects again. Tabs of
 *   the old connection are new objects after that, so every ref of them is
 *   stale.
 * - **Never kills the browser.** `close()` disconnects only; the supervisor
 *   owns Chromium.
 * - **Dialogs.** A JavaScript dialog would block the page; it is dismissed
 *   (an `alert` accepted) and reported with the call's result.
 * - **Masks** (decision 0039). An element `browser.fill` filled gets a
 *   `data-hearth-mask` attribute with a fresh token, and the tab keeps a
 *   handle to it. Every screenshot masks each element carrying the attribute
 *   in any frame, and first checks each kept handle: still connected and still
 *   carrying its token, or the screenshot is refused. A handle whose document
 *   is gone (navigation, closed frame) is dropped: the value went with it.
 */

import { randomUUID } from "node:crypto";
import type { BrowserFieldKind } from "@hearth/protocol";

import {
  type Browser,
  type BrowserContext,
  chromium,
  type ElementHandle,
  errors,
  type Frame,
  type Page,
} from "playwright-core";
import { ToolCallError } from "../tools/errors";
import {
  type BrowserDriver,
  type DriverDialog,
  DriverError,
  type DriverTab,
  type FieldInfo,
  type TargetState,
} from "./driver";

/** The attribute that marks a filled element for the screenshot mask. */
export const MASK_ATTRIBUTE = "data-hearth-mask";
/** What a masked element looks like in a screenshot. */
const MASK_COLOR = "#000000";

/** A kept handle's document is gone: its frame navigated or closed. */
const GONE_DOCUMENT = /context was destroyed|has been closed|disposed|not attached|detached/i;

/** `scheme://host[:port]` of an http(s) URL, or null. */
export function httpOrigin(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
}

/**
 * Runs in the page: the field kind of an element (decision 0039). Typed
 * structurally; box-agent has no DOM types.
 */
function fieldKindInPage(node: unknown): string {
  const element = node as {
    tagName: string;
    isContentEditable?: boolean;
    getAttribute(name: string): string | null;
  };
  const tag = element.tagName.toLowerCase();
  const tokens = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    const text = ["", "text", "email", "tel", "search", "url", "number", "password"];
    if (!text.includes(type)) return "none";
    if (tokens.includes("one-time-code")) return "one-time-code";
    if (type === "password") return "password";
    if (type === "email" || tokens.includes("username") || tokens.includes("email")) {
      return "username";
    }
    return "other";
  }
  if (tag === "textarea" || element.isContentEditable === true) return "other";
  return "none";
}

/** Pause between dials while the browser's CDP port is not up. */
const DIAL_RETRY_MS = 250;

export interface PlaywrightDriverOptions {
  /** The CDP endpoint, `http://127.0.0.1:9222` in the box. */
  readonly endpoint: string;
  readonly connectTimeoutMs: number;
  readonly log?: (line: string) => void;
}

/** Maps a Playwright failure to a driver error. */
function driverError(error: unknown): DriverError {
  if (error instanceof DriverError) return error;
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  if (error instanceof errors.TimeoutError) return new DriverError("timeout", message);
  if (/net::ERR_|NS_ERROR_|navigation/i.test(message))
    return new DriverError("navigation", message);
  return new DriverError("failed", message);
}

/**
 * Runs a Playwright call and maps its failure. With `page`, a failure while
 * the page's browser is disconnected (Chromium killed mid-call) is
 * `unavailable`, not a failure of the action.
 */
async function wrap<T>(fn: () => Promise<T>, page?: Page): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (page !== undefined && !connected(page)) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      throw new DriverError("unavailable", `the box browser went away during the call: ${message}`);
    }
    throw driverError(error);
  }
}

function connected(page: Page): boolean {
  return page.context().browser()?.isConnected() ?? true;
}

interface Mark {
  readonly token: string;
  readonly handle: ElementHandle;
  readonly frame: Frame;
}

class PlaywrightTab implements DriverTab {
  readonly #page: Page;
  #navigations = 0;
  #dialogs: DriverDialog[] = [];
  #marks: Mark[] = [];

  constructor(page: Page) {
    this.#page = page;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.#navigations++;
    });
    page.on("dialog", (dialog) => {
      if (this.#dialogs.length < 16) {
        this.#dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 1000) });
      }
      const settle = dialog.type() === "alert" ? dialog.accept() : dialog.dismiss();
      settle.catch(() => {});
    });
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    return wrap(fn, this.#page);
  }

  get navigations(): number {
    return this.#navigations;
  }

  takeDialogs(): DriverDialog[] {
    const out = this.#dialogs;
    this.#dialogs = [];
    return out;
  }

  url(): string {
    return this.#page.url();
  }

  title(): Promise<string> {
    return this.#page.title();
  }

  goto(url: string, timeoutMs: number): Promise<{ status: number | null }> {
    return this.#run(async () => {
      const response = await this.#page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
      return { status: response?.status() ?? null };
    });
  }

  history(delta: -1 | 1, timeoutMs: number): Promise<{ status: number | null } | null> {
    return this.#run(async () => {
      const before = { navigations: this.#navigations, url: this.#page.url() };
      const options = { timeout: timeoutMs, waitUntil: "load" as const };
      const response =
        delta < 0 ? await this.#page.goBack(options) : await this.#page.goForward(options);
      if (response !== null) return { status: response.status() };
      // Playwright answers null both for "no such entry" and for a move with no
      // response (same document, cache): only a move that happened counts.
      const moved = this.#navigations !== before.navigations || this.#page.url() !== before.url;
      return moved ? { status: null } : null;
    });
  }

  snapshot(options: { ref?: string; depth?: number; timeoutMs: number }): Promise<string> {
    const settings = {
      mode: "ai" as const,
      timeout: options.timeoutMs,
      ...(options.depth === undefined ? {} : { depth: options.depth }),
    };
    return this.#run(() =>
      options.ref === undefined
        ? this.#page.ariaSnapshot(settings)
        : this.#page.getByRef(options.ref).ariaSnapshot(settings),
    );
  }

  inspect(ref: string, timeoutMs: number): Promise<TargetState> {
    return this.#run(async () => {
      const target = this.#page.getByRef(ref);
      if ((await target.count()) === 0) {
        return { found: false, visible: false, enabled: false, editable: false, covered: false };
      }
      const visible = await target.isVisible();
      if (!visible)
        return { found: true, visible, enabled: false, editable: false, covered: false };
      const enabled = await target.isEnabled({ timeout: timeoutMs });
      const editable = await target.isEditable({ timeout: timeoutMs }).catch(() => false);
      await target.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => {});
      // A hit test at the centre, in the element's own root (shadow DOM included).
      const covered = await target.evaluate((node: unknown) => {
        // Runs in the page; typed structurally, box-agent has no DOM types.
        interface Hit {
          contains(other: unknown): boolean;
        }
        const element = node as Hit & {
          getBoundingClientRect(): { left: number; top: number; width: number; height: number };
          getRootNode(): { elementFromPoint(x: number, y: number): Hit | null };
        };
        const rect = element.getBoundingClientRect();
        const hit = element
          .getRootNode()
          .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (hit === null) return false;
        return !(hit === element || element.contains(hit) || hit.contains(element));
      });
      return { found: true, visible, enabled, editable, covered };
    });
  }

  click(
    ref: string,
    options: { button: "left" | "right" | "middle"; double: boolean },
    timeoutMs: number,
  ): Promise<void> {
    const target = this.#page.getByRef(ref);
    return this.#run(() =>
      options.double
        ? target.dblclick({ button: options.button, timeout: timeoutMs })
        : target.click({ button: options.button, timeout: timeoutMs }),
    );
  }

  fill(ref: string, text: string, timeoutMs: number): Promise<void> {
    return this.#run(() => this.#page.getByRef(ref).fill(text, { timeout: timeoutMs }));
  }

  field(ref: string, timeoutMs: number): Promise<FieldInfo> {
    return this.#run(async () => {
      const target = this.#page.getByRef(ref);
      if ((await target.count()) === 0) return { found: false, field: "none", origin: null };
      const handle = await target.elementHandle({ timeout: timeoutMs });
      try {
        const field = (await handle.evaluate(fieldKindInPage)) as BrowserFieldKind;
        // The URL the browser committed for the owner frame, not one page script reports.
        const frame = await handle.ownerFrame();
        return { found: true, field, origin: frame === null ? null : httpOrigin(frame.url()) };
      } finally {
        await handle.dispose().catch(() => {});
      }
    });
  }

  mark(ref: string, timeoutMs: number): Promise<void> {
    return this.#run(async () => {
      const handle = await this.#page.getByRef(ref).elementHandle({ timeout: timeoutMs });
      const frame = await handle.ownerFrame();
      if (frame === null) {
        await handle.dispose().catch(() => {});
        throw new DriverError("failed", "the element has no frame to mark it in");
      }
      const token = randomUUID();
      await handle.evaluate(
        (node: unknown, [name, value]: [string, string]) =>
          (node as { setAttribute(n: string, v: string): void }).setAttribute(name, value),
        [MASK_ATTRIBUTE, token] as [string, string],
      );
      this.#marks.push({ token, handle, frame });
    });
  }

  /**
   * Checks every kept mark before a screenshot: a mark whose document is gone
   * is dropped; one whose element left a loaded document, or lost its token,
   * refuses the screenshot.
   */
  async #checkMarks(): Promise<void> {
    const kept: Mark[] = [];
    let missing = 0;
    for (const mark of this.#marks) {
      if (mark.frame.isDetached()) continue;
      let present: boolean;
      try {
        present = await mark.handle.evaluate(
          (node: unknown, [name, value]: [string, string]) => {
            const element = node as {
              isConnected: boolean;
              getAttribute(n: string): string | null;
            };
            return element.isConnected && element.getAttribute(name) === value;
          },
          [MASK_ATTRIBUTE, mark.token] as [string, string],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (GONE_DOCUMENT.test(message)) continue;
        present = false;
      }
      kept.push(mark);
      if (!present) missing++;
    }
    this.#marks = kept;
    if (missing > 0) {
      throw new DriverError(
        "mask",
        `${missing} filled field${missing === 1 ? " is" : "s are"} no longer on the page where it was filled, so it cannot be masked`,
      );
    }
  }

  select(ref: string, values: readonly string[], timeoutMs: number): Promise<void> {
    return this.#run(async () => {
      await this.#page.getByRef(ref).selectOption([...values], { timeout: timeoutMs });
    });
  }

  press(ref: string | undefined, key: string, timeoutMs: number): Promise<void> {
    return this.#run(() =>
      ref === undefined
        ? this.#page.keyboard.press(key)
        : this.#page.getByRef(ref).press(key, { timeout: timeoutMs }),
    );
  }

  textVisible(text: string): Promise<boolean> {
    return this.#page
      .getByText(text)
      .first()
      .isVisible()
      .catch(() => false);
  }

  screenshot(options: {
    ref?: string;
    fullPage: boolean;
    quality: number;
    timeoutMs: number;
  }): Promise<Buffer> {
    return this.#run(async () => {
      await this.#checkMarks();
      const settings = {
        type: "jpeg" as const,
        quality: options.quality,
        timeout: options.timeoutMs,
        // Every marked element in every frame, a page restored from the back-forward cache included.
        mask: this.#page.frames().map((frame) => frame.locator(`[${MASK_ATTRIBUTE}]`)),
        maskColor: MASK_COLOR,
      };
      return options.ref === undefined
        ? await this.#page.screenshot({ ...settings, fullPage: options.fullPage })
        : await this.#page.getByRef(options.ref).screenshot(settings);
    });
  }

  bringToFront(): Promise<void> {
    return this.#run(() => this.#page.bringToFront());
  }

  close(): Promise<void> {
    return this.#run(() => this.#page.close());
  }
}

export class PlaywrightDriver implements BrowserDriver {
  readonly #options: PlaywrightDriverOptions;
  readonly #tabs = new WeakMap<Page, PlaywrightTab>();
  #browser: Browser | undefined;
  #connecting: Promise<Browser> | undefined;
  #connects = 0;

  constructor(options: PlaywrightDriverOptions) {
    this.#options = options;
  }

  /** Connections opened so far (tests). */
  get connects(): number {
    return this.#connects;
  }

  async #connect(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    this.#connecting ??= (async () => {
      try {
        const browser = await this.#dial();
        this.#connects++;
        browser.on("disconnected", () => {
          if (this.#browser === browser) this.#browser = undefined;
          this.#options.log?.("box-agent: browser connection closed; the next call reconnects");
        });
        this.#browser = browser;
        return browser;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
        throw new ToolCallError(
          "browser.unavailable",
          `the box browser does not answer on ${this.#options.endpoint}: ${message}`,
        );
      } finally {
        this.#connecting = undefined;
      }
    })();
    return await this.#connecting;
  }

  /**
   * Dials until the endpoint answers or the connect timeout passed: right
   * after the box starts, or while the supervisor restarts Chromium, the port
   * is closed for a moment.
   */
  async #dial(): Promise<Browser> {
    const deadline = Date.now() + this.#options.connectTimeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      try {
        return await chromium.connectOverCDP(this.#options.endpoint, {
          timeout: Math.max(1, left),
        });
      } catch (error) {
        if (Date.now() + DIAL_RETRY_MS >= deadline) throw error;
        await Bun.sleep(DIAL_RETRY_MS);
      }
    }
  }

  async #context(): Promise<BrowserContext> {
    const browser = await this.#connect();
    const context = browser.contexts()[0];
    if (context === undefined) {
      throw new ToolCallError("browser.unavailable", "the box browser has no default context");
    }
    return context;
  }

  #wrap(page: Page): PlaywrightTab {
    let tab = this.#tabs.get(page);
    if (tab === undefined) {
      tab = new PlaywrightTab(page);
      this.#tabs.set(page, tab);
    }
    return tab;
  }

  async tabs(): Promise<readonly DriverTab[]> {
    return (await this.#context()).pages().map((page) => this.#wrap(page));
  }

  async newTab(): Promise<DriverTab> {
    const context = await this.#context();
    return this.#wrap(await wrap(() => context.newPage()));
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    await browser?.close().catch(() => {});
  }
}
