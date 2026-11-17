/**
 * A CDP-free `BrowserDriver` for tests: pages are plain objects whose
 * snapshot, targets and text the test sets, and every dispatched action is
 * recorded, so a test can prove an action was refused before dispatch.
 */

import type { BrowserFieldKind } from "@hearth/protocol";
import {
  type BrowserDriver,
  type DriverDialog,
  DriverError,
  type DriverTab,
  type FieldInfo,
  type TargetState,
} from "./driver";

export interface FakeTarget extends Partial<TargetState> {
  /** What a click does, if anything (navigate, show text, open a dialog). */
  readonly onClick?: (tab: FakeTab) => void;
  /** Its field kind; default `other`. */
  readonly field?: BrowserFieldKind;
  /** Its owner frame's origin; default the page URL's. */
  readonly origin?: string | null;
  /** What the field shows once filled, e.g. a snapshot line; set by `fill`. */
  value?: string;
}

export class FakeTab implements DriverTab {
  pageUrl = "about:blank";
  pageTitle = "";
  /** The snapshot text, Playwright style (`[ref=e1]`). */
  snapshotText = "- generic [ref=e1]";
  /** Text visible on the page, for `expect`. */
  visibleText = new Set<string>();
  targets = new Map<string, FakeTarget>();
  /** Every dispatched action, in order. */
  readonly actions: string[] = [];
  /** Snapshots taken, in order. */
  readonly snapshots: Array<{ ref?: string; depth?: number }> = [];
  /** A failure the next action or navigation throws. */
  failNext: DriverError | undefined;
  /** JPEG sizes the screenshot returns, per quality. */
  screenshotBytes: (quality: number, fullPage: boolean) => number = () => 1000;
  closed = false;
  /** Refs marked by `mark`, until the page navigates. */
  marks: string[] = [];
  /** A failure the next snapshot throws. */
  failSnapshot: DriverError | undefined;
  #navigations = 0;
  #dialogs: DriverDialog[] = [];
  /** Session history: URL and title of each entry, and the current one. */
  #history: Array<{ url: string; title: string }> = [];
  #at = -1;

  constructor(private readonly driver: FakeDriver) {}

  get navigations(): number {
    return this.#navigations;
  }

  /** The page moved to a new document. */
  navigate(url: string, title = ""): void {
    this.#history = [...this.#history.slice(0, this.#at + 1), { url, title }];
    this.#at = this.#history.length - 1;
    this.#show(url, title);
  }

  #show(url: string, title: string): void {
    this.pageUrl = url;
    this.pageTitle = title;
    this.#navigations++;
    // The document that held the filled values is gone.
    this.marks = [];
  }

  dialog(type: string, message: string): void {
    this.#dialogs.push({ type, message });
  }

  takeDialogs(): DriverDialog[] {
    const out = this.#dialogs;
    this.#dialogs = [];
    return out;
  }

  url(): string {
    return this.pageUrl;
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  #fail(): void {
    const failure = this.failNext;
    this.failNext = undefined;
    if (failure !== undefined) throw failure;
  }

  async goto(url: string): Promise<{ status: number | null }> {
    this.actions.push(`goto ${url}`);
    this.#fail();
    this.navigate(url, url);
    return { status: 200 };
  }

  async history(delta: -1 | 1): Promise<{ status: number | null } | null> {
    this.actions.push(delta < 0 ? "back" : "forward");
    this.#fail();
    const entry = this.#history[this.#at + delta];
    if (entry === undefined) return null;
    this.#at += delta;
    this.#show(entry.url, entry.title);
    return { status: 200 };
  }

  async snapshot(options: { ref?: string; depth?: number }): Promise<string> {
    const failure = this.failSnapshot;
    this.failSnapshot = undefined;
    if (failure !== undefined) throw failure;
    this.snapshots.push({
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      ...(options.depth === undefined ? {} : { depth: options.depth }),
    });
    return this.snapshotText;
  }

  async inspect(ref: string): Promise<TargetState> {
    const target = this.targets.get(ref);
    if (target === undefined) {
      return { found: false, visible: false, enabled: false, editable: false, covered: false };
    }
    return {
      found: target.found ?? true,
      visible: target.visible ?? true,
      enabled: target.enabled ?? true,
      editable: target.editable ?? true,
      covered: target.covered ?? false,
    };
  }

  async click(ref: string, options: { button: string; double: boolean }): Promise<void> {
    this.actions.push(`click ${ref} ${options.button}${options.double ? " double" : ""}`);
    this.#fail();
    this.targets.get(ref)?.onClick?.(this);
  }

  async fill(ref: string, text: string): Promise<void> {
    this.actions.push(`fill ${ref} ${text}`);
    this.#fail();
    const target = this.targets.get(ref);
    if (target !== undefined) target.value = text;
  }

  async field(ref: string): Promise<FieldInfo> {
    this.actions.push(`field ${ref}`);
    const target = this.targets.get(ref);
    if (target === undefined || target.found === false) {
      return { found: false, field: "none", origin: null };
    }
    const origin = URL.canParse(this.pageUrl) ? new URL(this.pageUrl).origin : "null";
    return {
      found: true,
      field: target.field ?? "other",
      origin: target.origin === undefined ? (origin === "null" ? null : origin) : target.origin,
    };
  }

  async mark(ref: string): Promise<void> {
    this.actions.push(`mark ${ref}`);
    this.marks.push(ref);
  }

  async select(ref: string, values: readonly string[]): Promise<void> {
    this.actions.push(`select ${ref} ${values.join(",")}`);
    this.#fail();
  }

  async press(ref: string | undefined, key: string): Promise<void> {
    this.actions.push(`press ${ref ?? "page"} ${key}`);
    this.#fail();
  }

  async textVisible(text: string): Promise<boolean> {
    return [...this.visibleText].some((t) => t.includes(text));
  }

  async screenshot(options: { ref?: string; fullPage: boolean; quality: number }): Promise<Buffer> {
    const missing = this.marks.filter((ref) => {
      const target = this.targets.get(ref);
      return target === undefined || target.found === false;
    });
    if (missing.length > 0) {
      this.actions.push("screenshot refused");
      throw new DriverError("mask", `${missing.length} filled field is no longer on the page`);
    }
    this.actions.push(
      `screenshot${options.ref === undefined ? "" : ` ${options.ref}`} q${options.quality}${options.fullPage ? " full" : ""}${this.marks.length > 0 ? ` masks=${this.marks.join(",")}` : ""}`,
    );
    return fakeJpeg(this.screenshotBytes(options.quality, options.fullPage), 1280, 800);
  }

  async bringToFront(): Promise<void> {
    this.actions.push("front");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.driver.pages = this.driver.pages.filter((p) => p !== this);
  }
}

export class FakeDriver implements BrowserDriver {
  pages: FakeTab[] = [];
  /** Set to make every call fail as if CDP did not answer. */
  down: Error | undefined;
  closed = 0;

  constructor(tabs = 1) {
    for (let i = 0; i < tabs; i++) this.pages.push(new FakeTab(this));
  }

  get first(): FakeTab {
    return this.pages[0] as FakeTab;
  }

  async tabs(): Promise<readonly DriverTab[]> {
    if (this.down !== undefined) throw this.down;
    return [...this.pages];
  }

  async newTab(): Promise<DriverTab> {
    if (this.down !== undefined) throw this.down;
    const tab = new FakeTab(this);
    this.pages.push(tab);
    return tab;
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

/** A minimal JPEG (SOI, SOF0 with the size, padding) of exactly `bytes` bytes. */
export function fakeJpeg(bytes: number, width: number, height: number): Buffer {
  const head = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
  ]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))]);
}

export { DriverError };
