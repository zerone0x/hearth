/**
 * What the browser tools need from a browser, with no CDP in sight: the tabs
 * of one browser context, each able to snapshot, act on a Playwright ref and
 * take a screenshot. `playwright.ts` implements it on `playwright-core`;
 * unit tests implement it with a fake page model.
 *
 * Refs here are Playwright's own (`e5`, `f1e5`), never the `s<generation>`
 * refs the tools hand to the model.
 */

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

/** A failure of a driver call, mapped to an outcome by the tools. */
export class DriverError extends Error {
  constructor(
    readonly kind: "timeout" | "navigation" | "failed",
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
  select(ref: string, values: readonly string[], timeoutMs: number): Promise<void>;
  press(ref: string | undefined, key: string, timeoutMs: number): Promise<void>;
  textVisible(text: string): Promise<boolean>;
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
