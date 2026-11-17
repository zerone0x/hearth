/**
 * What the browser tools need from a browser, with no CDP in sight: the tabs
 * of one browser context, each able to snapshot, act on a Playwright ref and
 * take a screenshot. `playwright.ts` implements it on `playwright-core`;
 * unit tests implement it with a fake page model.
 *
 * Refs here are Playwright's own (`e5`, `f1e5`), never the `s<generation>`
 * refs the tools hand to the model.
 */

import type { BrowserFieldKind } from "@hearth/protocol";

/** What the pre-dispatch checks found about a target (decision 0032). */
export interface TargetState {
  /** The ref resolves to an element of the latest snapshot. */
  readonly found: boolean;
  readonly visible: boolean;
  readonly enabled: boolean;
  /** Accepts text (an input, a textarea, a contenteditable). */
  readonly editable: boolean;
  /** Another element receives a pointer event at the target's centre. */
  readonly covered: boolean;
}

/** A field as `browser.field` and `browser.fill` see it (decision 0039). */
export interface FieldInfo {
  /** The ref resolves to an element. */
  readonly found: boolean;
  readonly field: BrowserFieldKind;
  /**
   * `scheme://host[:port]` of the frame that owns the element, from the URL the
   * browser committed for that frame (not from page script); null when the
   * frame is not on an http(s) URL (about:blank, srcdoc, data:).
   */
  readonly origin: string | null;
}

/**
 * A failure of a driver call, mapped to an outcome by the tools.
 * `unavailable`: the browser went away during the call (Chromium killed or
 * restarted); the box's fault, and the next call reconnects. `mask`: a filled
 * element cannot be found for its screenshot mask, so no screenshot is taken.
 */
export class DriverError extends Error {
  constructor(
    readonly kind: "timeout" | "navigation" | "failed" | "unavailable" | "mask",
    message: string,
  ) {
    super(message);
    this.name = "DriverError";
  }
}

export interface DriverDialog {
  readonly type: string;
  readonly message: string;
}

export interface DriverTab {
  url(): string;
  title(): Promise<string>;
  /** Main-frame navigations seen so far; a change makes every ref of the tab stale. */
  readonly navigations: number;
  /** Dialogs dismissed since the last call, oldest first; clears the list. */
  takeDialogs(): DriverDialog[];
  goto(url: string, timeoutMs: number): Promise<{ readonly status: number | null }>;
  /** Goes back (-1) or forward (+1) in the tab's history; null when there is no such entry. */
  history(delta: -1 | 1, timeoutMs: number): Promise<{ readonly status: number | null } | null>;
  /** The aria snapshot (Playwright's `ai` mode), of the page or the subtree under `ref`. */
  snapshot(options: {
    readonly ref?: string;
    readonly depth?: number;
    readonly timeoutMs: number;
  }): Promise<string>;
  inspect(ref: string, timeoutMs: number): Promise<TargetState>;
  click(
    ref: string,
    options: { readonly button: "left" | "right" | "middle"; readonly double: boolean },
    timeoutMs: number,
  ): Promise<void>;
  /** Replaces the value of the field with `text`. */
  fill(ref: string, text: string, timeoutMs: number): Promise<void>;
  /** The field's kind and its owner frame's origin. */
  field(ref: string, timeoutMs: number): Promise<FieldInfo>;
  /**
   * Marks the element as holding a filled secret: every later screenshot of
   * the tab masks it, and refuses (`DriverError` `mask`) while the element is
   * gone from a document that is still loaded. The mark ends when the frame
   * that owns the element navigates or goes away.
   */
  mark(ref: string, timeoutMs: number): Promise<void>;
  select(ref: string, values: readonly string[], timeoutMs: number): Promise<void>;
  press(ref: string | undefined, key: string, timeoutMs: number): Promise<void>;
  textVisible(text: string): Promise<boolean>;
  /** Masks every marked element; throws `DriverError` `mask` when one cannot be found. */
  screenshot(options: {
    readonly ref?: string;
    readonly fullPage: boolean;
    readonly quality: number;
    readonly timeoutMs: number;
  }): Promise<Buffer>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  /** The tabs of the default context, in order; connects first when needed. */
  tabs(): Promise<readonly DriverTab[]>;
  newTab(): Promise<DriverTab>;
  /** Drops the connection; the browser keeps running. */
  close(): Promise<void>;
}
