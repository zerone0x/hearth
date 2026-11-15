/**
 * box-agent's start-up hardening (#57, decision 0018): the join token taken
 * from a file that is then deleted, and the process made non-dumpable so a
 * same-uid command cannot read its environment or memory through /proc.
 *
 * The /proc tests start real processes and read their /proc files as the same
 * uid, which is what a tool command in a box can do. The image-level proof
 * (entrypoint, tini, Xvnc) is `apps/hub/src/box/proc-secrets.docker.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { JOIN_TOKEN_FILE_VAR, JOIN_TOKEN_VAR, takeJoinToken } from "./boot";

const TOKEN = "hjt_test-join-token-0123456789";
const linux = process.platform === "linux";

const dirs: string[] = [];
const children: Subprocess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-boot-"));
  dirs.push(dir);
  return dir;
}

/** What a same-uid process gets when it reads `/proc/<pid>/<name>`. */
function readProc(
  pid: number,
  name: string,
): { ok: true; text: string } | { ok: false; code: string } {
  try {
    return { ok: true, text: readFileSync(`/proc/${pid}/${name}`).toString("latin1") };
  } catch (error) {
    return { ok: false, code: String((error as NodeJS.ErrnoException).code) };
  }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

describe("takeJoinToken", () => {
  test("reads the token file, deletes it and scrubs both variables", async () => {
    const file = join(tempDir(), "join-token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    const env: Record<string, string | undefined> = {
      [JOIN_TOKEN_FILE_VAR]: file,
      [JOIN_TOKEN_VAR]: "hjt_stale",
      OTHER: "kept",
    };
    expect(await takeJoinToken({ env })).toBe(TOKEN);
    expect(existsSync(file)).toBe(false);
    expect(env).toEqual({ OTHER: "kept" });
  });

  test("falls back to the environment outside the image and scrubs it", async () => {
    const env: Record<string, string | undefined> = { [JOIN_TOKEN_VAR]: TOKEN };
    expect(await takeJoinToken({ env })).toBe(TOKEN);
    expect(env).toEqual({});
  });

  test("a missing token file is an error, and the variables are still scrubbed", async () => {
    const env: Record<string, string | undefined> = {
      [JOIN_TOKEN_FILE_VAR]: join(tempDir(), "missing"),
      [JOIN_TOKEN_VAR]: TOKEN,
    };
    await expect(takeJoinToken({ env })).rejects.toMatchObject({ code: "secret.not-found" });
    expect(env).toEqual({});
  });

  test("an empty token file is an error and is deleted", async () => {
    const file = join(tempDir(), "join-token");
    writeFileSync(file, "");
    const env: Record<string, string | undefined> = { [JOIN_TOKEN_FILE_VAR]: file };
    await expect(takeJoinToken({ env })).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

describe.skipIf(!linux)("a same-uid process reading box-agent through /proc", () => {
  const MAIN = join(import.meta.dir, "main.ts");

  /**
   * Runs the real box-agent entry point against a hub that is not there, so it
   * keeps redialing, with the token in a file (as the image does) and a
   * marker variable in its start-up environment.
   */
  async function startAgent(): Promise<{ child: Subprocess; file: string }> {
    const file = join(tempDir(), "join-token");
    writeFileSync(file, TOKEN, { mode: 0o600 });
    const child = spawn(["bun", MAIN], {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: tempDir(),
        HEARTH_HUB_URL: "ws://127.0.0.1:9/box",
        HEARTH_BOX_ID: "box_boot_test",
        HEARTH_WORKSPACE: tempDir(),
        [JOIN_TOKEN_FILE_VAR]: file,
        HEARTH_BOOT_TEST_MARKER: "start-up-secret",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    // The file goes once box-agent has read the token, after the dumpable flag is cleared.
    await until(() => !existsSync(file) || child.exitCode !== null);
    if (child.exitCode !== null) {
      throw new Error(
        `box-agent exited ${child.exitCode}: ${await new Response(child.stderr).text()}`,
      );
    }
    return { child, file };
  }

  test("box-agent deletes the token file and its environ, maps and mem are refused", async () => {
    const { child, file } = await startAgent();
    expect(existsSync(file)).toBe(false);
    for (const name of ["environ", "maps", "mem"]) {
      expect(readProc(child.pid, name)).toEqual({ ok: false, code: "EACCES" });
    }
    // Not a dead process: its status is still there to read.
    expect(readProc(child.pid, "status")).toMatchObject({ ok: true });
  }, 30_000);

  test("control: a plain same-uid Bun process's environ is readable", async () => {
    const child = spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HEARTH_BOOT_TEST_MARKER: "visible" },
    });
    children.push(child);
    await until(() => {
      const read = readProc(child.pid, "environ");
      return read.ok && read.text.includes("HEARTH_BOOT_TEST_MARKER=visible");
    });
  }, 30_000);

  test("commands box-agent starts are dumpable again, so the run-marker sweep still sees them", async () => {
    const script = [
      `import { makeNonDumpable } from ${JSON.stringify(join(import.meta.dir, "boot.ts"))};`,
      "await makeNonDumpable();",
      `const sh = Bun.spawn(["sh", "-c", "cat /proc/$$/environ >/dev/null && echo readable"], { env: { PATH: process.env.PATH, X: "1" } });`,
      "process.stdout.write(await new Response(sh.stdout).text());",
    ].join("\n");
    const path = join(tempDir(), "probe.ts");
    writeFileSync(path, script);
    const run = Bun.spawnSync(["bun", path], { env: { PATH: process.env["PATH"] ?? "" } });
    expect(run.stdout.toString()).toBe("readable\n");
  }, 30_000);
});
