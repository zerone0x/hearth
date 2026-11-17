/**
 * The browser tools in the box (protocol 1.3, decision 0032): the `browser.*`
 * methods on top of a `BrowserDriver`.
 *
 * - **One call at a time.** Calls run in arrival order; two actions never
 *   interleave on the page.
 * - **Snapshot generations per tab.** Every snapshot (whole page, subtree or
 *   the one behind `browser.find`) gets a new generation, unique in this
 *   process, and its refs carry it (`s7e5`). A tab remembers only its latest
 *   generation and its navigation count at that time. A ref whose generation
 *   is not a tab's latest, or whose tab navigated since, is refused at once
 *   with `stale_ref`: Playwright would otherwise resolve it against a newer
 *   snapshot, or wait out its whole timeout for it.
 * - **Fail closed before acting.** A target that is gone (`stale_ref`), hidden,
 *   disabled, not editable (type) or covered at its centre (click) is refused
 *   with `not_actionable` before anything is dispatched.
 * - **Verified actions.** `expect` is checked by code after the action; `ok`
 *   is false when it does not hold.
 * - **Snapshot last.** Acting calls return the tab's fresh snapshot, capped at
 *   `MAX_SNAPSHOT_TEXT_BYTES`; the whole one is spilled to a box file.
 * - **Filled secrets** (protocol 1.5, decision 0039). `browser.fill` checks
 *   the field's owner-frame origin and kind just before it fills, marks the
 *   element for the screenshot mask, and remembers the value for the life of
 *   the process: every later result, error and spilled snapshot has it
 *   replaced by `[redacted]`. A screenshot with a filled element missing is
 *   refused (`browser.mask-missing`).
 */

import { createHash } from "node:crypto";
import { closeSync, writeSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import { LOG_REDACTED, redactValues } from "@hearth/core";
import {
  BROWSER_ACTION_TIMEOUT_MS,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_OBSERVE_TIMEOUT_MS,
  type BrowserActionResult,
  type BrowserExpect,
  type BrowserMethod,
  type BrowserOutcome,
  type BrowserParams,
  type BrowserResults,
  type BrowserSnapshot,
  DEFAULT_EXPECT_TIMEOUT_MS,
  DEFAULT_FIND_LINES,
  MAX_SCREENSHOT_BYTES,
  MAX_SNAPSHOT_SPILL_BYTES,
  MAX_SNAPSHOT_TEXT_BYTES,
  parseBrowserRef,
} from "@hearth/protocol";
import { ToolCallError } from "../tools/errors";
import { openPlainFile } from "../tools/paths";
import { type BrowserDriver, DriverError, type DriverTab } from "./driver";
import { capText, findLines, jpegSize, snapshotCutMarker, tagRefs } from "./snapshot";

/** Box-relative directory of spilled snapshots. */
export const SNAPSHOT_SPILL_DIR = ".hearth/browser";
/** How often an `expect` or `browser.wait` condition is checked. */
export const EXPECT_POLL_MS = 100;
/** JPEG qualities tried in turn until a screenshot fits `MAX_SCREENSHOT_BYTES`. */
export const SCREENSHOT_QUALITIES = [70, 50, 30] as const;

const NAVIGABLE = /^(https?:\/\/|about:blank$)/i;

export interface BrowserToolsOptions {
  readonly driver: BrowserDriver;
  /** The workspace root; spilled snapshots go under `SNAPSHOT_SPILL_DIR` in it. */
  readonly root: string;
  readonly maxSnapshotBytes?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface TabState {
  readonly generation: number;
  readonly navigations: number;
}

type Resolved =
  | { readonly kind: "ok"; readonly tab: DriverTab; readonly local: string }
  | { readonly kind: "stale"; readonly message: string };

export class BrowserTools {
  readonly #driver: BrowserDriver;
  readonly #options: BrowserToolsOptions;
  readonly #state = new WeakMap<DriverTab, TabState>();
  /** Latest generation of each tab, for resolving refs. */
  readonly #latest = new Map<number, WeakRef<DriverTab>>();
  #generation = 0;
  #active: DriverTab | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  /** Every value `browser.fill` was given: never echoed in a result, an error or a spill. */
  readonly #secrets = new Set<string>();

  constructor(options: BrowserToolsOptions) {
    this.#driver = options.driver;
    this.#options = options;
  }

  /** The last generation handed out. */
  get generation(): number {
    return this.#generation;
  }

  /** Runs one call after the ones before it. */
  run<M extends BrowserMethod>(
    method: M,
    params: BrowserParams[M],
    limits: { readonly signal?: AbortSignal; readonly deadline?: number } = {},
  ): Promise<BrowserResults[M]> {
    const result = this.#queue.then(() => {
      // A call whose budget ran out (or was cancelled) while it waited never starts:
      // its caller already has an answer.
      const now = this.#options.now ?? Date.now;
      if (limits.signal?.aborted === true) throw new ToolCallError("tool.internal", "aborted");
      if (limits.deadline !== undefined && now() >= limits.deadline) {
        throw new ToolCallError(
          "tool.deadline",
          `${method} waited out its budget behind other browser calls`,
        );
      }
      return this.#dispatch(method, params);
    });
    this.#queue = result.catch(() => {});
    return result.then(
      (value) => this.#scrubResult(value),
      (error: unknown) => {
        throw this.#scrubError(error);
      },
    );
  }

  /** `text` with every filled value replaced. */
  #scrub(text: string): string {
    return this.#secrets.size === 0 ? text : redactValues(text, this.#secrets, LOG_REDACTED);
  }

  /** Every string of a result scrubbed, but a screenshot's base64 `data`. */
  #scrubResult<T>(value: T): T {
    if (this.#secrets.size === 0) return value;
    const walk = (node: unknown, key: string | undefined): unknown => {
      if (typeof node === "string") return key === "data" ? node : this.#scrub(node);
      if (Array.isArray(node)) return node.map((item) => walk(item, undefined));
      if (node !== null && typeof node === "object") {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
      }
      return node;
    };
    return walk(value, undefined) as T;
  }

  #scrubError(error: unknown): unknown {
    if (this.#secrets.size === 0) return error;
    if (error instanceof ToolCallError)
      return new ToolCallError(error.code, this.#scrub(error.message));
    if (error instanceof Error) return new Error(this.#scrub(error.message));
    return new Error(this.#scrub(String(error)));
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }

  async #dispatch<M extends BrowserMethod>(
    method: M,
    params: BrowserParams[M],
  ): Promise<BrowserResults[M]> {
    const p = params as never;
    switch (method) {
      case "browser.navigate":
        return (await this.navigate(p)) as BrowserResults[M];
      case "browser.back":
        return (await this.history(-1, p)) as BrowserResults[M];
      case "browser.forward":
        return (await this.history(1, p)) as BrowserResults[M];
      case "browser.snapshot":
        return (await this.snapshot(p)) as BrowserResults[M];
      case "browser.find":
        return (await this.find(p)) as BrowserResults[M];
      case "browser.click":
      case "browser.type":
      case "browser.select":
      case "browser.press":
        return (await this.act(method, p)) as BrowserResults[M];
      case "browser.wait":
        return (await this.wait(p)) as BrowserResults[M];
      case "browser.screenshot":
        return (await this.screenshot(p)) as BrowserResults[M];
      case "browser.tabs":
        return (await this.tabs(p)) as BrowserResults[M];
      case "browser.field":
        return (await this.field(p)) as BrowserResults[M];
      case "browser.fill":
        return (await this.fill(p)) as BrowserResults[M];
    }
    throw new ToolCallError("tool.bad-params", `no method ${method}`);
  }

  // -------------------------------------------------------------------------
  // Tabs and refs

  /** The tab `index`, or the active tab (the first one, or a new one, when none is). */
  async #tab(index?: number): Promise<DriverTab> {
    const tabs = await this.#driver.tabs();
    if (index !== undefined) {
      const tab = tabs[index];
      if (tab === undefined) {
        throw new ToolCallError("browser.no-tab", `there is no tab ${index}; ${tabs.length} open`);
      }
      return tab;
    }
    if (this.#active !== undefined && tabs.includes(this.#active)) return this.#active;
    this.#active = tabs[0] ?? (await this.#driver.newTab());
    return this.#active;
  }

  async #indexOf(tab: DriverTab): Promise<number> {
    return Math.max(0, (await this.#driver.tabs()).indexOf(tab));
  }

  /** Resolves a model ref to its tab and Playwright ref, or says why it is stale. */
  async #resolve(ref: string): Promise<Resolved> {
    const parsed = parseBrowserRef(ref);
    if (parsed === undefined) {
      return {
        kind: "stale",
        message: `${ref} is not a ref from a snapshot (refs look like s3e12); take a snapshot`,
      };
    }
    // `#latest` holds only each tab's latest generation: an older one is not in it.
    const tab = this.#latest.get(parsed.generation)?.deref();
    const state = tab === undefined ? undefined : this.#state.get(tab);
    if (tab === undefined || state === undefined) {
      return {
        kind: "stale",
        message:
          `${ref} is from snapshot s${parsed.generation}, which is not the latest snapshot ` +
          "of any open tab; use the refs of the latest snapshot",
      };
    }
    if (!(await this.#driver.tabs()).includes(tab)) {
      return { kind: "stale", message: `${ref} is from a tab that is closed` };
    }
    if (tab.navigations !== state.navigations) {
      return {
        kind: "stale",
        message: `the page navigated after snapshot s${parsed.generation}; its refs are gone`,
      };
    }
    return { kind: "ok", tab, local: parsed.local };
  }

  // -------------------------------------------------------------------------
  // Snapshots

  async #snapshotOf(
    tab: DriverTab,
    options: { readonly ref?: string; readonly depth?: number } = {},
  ): Promise<BrowserSnapshot> {
    const navigations = tab.navigations;
    // Scrubbed before it is cut or spilled: the spill file is readable in the box.
    const raw = this.#scrub(
      await tab.snapshot({ ...options, timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS }),
    );
    const generation = this.#nextGeneration(tab, navigations);
    const snapshotId = `s${generation}`;
    const text = tagRefs(raw, generation);
    const max = this.#options.maxSnapshotBytes ?? MAX_SNAPSHOT_TEXT_BYTES;
    const capped = capText(text, max);
    if (!capped.truncated) {
      return {
        snapshotId,
        text,
        totalBytes: capped.totalBytes,
        truncated: false,
        fullSnapshotPath: null,
      };
    }
    let path: string | null = null;
    try {
      path = await this.#spill(`${snapshotId}.txt`, text);
    } catch {
      path = null;
    }
    return {
      snapshotId,
      text:
        capped.text + snapshotCutMarker(Buffer.byteLength(capped.text), capped.totalBytes, path),
      totalBytes: capped.totalBytes,
      truncated: true,
      fullSnapshotPath: path,
    };
  }

  /**
   * Makes a new snapshot the tab's latest: its generation replaces the old
   * one, whose refs are stale from now on. `navigations` is the count read
   * before the snapshot was taken, so a navigation during it makes it stale.
   */
  #nextGeneration(tab: DriverTab, navigations: number): number {
    const previous = this.#state.get(tab);
    if (previous !== undefined) this.#latest.delete(previous.generation);
    const generation = ++this.#generation;
    this.#state.set(tab, { generation, navigations });
    this.#latest.set(generation, new WeakRef(tab));
    return generation;
  }

  /**
   * Writes the whole snapshot, cut to `MAX_SNAPSHOT_SPILL_BYTES`, to
   * `<root>/.hearth/browser/<name>` and returns that box path. The box writes
   * it on its own, so it goes through `openPlainFile` as the exec spill does
   * (decision 0011): no symlinked `.hearth` or `browser` directory is
   * followed, the file is opened with `O_NOFOLLOW` and `O_NONBLOCK` (a FIFO
   * there fails at once instead of blocking the call queue) and created 0600.
   * A refusal throws; the caller returns the cut snapshot without a path.
   */
  async #spill(name: string, text: string): Promise<string> {
    const data = Buffer.from(capText(text, MAX_SNAPSHOT_SPILL_BYTES).text, "utf8");
    const realRoot = await realpath(this.#options.root);
    const fd = openPlainFile(realRoot, SNAPSHOT_SPILL_DIR.split("/"), name);
    try {
      let written = 0;
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written);
      }
    } finally {
      closeSync(fd);
    }
    return posix.join(this.#options.root, SNAPSHOT_SPILL_DIR, name);
  }

  /** The closing snapshot of an action, or null when the page cannot give one now. */
  async #lastSnapshot(tab: DriverTab): Promise<BrowserSnapshot | null> {
    try {
      return await this.#snapshotOf(tab);
    } catch {
      return null;
    }
  }

  async snapshot(
    params: BrowserParams["browser.snapshot"],
  ): Promise<BrowserResults["browser.snapshot"]> {
    let tab: DriverTab;
    let local: string | undefined;
    if (params.ref !== undefined) {
      const resolved = await this.#resolve(params.ref);
      if (resolved.kind === "stale") throw new ToolCallError("browser.stale-ref", resolved.message);
      tab = resolved.tab;
      local = resolved.local;
    } else {
      tab = await this.#tab(params.tab);
    }
    const snapshot = await this.#observe(() =>
      this.#snapshotOf(tab, {
        ...(local === undefined ? {} : { ref: local }),
        ...(params.depth === undefined ? {} : { depth: params.depth }),
      }),
    );
    return { ...(await this.#page(tab)), snapshot };
  }

  async find(params: BrowserParams["browser.find"]): Promise<BrowserResults["browser.find"]> {
    const tab = await this.#tab(params.tab);
    const navigations = tab.navigations;
    const raw = this.#scrub(
      await this.#observe(() => tab.snapshot({ timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS })),
    );
    const generation = this.#nextGeneration(tab, navigations);
    const text = tagRefs(raw, generation);
    let match: (line: string) => boolean;
    if (params.regex !== undefined) {
      let regex: RegExp;
      try {
        regex = new RegExp(params.regex, "i");
      } catch (error) {
        throw new ToolCallError("tool.bad-params", `regex: ${firstLine(error)}`);
      }
      match = (line) => regex.test(line);
    } else {
      const needle = (params.text ?? "").toLowerCase();
      match = (line) => line.toLowerCase().includes(needle);
    }
    const max = params.max ?? DEFAULT_FIND_LINES;
    const found = findLines(text, match, max);
    return {
      ...(await this.#page(tab)),
      snapshotId: `s${generation}`,
      lines: found.lines,
      matches: found.matches,
      limitReached: found.matches > found.lines.length,
    };
  }

  // -------------------------------------------------------------------------
  // Actions

  async navigate(params: BrowserParams["browser.navigate"]): Promise<BrowserActionResult> {
    if (!NAVIGABLE.test(params.url)) {
      throw new ToolCallError(
        "browser.bad-url",
        `${params.url.slice(0, 200)}: only http, https and about:blank can be opened`,
      );
    }
    const tab = await this.#tab(params.tab);
    tab.takeDialogs();
    let status: number | null = null;
    try {
      status = (await tab.goto(params.url, BROWSER_NAVIGATION_TIMEOUT_MS)).status;
    } catch (error) {
      return await this.#failed(tab, error, { status: null });
    }
    return await this.#finish(tab, params.expect, params.expectTimeoutMs, { status });
  }

  /**
   * `browser.back` (-1) and `browser.forward` (+1): a navigation like
   * `navigate`, so every ref of the tab is stale after it and the result
   * carries the new page's snapshot. No such history entry is
   * `navigation_failed`, with nothing done.
   */
  async history(
    delta: -1 | 1,
    params: BrowserParams["browser.back" | "browser.forward"],
  ): Promise<BrowserActionResult> {
    const tab = await this.#tab(params.tab);
    tab.takeDialogs();
    let moved: { readonly status: number | null } | null;
    try {
      moved = await tab.history(delta, BROWSER_NAVIGATION_TIMEOUT_MS);
    } catch (error) {
      return await this.#failed(tab, error, { status: null });
    }
    if (moved === null) {
      return await this.#result(tab, {
        ok: false,
        outcome: "navigation_failed",
        message: `there is no ${delta < 0 ? "previous" : "next"} page in this tab's history. Nothing was done.`,
        verified: null,
        status: null,
      });
    }
    return await this.#finish(tab, params.expect, params.expectTimeoutMs, {
      status: moved.status,
    });
  }

  async act(
    method: "browser.click" | "browser.type" | "browser.select" | "browser.press",
    params: BrowserParams["browser.click" | "browser.type" | "browser.select" | "browser.press"],
  ): Promise<BrowserActionResult> {
    const ref = (params as { ref?: string }).ref;
    let tab: DriverTab;
    let local: string | undefined;
    if (ref === undefined) {
      tab = await this.#tab((params as BrowserParams["browser.press"]).tab);
    } else {
      const resolved = await this.#resolve(ref);
      if (resolved.kind === "stale") {
        return await this.#refused(await this.#tab(), "stale_ref", resolved.message);
      }
      tab = resolved.tab;
      local = resolved.local;
      const refusal = await this.#check(method, tab, local);
      if (refusal !== undefined) return await this.#refused(tab, refusal.outcome, refusal.message);
    }
    tab.takeDialogs();
    try {
      await this.#dispatchAction(method, params, tab, local);
    } catch (error) {
      return await this.#failed(tab, error);
    }
    return await this.#finish(tab, params.expect, params.expectTimeoutMs);
  }

  /** `browser.field`: the kind and owner-frame origin of the field `ref`. */
  async field(params: BrowserParams["browser.field"]): Promise<BrowserResults["browser.field"]> {
    const resolved = await this.#resolve(params.ref);
    if (resolved.kind === "stale") throw new ToolCallError("browser.stale-ref", resolved.message);
    const info = await this.#observe(() =>
      resolved.tab.field(resolved.local, BROWSER_OBSERVE_TIMEOUT_MS),
    );
    if (!info.found) {
      throw new ToolCallError("browser.stale-ref", "the element is no longer on the page");
    }
    return { ...(await this.#page(resolved.tab)), field: info.field, origin: info.origin };
  }

  /**
   * `browser.fill`: the same pre-dispatch checks as `browser.type`, then the
   * owner frame's origin and the field's kind, read again right before the
   * fill (the hub read them one call earlier, and the page may have moved).
   * A refusal throws and fills nothing. The value joins the scrub set before
   * anything that could echo it runs.
   */
  async fill(params: BrowserParams["browser.fill"]): Promise<BrowserActionResult> {
    const resolved = await this.#resolve(params.ref);
    if (resolved.kind === "stale") {
      return await this.#refused(await this.#tab(), "stale_ref", resolved.message);
    }
    const { tab, local } = resolved;
    const refusal = await this.#check("browser.type", tab, local);
    if (refusal !== undefined) return await this.#refused(tab, refusal.outcome, refusal.message);
    const info = await this.#observe(() => tab.field(local, BROWSER_OBSERVE_TIMEOUT_MS));
    if (!info.found)
      return await this.#refused(tab, "stale_ref", "the element is no longer on the page");
    const allowed = params.origins.map((origin) => origin.toLowerCase());
    if (info.origin === null || !allowed.includes(info.origin)) {
      throw new ToolCallError(
        "browser.origin-mismatch",
        `the field is in a frame on ${info.origin ?? "no web origin"}, which this secret is not bound to; nothing was filled`,
      );
    }
    if (
      info.field === "none" ||
      (params.fields.length > 0 && !params.fields.includes(info.field))
    ) {
      throw new ToolCallError(
        "browser.field-mismatch",
        `the field is a ${info.field} field; this secret may go only into ${params.fields.length === 0 ? "a text" : params.fields.join(" or ")} field. Nothing was filled`,
      );
    }
    this.#secrets.add(params.value);
    tab.takeDialogs();
    const timeout = BROWSER_ACTION_TIMEOUT_MS;
    try {
      // Marked first, so no screenshot can see the value unmasked.
      await tab.mark(local, timeout);
      await tab.fill(local, params.value, timeout);
      if (params.submit === true) await tab.press(local, "Enter", timeout);
    } catch (error) {
      return await this.#failed(tab, error);
    }
    return await this.#finish(tab, params.expect, params.expectTimeoutMs);
  }

  async #dispatchAction(
    method: "browser.click" | "browser.type" | "browser.select" | "browser.press",
    params: BrowserParams["browser.click" | "browser.type" | "browser.select" | "browser.press"],
    tab: DriverTab,
    local: string | undefined,
  ): Promise<void> {
    const timeout = BROWSER_ACTION_TIMEOUT_MS;
    switch (method) {
      case "browser.click": {
        const p = params as BrowserParams["browser.click"];
        await tab.click(
          local as string,
          { button: p.button ?? "left", double: p.double ?? false },
          timeout,
        );
        return;
      }
      case "browser.type": {
        const p = params as BrowserParams["browser.type"];
        await tab.fill(local as string, p.text, timeout);
        if (p.submit === true) await tab.press(local, "Enter", timeout);
        return;
      }
      case "browser.select":
        await tab.select(
          local as string,
          (params as BrowserParams["browser.select"]).values,
          timeout,
        );
        return;
      case "browser.press":
        await tab.press(local, (params as BrowserParams["browser.press"]).key, timeout);
        return;
    }
  }

  /** The pre-dispatch checks: a refusal, or `undefined` to go ahead. */
  async #check(
    method: string,
    tab: DriverTab,
    local: string,
  ): Promise<{ outcome: BrowserOutcome; message: string } | undefined> {
    let state: Awaited<ReturnType<DriverTab["inspect"]>>;
    try {
      state = await tab.inspect(local, BROWSER_OBSERVE_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof DriverError && error.kind === "unavailable") throw toolError(error);
      return {
        outcome: "not_actionable",
        message: `the target could not be inspected: ${firstLine(error)}`,
      };
    }
    if (!state.found) {
      return { outcome: "stale_ref", message: "the element is no longer on the page" };
    }
    if (!state.visible) return { outcome: "not_actionable", message: "the element is hidden" };
    if (method !== "browser.press" && !state.enabled) {
      return { outcome: "not_actionable", message: "the element is disabled" };
    }
    if (method === "browser.type" && !state.editable) {
      return { outcome: "not_actionable", message: "the element does not accept text" };
    }
    if (method === "browser.click" && state.covered) {
      return {
        outcome: "not_actionable",
        message: "another element covers the target (a dialog, an overlay or a banner)",
      };
    }
    return undefined;
  }

  async wait(params: BrowserParams["browser.wait"]): Promise<BrowserActionResult> {
    const tab = await this.#tab(params.tab);
    const { callId: _, tab: __, timeoutMs, ...conditions } = params;
    tab.takeDialogs();
    const verified = await this.#verify(tab, conditions, timeoutMs);
    return await this.#result(tab, {
      ok: verified,
      outcome: verified ? "done" : "not_verified",
      message: verified ? null : `the condition did not hold within ${timeoutMs} ms`,
      verified,
    });
  }

  /** After an action: check `expect`, then the closing snapshot. */
  async #finish(
    tab: DriverTab,
    expect: BrowserExpect | undefined,
    expectTimeoutMs: number | undefined,
    extra: { status?: number | null } = {},
  ): Promise<BrowserActionResult> {
    if (expect === undefined) {
      return await this.#result(tab, {
        ok: true,
        outcome: "done",
        message: null,
        verified: null,
        ...extra,
      });
    }
    const timeoutMs = expectTimeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS;
    const verified = await this.#verify(tab, expect, timeoutMs);
    return await this.#result(tab, {
      ok: verified,
      outcome: verified ? "done" : "not_verified",
      message: verified
        ? null
        : `the action ran, but the expectation did not hold within ${timeoutMs} ms; treat it as not done`,
      verified,
      ...extra,
    });
  }

  /** Polls every condition of `expect` until all hold or `timeoutMs` passed; checks at least once. */
  async #verify(tab: DriverTab, expect: BrowserExpect, timeoutMs: number): Promise<boolean> {
    const now = this.#options.now ?? Date.now;
    const sleep = this.#options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const deadline = now() + timeoutMs;
    for (;;) {
      if (await this.#holds(tab, expect)) return true;
      if (now() >= deadline) return false;
      await sleep(Math.min(this.#options.pollMs ?? EXPECT_POLL_MS, Math.max(1, deadline - now())));
    }
  }

  async #holds(tab: DriverTab, expect: BrowserExpect): Promise<boolean> {
    try {
      if (expect.urlIncludes !== undefined && !tab.url().includes(expect.urlIncludes)) return false;
      if (
        expect.titleIncludes !== undefined &&
        !(await tab.title()).includes(expect.titleIncludes)
      ) {
        return false;
      }
      if (expect.textVisible !== undefined && !(await tab.textVisible(expect.textVisible)))
        return false;
      if (expect.textGone !== undefined && (await tab.textVisible(expect.textGone))) return false;
      return true;
    } catch {
      // The page is between documents; the next poll looks again.
      return false;
    }
  }

  async #refused(
    tab: DriverTab,
    outcome: BrowserOutcome,
    message: string,
  ): Promise<BrowserActionResult> {
    return await this.#result(tab, {
      ok: false,
      outcome,
      message: `${message}. Nothing was done.`,
      verified: null,
    });
  }

  async #failed(
    tab: DriverTab,
    error: unknown,
    extra: { status?: number | null } = {},
  ): Promise<BrowserActionResult> {
    if (!(error instanceof DriverError)) throw error;
    if (error.kind !== "timeout" && error.kind !== "navigation") throw toolError(error);
    const outcome: BrowserOutcome = error.kind === "timeout" ? "timeout" : "navigation_failed";
    return await this.#result(tab, {
      ok: false,
      outcome,
      message: error.message,
      verified: null,
      ...extra,
    });
  }

  async #result(
    tab: DriverTab,
    fields: Pick<BrowserActionResult, "ok" | "outcome" | "message" | "verified"> & {
      status?: number | null;
    },
  ): Promise<BrowserActionResult> {
    const snapshot = await this.#lastSnapshot(tab);
    return { ...(await this.#page(tab)), ...fields, dialogs: tab.takeDialogs(), snapshot };
  }

  // -------------------------------------------------------------------------
  // Screenshots and tabs

  async screenshot(
    params: BrowserParams["browser.screenshot"],
  ): Promise<BrowserResults["browser.screenshot"]> {
    let tab: DriverTab;
    let local: string | undefined;
    if (params.ref !== undefined) {
      const resolved = await this.#resolve(params.ref);
      if (resolved.kind === "stale") throw new ToolCallError("browser.stale-ref", resolved.message);
      tab = resolved.tab;
      local = resolved.local;
    } else {
      tab = await this.#tab(params.tab);
    }
    let fullPage = params.fullPage === true;
    let data: Buffer | undefined;
    for (const attempt of fullPage ? [true, false] : [false]) {
      fullPage = attempt;
      for (const quality of SCREENSHOT_QUALITIES) {
        const shot = await this.#observe(() =>
          tab.screenshot({
            ...(local === undefined ? {} : { ref: local }),
            fullPage,
            quality,
            timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
          }),
        );
        if (shot.length <= MAX_SCREENSHOT_BYTES) {
          data = shot;
          break;
        }
      }
      if (data !== undefined) break;
    }
    if (data === undefined) {
      throw new ToolCallError(
        "tool.too-large",
        `the screenshot is larger than ${MAX_SCREENSHOT_BYTES} bytes even at JPEG quality ${SCREENSHOT_QUALITIES.at(-1)}`,
      );
    }
    const size = jpegSize(data);
    if (size === undefined)
      throw new ToolCallError("browser.failed", "the screenshot is not a JPEG");
    return {
      ...(await this.#page(tab)),
      data: data.toString("base64"),
      mimeType: "image/jpeg",
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      width: size.width,
      height: size.height,
    };
  }

  async tabs(params: BrowserParams["browser.tabs"]): Promise<BrowserResults["browser.tabs"]> {
    switch (params.action) {
      case "list":
        break;
      case "new": {
        if (params.url !== undefined && !NAVIGABLE.test(params.url)) {
          throw new ToolCallError(
            "browser.bad-url",
            "only http, https and about:blank can be opened",
          );
        }
        const tab = await this.#driver.newTab();
        this.#active = tab;
        await tab.bringToFront();
        if (params.url !== undefined) {
          try {
            await tab.goto(params.url, BROWSER_NAVIGATION_TIMEOUT_MS);
          } catch (error) {
            if (!(error instanceof DriverError)) throw error;
            // The tab is open; the list shows where it stands.
          }
        }
        break;
      }
      case "select": {
        const tab = await this.#tab(params.index);
        this.#active = tab;
        await tab.bringToFront();
        break;
      }
      case "close": {
        const tab = await this.#tab(params.index);
        await tab.close();
        if (this.#active === tab) this.#active = undefined;
        break;
      }
    }
    const tabs = await this.#driver.tabs();
    if (this.#active !== undefined && !tabs.includes(this.#active)) this.#active = undefined;
    const active = this.#active === undefined ? null : tabs.indexOf(this.#active);
    return {
      tabs: await Promise.all(
        tabs.map(async (tab, index) => ({
          index,
          url: tab.url(),
          title: await tab.title().catch(() => ""),
          active: index === active,
        })),
      ),
      active,
    };
  }

  // -------------------------------------------------------------------------

  async #page(tab: DriverTab): Promise<{ tab: number; url: string; title: string }> {
    return {
      tab: await this.#indexOf(tab),
      url: tab.url(),
      title: await tab.title().catch(() => ""),
    };
  }

  /** Runs an observation; a driver failure is the call's error, not an outcome. */
  async #observe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DriverError) throw toolError(error);
      throw error;
    }
  }
}

/**
 * A driver failure as the call's error: the browser going away is the box's
 * (`browser.unavailable`, the next call reconnects); anything else is
 * `browser.failed`.
 */
function toolError(error: DriverError): ToolCallError {
  const code =
    error.kind === "unavailable"
      ? "browser.unavailable"
      : error.kind === "mask"
        ? "browser.mask-missing"
        : "browser.failed";
  return new ToolCallError(code, error.message);
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}
