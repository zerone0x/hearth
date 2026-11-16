/**
 * Browser tool RPC (protocol 1.3, decision 0032): the `browser.*` methods the
 * hub-side runner calls on the box to drive the box's Chromium over CDP
 * (decision 0026). The design is `docs/research/browser.md`:
 *
 * - **Snapshot first.** The page is read as an accessibility snapshot whose
 *   lines carry refs (`[ref=s3e5]`); a screenshot is taken only on request.
 * - **Act by ref, snapshot last.** Acting methods take a ref from the latest
 *   snapshot of that tab and return a fresh snapshot with their result.
 * - **Refs carry their snapshot.** A ref names the snapshot it came from
 *   (`s<generation>`); one from an older snapshot is refused at once with the
 *   outcome `stale_ref`, never waited on.
 * - **Verified actions.** An acting method takes an optional `expect`; the box
 *   checks it after the action and the result says whether it held.
 *
 * These are tool methods like `tool.*` (decision 0011): same frames, same
 * idempotent-per-boot calls, same error classification. A 1.2 box answers
 * them `unknown-method`. Pure types and guards, no I/O.
 */

import { FieldError, Fields, isObj } from "./fields";

// ---------------------------------------------------------------------------
// Limits

/** Most UTF-8 bytes of snapshot text a result carries; the rest is spilled to a box file. */
export const MAX_SNAPSHOT_TEXT_BYTES = 24 * 1024;
/** Most bytes of a whole snapshot the box keeps in its spill file. */
export const MAX_SNAPSHOT_SPILL_BYTES = 4 * 1024 * 1024;
/** Most bytes of a screenshot (JPEG) a result carries, as `MAX_TOOL_FILE_BYTES`. */
export const MAX_SCREENSHOT_BYTES = 1024 * 1024;
/** Longest URL `browser.navigate` and `browser.tabs` accept, in characters. */
export const MAX_URL_LENGTH = 8192;
/** Longest text `browser.type` accepts, in characters. */
export const MAX_TYPE_TEXT_LENGTH = 64 * 1024;
/** Longest `element` description, in characters. */
export const MAX_ELEMENT_LENGTH = 512;
/** Longest search text or expectation string, in characters. */
export const MAX_MATCH_LENGTH = 1024;
/** Most lines `browser.find` returns. */
export const MAX_FIND_LINES = 200;
/** Lines `browser.find` returns when the call names no `max`. */
export const DEFAULT_FIND_LINES = 20;
/** Longest line `browser.find` returns, in characters; longer lines are cut. */
export const MAX_FIND_LINE_LENGTH = 1000;
/** Most options `browser.select` accepts. */
export const MAX_SELECT_VALUES = 64;
/** Most tabs `browser.tabs` lists. */
export const MAX_TABS = 100;
/** Deepest `depth` `browser.snapshot` accepts. */
export const MAX_SNAPSHOT_DEPTH = 100;

/** Box-side timeout of connecting to the browser's CDP endpoint. */
export const BROWSER_CONNECT_TIMEOUT_MS = 10_000;
/** Box-side timeout of one snapshot or screenshot. */
export const BROWSER_OBSERVE_TIMEOUT_MS = 10_000;
/** Box-side timeout of one action (click, type, select, press), Playwright's actionability waits included. */
export const BROWSER_ACTION_TIMEOUT_MS = 10_000;
/** Box-side timeout of one navigation (until `load`). */
export const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
/** How long an `expect` is checked when the call names no `expectTimeoutMs`. */
export const DEFAULT_EXPECT_TIMEOUT_MS = 3_000;
/** Longest `expectTimeoutMs`, and longest `browser.wait`. */
export const MAX_EXPECT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Refs

/**
 * A ref as the box hands it out: `s<generation>` then Playwright's own ref
 * (`e5`, or `f1e5` inside a frame). The generation names the snapshot.
 */
export const BROWSER_REF_PATTERN = /^s([1-9][0-9]{0,8})((?:f[0-9]{1,6})?e[0-9]{1,9})$/;
/** Longest ref the protocol carries; the shape itself is the box's to judge. */
export const MAX_REF_LENGTH = 64;

/** Splits a ref into its snapshot generation and Playwright's ref, or `undefined`. */
export function parseBrowserRef(
  ref: string,
): { readonly generation: number; readonly local: string } | undefined {
  const match = BROWSER_REF_PATTERN.exec(ref);
  if (match === null) return undefined;
  return { generation: Number(match[1]), local: match[2] as string };
}

export function formatBrowserRef(generation: number, local: string): string {
  return `s${generation}${local}`;
}

// ---------------------------------------------------------------------------
// Methods

interface Base {
  readonly callId: string;
}

/** A condition the box checks after an action (the verified-actions contract). */
export interface BrowserExpect {
  /** A substring of the page URL. */
  readonly urlIncludes?: string;
  /** A substring of the page title. */
  readonly titleIncludes?: string;
  /** Text that must be visible on the page. */
  readonly textVisible?: string;
  /** Text that must not be visible on the page. */
  readonly textGone?: string;
}

interface Acting {
  /** A short human description of the target, for approvals and the live desktop. */
  readonly element: string;
  readonly expect?: BrowserExpect;
  /** How long `expect` is checked; `DEFAULT_EXPECT_TIMEOUT_MS` when absent. */
  readonly expectTimeoutMs?: number;
}

export type BrowserTabAction = "list" | "new" | "select" | "close";
export type BrowserButton = "left" | "right" | "middle";

type BrowserHistoryParams = Base & {
  readonly tab?: number;
  readonly expect?: BrowserExpect;
  readonly expectTimeoutMs?: number;
};

export interface BrowserParams {
  /** Load `url` (http, https or `about:blank`) in the tab. */
  "browser.navigate": Base & {
    readonly url: string;
    readonly tab?: number;
    readonly expect?: BrowserExpect;
    readonly expectTimeoutMs?: number;
  };
  /** Goes back one entry in the tab's history. */
  "browser.back": BrowserHistoryParams;
  /** Goes forward one entry in the tab's history. */
  "browser.forward": BrowserHistoryParams;
  /** The tab's snapshot, or the subtree under `ref`, to `depth`. */
  "browser.snapshot": Base & {
    readonly tab?: number;
    readonly ref?: string;
    readonly depth?: number;
  };
  /** Lines of a fresh snapshot matching `text` (substring, case-insensitive) or `regex`. */
  "browser.find": Base & {
    readonly text?: string;
    readonly regex?: string;
    readonly tab?: number;
    readonly max?: number;
  };
  "browser.click": Base &
    Acting & {
      readonly ref: string;
      readonly button?: BrowserButton;
      readonly double?: boolean;
    };
  /** Replaces the field's value with `text`; `submit` presses Enter after it. */
  "browser.type": Base &
    Acting & {
      readonly ref: string;
      readonly text: string;
      readonly submit?: boolean;
    };
  "browser.select": Base &
    Acting & {
      readonly ref: string;
      readonly values: readonly string[];
    };
  /** Presses `key` (Playwright key names: `Enter`, `Control+A`, …) on `ref`, or on the page. */
  "browser.press": Base & {
    readonly key: string;
    readonly ref?: string;
    readonly element?: string;
    readonly tab?: number;
    readonly expect?: BrowserExpect;
    readonly expectTimeoutMs?: number;
  };
  /** Waits until every given condition holds, for up to `timeoutMs`. */
  "browser.wait": Base &
    BrowserExpect & {
      readonly tab?: number;
      readonly timeoutMs: number;
    };
  /** A JPEG of the tab's viewport, the whole page, or the element `ref`. */
  "browser.screenshot": Base & {
    readonly tab?: number;
    readonly ref?: string;
    readonly fullPage?: boolean;
  };
  "browser.tabs": Base & {
    readonly action: BrowserTabAction;
    readonly index?: number;
    readonly url?: string;
  };
}

/**
 * How an acting call ended. `done` and `not_verified` mean the action ran;
 * the others mean it did not (`timeout`: Playwright gave up waiting, so it may
 * or may not have landed).
 */
export type BrowserOutcome =
  | "done"
  | "not_verified"
  | "stale_ref"
  | "not_actionable"
  | "timeout"
  | "navigation_failed";

export const BROWSER_OUTCOMES: readonly BrowserOutcome[] = [
  "done",
  "not_verified",
  "stale_ref",
  "not_actionable",
  "timeout",
  "navigation_failed",
];

/** Snapshot text as a result carries it. */
export interface BrowserSnapshot {
  /** `s<generation>`: every ref in `text` starts with it. */
  readonly snapshotId: string;
  /** At most `MAX_SNAPSHOT_TEXT_BYTES`; cut at a line end, with a marker, when longer. */
  readonly text: string;
  /** UTF-8 bytes of the whole snapshot. */
  readonly totalBytes: number;
  readonly truncated: boolean;
  /** A box path holding the whole snapshot when `truncated`. */
  readonly fullSnapshotPath: string | null;
}

/** A JavaScript dialog the box dismissed while the call ran. */
export interface BrowserDialog {
  readonly type: string;
  readonly message: string;
}

export interface BrowserPageInfo {
  readonly tab: number;
  readonly url: string;
  readonly title: string;
}

export interface BrowserActionResult extends BrowserPageInfo {
  /** True when the action ran and `expect`, if given, held. */
  readonly ok: boolean;
  readonly outcome: BrowserOutcome;
  /** Why the outcome is not `done`, in a sentence. */
  readonly message: string | null;
  /** `expect` held (true), did not (false), or none was given (null). */
  readonly verified: boolean | null;
  /** `browser.navigate`: the main response's HTTP status, when there was one. */
  readonly status?: number | null;
  readonly dialogs: readonly BrowserDialog[];
  /** The fresh snapshot ("snapshot last"); null when it could not be taken. */
  readonly snapshot: BrowserSnapshot | null;
}

export interface BrowserTab {
  readonly index: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export interface BrowserResults {
  "browser.navigate": BrowserActionResult;
  "browser.back": BrowserActionResult;
  "browser.forward": BrowserActionResult;
  "browser.snapshot": BrowserPageInfo & { readonly snapshot: BrowserSnapshot };
  "browser.find": BrowserPageInfo & {
    readonly snapshotId: string;
    readonly lines: readonly string[];
    readonly matches: number;
    readonly limitReached: boolean;
  };
  "browser.click": BrowserActionResult;
  "browser.type": BrowserActionResult;
  "browser.select": BrowserActionResult;
  "browser.press": BrowserActionResult;
  "browser.wait": BrowserActionResult;
  /** `data` is the JPEG in base64. */
  "browser.screenshot": BrowserPageInfo & {
    readonly data: string;
    readonly mimeType: "image/jpeg";
    readonly bytes: number;
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
  };
  "browser.tabs": { readonly tabs: readonly BrowserTab[]; readonly active: number | null };
}

export type BrowserMethod = keyof BrowserParams;

export const BROWSER_METHODS: readonly BrowserMethod[] = [
  "browser.navigate",
  "browser.back",
  "browser.forward",
  "browser.snapshot",
  "browser.find",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.press",
  "browser.wait",
  "browser.screenshot",
  "browser.tabs",
];

/** Methods that change the page or the tabs; never re-sent to a new boot. */
export const MUTATING_BROWSER_METHODS: readonly BrowserMethod[] = [
  "browser.navigate",
  "browser.back",
  "browser.forward",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.press",
  "browser.tabs",
];

export function isBrowserMethod(method: string): method is BrowserMethod {
  return (BROWSER_METHODS as readonly string[]).includes(method);
}

/**
 * The box-side budget of one browser call: connecting, the action or
 * navigation, the expectation or wait, and the closing snapshot. The box
 * answers `tool.deadline` after it; the hub adds `TOOL_DEADLINE_GRACE_MS`.
 */
export function browserBudgetMs<M extends BrowserMethod>(
  method: M,
  params: BrowserParams[M],
): number {
  const p = params as { readonly expectTimeoutMs?: number; readonly timeoutMs?: number };
  const observe = BROWSER_CONNECT_TIMEOUT_MS + BROWSER_OBSERVE_TIMEOUT_MS;
  switch (method) {
    case "browser.snapshot":
    case "browser.find":
    case "browser.screenshot":
      return observe + BROWSER_OBSERVE_TIMEOUT_MS;
    case "browser.wait":
      return observe + (p.timeoutMs ?? 0);
    case "browser.tabs":
      return observe + BROWSER_NAVIGATION_TIMEOUT_MS;
    case "browser.navigate":
    case "browser.back":
    case "browser.forward":
      return (
        observe + BROWSER_NAVIGATION_TIMEOUT_MS + (p.expectTimeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS)
      );
    default:
      return observe + BROWSER_ACTION_TIMEOUT_MS + (p.expectTimeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS);
  }
}

// ---------------------------------------------------------------------------
// Decoding

const EXPECT_KEYS = ["urlIncludes", "titleIncludes", "textVisible", "textGone"] as const;

function match(f: Fields, key: string): string {
  return f.string(key, MAX_MATCH_LENGTH, false);
}

function optional<K extends string, T>(f: Fields, key: K, read: (key: K) => T): { [P in K]?: T } {
  return (f.has(key) ? { [key]: read(key) } : {}) as { [P in K]?: T };
}

function array(f: Fields, key: string, max: number, nonEmpty = false): unknown[] {
  const value = f.raw(key);
  if (!Array.isArray(value)) f.fail(key, "expected an array");
  if (nonEmpty && value.length === 0) f.fail(key, "must not be empty");
  if (value.length > max) f.fail(key, `more than ${max} items`);
  return value;
}

function conditions(f: Fields): BrowserExpect {
  const out: Record<string, string> = {};
  for (const key of EXPECT_KEYS) if (f.has(key)) out[key] = match(f, key);
  return out;
}

function expectation(f: Fields): { expect?: BrowserExpect; expectTimeoutMs?: number } {
  const out: { expect?: BrowserExpect; expectTimeoutMs?: number } = {};
  if (f.has("expect")) {
    const value = conditions(f.object("expect"));
    if (Object.keys(value).length === 0)
      f.fail("expect", `names none of ${EXPECT_KEYS.join(", ")}`);
    out.expect = value;
  }
  if (f.has("expectTimeoutMs")) {
    out.expectTimeoutMs = f.int("expectTimeoutMs", 0, MAX_EXPECT_TIMEOUT_MS);
  }
  return out;
}

function ref(f: Fields, key: string): string {
  const value = f.string(key, MAX_REF_LENGTH, false);
  if (!/^[A-Za-z0-9]+$/.test(value)) f.fail(key, "expected a ref such as s3e12");
  return value;
}

function tab(f: Fields): { tab?: number } {
  return optional(f, "tab", (k) => f.int(k, 0, MAX_TABS - 1));
}

function url(f: Fields, key: string): string {
  const value = f.string(key, MAX_URL_LENGTH, false);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) f.fail(key, "must not contain control characters");
  return value;
}

function element(f: Fields): string {
  return f.string("element", MAX_ELEMENT_LENGTH, false);
}

function base(f: Fields): Base {
  return { callId: f.id("callId") };
}

export const BROWSER_PARAMS: {
  readonly [M in BrowserMethod]: (f: Fields) => BrowserParams[M];
} = {
  "browser.navigate": (f) => ({ ...base(f), url: url(f, "url"), ...tab(f), ...expectation(f) }),
  "browser.back": (f) => ({ ...base(f), ...tab(f), ...expectation(f) }),
  "browser.forward": (f) => ({ ...base(f), ...tab(f), ...expectation(f) }),
  "browser.snapshot": (f) => ({
    ...base(f),
    ...tab(f),
    ...optional(f, "ref", (k) => ref(f, k)),
    ...optional(f, "depth", (k) => f.int(k, 1, MAX_SNAPSHOT_DEPTH)),
  }),
  "browser.find": (f) => {
    if (f.has("text") === f.has("regex")) f.fail("text", "give exactly one of text and regex");
    const out = {
      ...base(f),
      ...optional(f, "text", (k) => match(f, k)),
      ...optional(f, "regex", (k) => match(f, k)),
      ...tab(f),
      ...optional(f, "max", (k) => f.int(k, 1, MAX_FIND_LINES)),
    };
    if (out.regex !== undefined) {
      try {
        new RegExp(out.regex, "i");
      } catch {
        f.fail("regex", "is not a valid regular expression");
      }
    }
    return out;
  },
  "browser.click": (f) => ({
    ...base(f),
    ref: ref(f, "ref"),
    element: element(f),
    ...optional(f, "button", (k) => f.oneOf(k, ["left", "right", "middle"] as const)),
    ...optional(f, "double", (k) => f.bool(k)),
    ...expectation(f),
  }),
  "browser.type": (f) => ({
    ...base(f),
    ref: ref(f, "ref"),
    element: element(f),
    text: f.string("text", MAX_TYPE_TEXT_LENGTH),
    ...optional(f, "submit", (k) => f.bool(k)),
    ...expectation(f),
  }),
  "browser.select": (f) => {
    const values = array(f, "values", MAX_SELECT_VALUES, true);
    return {
      ...base(f),
      ref: ref(f, "ref"),
      element: element(f),
      values: values.map((item, index) => {
        if (typeof item !== "string" || item.length > MAX_MATCH_LENGTH) {
          throw new FieldError(`${f.path("values")}[${index}]`, "expected a short string");
        }
        return item;
      }),
      ...expectation(f),
    };
  },
  "browser.press": (f) => {
    const out = {
      ...base(f),
      key: f.string("key", 64, false),
      ...optional(f, "ref", (k) => ref(f, k)),
      ...optional(f, "element", () => element(f)),
      ...tab(f),
      ...expectation(f),
    };
    if (out.ref !== undefined && out.tab !== undefined)
      f.fail("tab", "a ref already names its tab");
    return out;
  },
  "browser.wait": (f) => {
    const value = conditions(f);
    if (Object.keys(value).length === 0)
      f.fail("textVisible", `give one of ${EXPECT_KEYS.join(", ")}`);
    return {
      ...base(f),
      ...value,
      ...tab(f),
      timeoutMs: f.int("timeoutMs", 0, MAX_EXPECT_TIMEOUT_MS),
    };
  },
  "browser.screenshot": (f) => {
    const out = {
      ...base(f),
      ...tab(f),
      ...optional(f, "ref", (k) => ref(f, k)),
      ...optional(f, "fullPage", (k) => f.bool(k)),
    };
    if (out.ref !== undefined && out.fullPage === true) f.fail("fullPage", "not with a ref");
    return out;
  },
  "browser.tabs": (f) => {
    const action = f.oneOf("action", ["list", "new", "select", "close"] as const);
    const out = {
      ...base(f),
      action,
      ...optional(f, "index", (k) => f.int(k, 0, MAX_TABS - 1)),
      ...optional(f, "url", (k) => url(f, k)),
    };
    if ((action === "select" || action === "close") && out.index === undefined) {
      f.fail("index", `required for ${action}`);
    }
    if (action !== "new" && out.url !== undefined) f.fail("url", "only for new");
    return out;
  },
};

function snapshotOf(f: Fields): BrowserSnapshot {
  return {
    snapshotId: f.string("snapshotId", MAX_REF_LENGTH, false),
    // The cap is in bytes; a character is at least one, and the marker is short.
    text: f.string("text", MAX_SNAPSHOT_TEXT_BYTES + 512),
    totalBytes: f.int("totalBytes", 0),
    truncated: f.bool("truncated"),
    fullSnapshotPath:
      f.raw("fullSnapshotPath") === null ? null : f.string("fullSnapshotPath", 4096, false),
  };
}

function pageInfo(f: Fields): BrowserPageInfo {
  return {
    tab: f.int("tab", 0, MAX_TABS - 1),
    url: f.string("url", MAX_URL_LENGTH * 2),
    title: f.string("title", MAX_TEXT_FIELD),
  };
}

/** One object of an array field. */
function item_(f: Fields, key: string, item: unknown, index: number): Fields {
  const path = `${f.path(key)}[${index}]`;
  if (!isObj(item)) throw new FieldError(path, "expected an object");
  return new Fields(item, path);
}

/** Longest title, message or dialog text a result carries. */
const MAX_TEXT_FIELD = 4096;

function action(f: Fields): BrowserActionResult {
  const dialogs = array(f, "dialogs", 16);
  return {
    ...pageInfo(f),
    ok: f.bool("ok"),
    outcome: f.oneOf("outcome", BROWSER_OUTCOMES),
    message: f.raw("message") === null ? null : f.string("message", MAX_TEXT_FIELD),
    verified: f.raw("verified") === null ? null : f.bool("verified"),
    ...(f.has("status")
      ? { status: f.raw("status") === null ? null : f.int("status", 0, 999) }
      : {}),
    dialogs: dialogs.map((item, index) => {
      const d = item_(f, "dialogs", item, index);
      return { type: d.string("type", 64), message: d.string("message", MAX_TEXT_FIELD) };
    }),
    snapshot: f.raw("snapshot") === null ? null : snapshotOf(f.object("snapshot")),
  };
}

export const BROWSER_RESULTS: {
  readonly [M in BrowserMethod]: (f: Fields) => BrowserResults[M];
} = {
  "browser.navigate": action,
  "browser.back": action,
  "browser.forward": action,
  "browser.snapshot": (f) => ({ ...pageInfo(f), snapshot: snapshotOf(f.object("snapshot")) }),
  "browser.find": (f) => {
    const lines = array(f, "lines", MAX_FIND_LINES);
    return {
      ...pageInfo(f),
      snapshotId: f.string("snapshotId", MAX_REF_LENGTH, false),
      lines: lines.map((line, index) => {
        if (typeof line !== "string" || line.length > MAX_FIND_LINE_LENGTH + 16) {
          throw new FieldError(`${f.path("lines")}[${index}]`, "expected a short string");
        }
        return line;
      }),
      matches: f.int("matches", 0),
      limitReached: f.bool("limitReached"),
    };
  },
  "browser.click": action,
  "browser.type": action,
  "browser.select": action,
  "browser.press": action,
  "browser.wait": action,
  "browser.screenshot": (f) => {
    const mimeType = f.oneOf("mimeType", ["image/jpeg"] as const);
    return {
      ...pageInfo(f),
      data: f.string("data", Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4, false),
      mimeType,
      bytes: f.int("bytes", 1, MAX_SCREENSHOT_BYTES),
      sha256: f.string("sha256", 64, false),
      width: f.int("width", 1, 100_000),
      height: f.int("height", 1, 100_000),
    };
  },
  "browser.tabs": (f) => {
    const tabs = array(f, "tabs", MAX_TABS);
    return {
      tabs: tabs.map((item, index) => {
        const t = item_(f, "tabs", item, index);
        return {
          index: t.int("index", 0, MAX_TABS - 1),
          url: t.string("url", MAX_URL_LENGTH * 2),
          title: t.string("title", MAX_TEXT_FIELD),
          active: t.bool("active"),
        };
      }),
      active: f.raw("active") === null ? null : f.int("active", 0, MAX_TABS - 1),
    };
  },
};
