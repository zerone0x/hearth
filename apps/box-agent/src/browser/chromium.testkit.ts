/**
 * A real Chromium (or chrome-headless-shell) with CDP on loopback and its own
 * profile, started the way the box entrypoint starts it (decision 0026), for
 * the tests that run when `HEARTH_CHROMIUM` names a binary.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const chromiumPath = process.env["HEARTH_CHROMIUM"] ?? "";

export class TestChromium {
  readonly port = 19_000 + Math.floor(Math.random() * 5000);
  readonly profile = mkdtempSync(join(tmpdir(), "hearth-browser-"));
  #child: ChildProcess | undefined;

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.#child = spawn(
      chromiumPath,
      [
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profile}`,
        "--window-size=1280,800",
        "about:blank",
      ],
      { detached: true, stdio: "ignore" },
    );
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      try {
        if ((await fetch(`${this.endpoint}/json/version`)).ok) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error("CDP did not come up");
  }

  /** SIGKILLs the browser's process group (only the one this started) and waits for it. */
  async kill(): Promise<void> {
    const child = this.#child;
    if (child?.pid === undefined) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await exited;
    this.#child = undefined;
  }

  async stop(): Promise<void> {
    await this.kill();
    rmSync(this.profile, { recursive: true, force: true });
  }
}
