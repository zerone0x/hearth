/**
 * The box's tool executor against a temporary workspace (decision 0011):
 * confinement, caps, timeouts, cancel, environment isolation, binary files,
 * concurrency and at-most-once per boot.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JsonValue,
  MAX_TOOL_FILE_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  type RpcResultFrame,
  type ToolMethod,
  type ToolResults,
} from "@hearth/protocol";
import { ToolCallError } from "./errors";
import { DEFAULT_EXEC_ENV, ToolExecutor, type ToolExecutorOptions } from "./executor";
import { Workspace } from "./paths";

const STEP_MS = 10_000;
const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `pid` is gone; zombies are reaped by init once the group is killed. */
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

interface Harness {
  readonly root: string;
  readonly outside: string;
  readonly executor: ToolExecutor;
  readonly frames: RpcResultFrame[];
  send(method: string, params: JsonValue, id?: string): Promise<RpcResultFrame>;
  ok<M extends ToolMethod>(method: M, params: JsonValue, id?: string): Promise<ToolResults[M]>;
  fail(method: ToolMethod, params: JsonValue): Promise<{ code: string; message: string }>;
}

let counter = 0;

function harness(options: Partial<ToolExecutorOptions> = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), "hearth-tools-"));
  dirs.push(base);
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  const frames: RpcResultFrame[] = [];
  const waiters = new Map<string, (frame: RpcResultFrame) => void>();
  const executor = new ToolExecutor({
    root,
    rg: Bun.which("rg") ?? "rg",
    ...options,
    send: (frame) => {
      frames.push(frame);
      const wake = waiters.get(frame.id);
      waiters.delete(frame.id);
      wake?.(frame);
    },
  });
  const send = (method: string, params: JsonValue, id = `rpc_${++counter}`) =>
    new Promise<RpcResultFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), STEP_MS);
      waiters.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      executor.handle({ type: "rpc", id, method, params });
    });
  return {
    root,
    outside,
    executor,
    frames,
    send,
    async ok(method, params, id) {
      const frame = await send(method, params, id);
      if (!frame.ok)
        throw new Error(`${method} failed: ${frame.error.code}: ${frame.error.message}`);
      return frame.result as never;
    },
    async fail(method, params) {
      const frame = await send(method, params);
      if (frame.ok) throw new Error(`${method} succeeded: ${JSON.stringify(frame.result)}`);
      return frame.error;
    },
  };
}

const c = { callId: "call_1" };

describe("path confinement", () => {
  test("refuses .., absolute paths outside the workspace and symlink escapes", async () => {
    const h = harness();
    symlinkSync(h.outside, join(h.root, "link"));
    symlinkSync(join(h.outside, "new.txt"), join(h.root, "dangling"));
    const attempts: [ToolMethod, Record<string, JsonValue>][] = [
      ["tool.readFile", { path: "../outside/secret.txt" }],
      ["tool.readFile", { path: "a/../../outside/secret.txt" }],
      ["tool.readFile", { path: "sub/.." }],
      ["tool.readFile", { path: join(h.outside, "secret.txt") }],
      ["tool.readFile", { path: "/etc/passwd" }],
      ["tool.readFile", { path: "link/secret.txt" }],
      ["tool.readdir", { path: "link" }],
      ["tool.stat", { path: "link" }],
      ["tool.exists", { path: "link/secret.txt" }],
      ["tool.access", { path: "link/secret.txt", write: false }],
      ["tool.writeFile", { path: "link/new.txt", content: "x" }],
      ["tool.writeFile", { path: "dangling", content: "x" }],
      ["tool.writeFile", { path: `${h.root}x/escape.txt`, content: "x" }],
      ["tool.mkdir", { path: "link/newdir" }],
      ["tool.imageMimeType", { path: "link/secret.txt" }],
      ["tool.exec", { command: "pwd", cwd: "link", timeoutMs: 5_000 }],
      ["tool.exec", { command: "pwd", cwd: "/tmp", timeoutMs: 5_000 }],
      ["tool.glob", { pattern: "../outside/*", cwd: ".", ignore: [], limit: 10 }],
      ["tool.glob", { pattern: "*", cwd: "link", ignore: [], limit: 10 }],
    ];
    for (const [method, params] of attempts) {
      const error = await h.fail(method, { ...c, ...params });
      expect({ method, params, code: error.code }).toEqual({
        method,
        params,
        code: "tool.path-escape",
      });
    }
    expect(existsSync(join(h.outside, "new.txt"))).toBe(false);
    expect(existsSync(`${h.root}x`)).toBe(false);
  });

  test("the lexical check alone refuses paths outside the root, before any file system access", () => {
    const ws = new Workspace("/workspace");
    for (const path of ["/etc/passwd", "/workspacex/a", "/", "../a", "a/../b", "x\u0000"]) {
      expect(() => ws.lexical(path)).toThrow(ToolCallError);
    }
    expect(ws.lexical("a/b/")).toBe("/workspace/a/b");
    expect(ws.lexical("/workspace/a")).toBe("/workspace/a");
    expect(ws.lexical("~/a")).toBe("/workspace/~/a");
  });

  test("an absolute path inside the workspace and a symlink inside it are fine", async () => {
    const h = harness();
    writeFileSync(join(h.root, "a.txt"), "inside");
    symlinkSync(join(h.root, "a.txt"), join(h.root, "alias.txt"));
    const read = await h.ok("tool.readFile", { ...c, path: join(h.root, "a.txt") });
    expect(Buffer.from(read.data, "base64").toString()).toBe("inside");
    const alias = await h.ok("tool.readFile", { ...c, path: "alias.txt" });
    expect(Buffer.from(alias.data, "base64").toString()).toBe("inside");
  });

  test("a glob does not follow a symlink out of the workspace", async () => {
    const h = harness();
    symlinkSync(h.outside, join(h.root, "link"));
    writeFileSync(join(h.root, "mine.txt"), "x");
    const found = await h.ok("tool.glob", {
      ...c,
      pattern: "**/*.txt",
      cwd: ".",
      ignore: [],
      limit: 100,
    });
    expect(found.paths).toEqual(["mine.txt"]);
  });
});

describe("files", () => {
  test("write, read, stat, exists, readdir, mkdir", async () => {
    const h = harness();
    await h.ok("tool.mkdir", { ...c, path: "src/deep" });
    expect(await h.ok("tool.writeFile", { ...c, path: "src/deep/a.ts", content: "héllo" })).toEqual(
      {
        bytes: 6,
      },
    );
    const read = await h.ok("tool.readFile", { ...c, path: "src/deep/a.ts" });
    expect(Buffer.from(read.data, "base64").toString("utf8")).toBe("héllo");
    expect(await h.ok("tool.stat", { ...c, path: "src" })).toEqual({
      isDirectory: true,
      isFile: false,
      size: expect.any(Number),
    });
    expect(await h.ok("tool.exists", { ...c, path: "src/deep/a.ts" })).toEqual({ exists: true });
    expect(await h.ok("tool.exists", { ...c, path: "nope" })).toEqual({ exists: false });
    expect(await h.ok("tool.readdir", { ...c, path: "src/deep" })).toEqual({
      entries: ["a.ts"],
      omitted: 0,
    });
    await h.ok("tool.access", { ...c, path: "src/deep/a.ts", write: true });
    expect((await h.fail("tool.readFile", { ...c, path: "missing.txt" })).code).toBe(
      "tool.not-found",
    );
    expect((await h.fail("tool.readFile", { ...c, path: "src" })).code).toBe("tool.is-a-directory");
  });

  test("binary files come back byte for byte, and images are detected", async () => {
    const h = harness();
    const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
    writeFileSync(join(h.root, "blob.bin"), bytes);
    const read = await h.ok("tool.readFile", { ...c, path: "blob.bin" });
    expect(Buffer.from(read.data, "base64").equals(bytes)).toBe(true);
    expect(read.size).toBe(512);
    writeFileSync(join(h.root, "x.png"), Buffer.from("89504e470d0a1a0a0000", "hex"));
    expect(await h.ok("tool.imageMimeType", { ...c, path: "x.png" })).toEqual({
      mimeType: "image/png",
    });
    expect(await h.ok("tool.imageMimeType", { ...c, path: "blob.bin" })).toEqual({
      mimeType: null,
    });
  });

  test("reads and writes over the size cap are refused", async () => {
    const h = harness();
    writeFileSync(join(h.root, "big"), Buffer.alloc(MAX_TOOL_FILE_BYTES + 1));
    expect((await h.fail("tool.readFile", { ...c, path: "big" })).code).toBe("tool.too-large");
    writeFileSync(join(h.root, "edge"), Buffer.alloc(MAX_TOOL_FILE_BYTES));
    expect((await h.ok("tool.readFile", { ...c, path: "edge" })).size).toBe(MAX_TOOL_FILE_BYTES);
    // Under the character cap of the decoder, over the byte cap: é is two bytes.
    const content = "é".repeat(MAX_TOOL_FILE_BYTES / 2 + 1);
    expect((await h.fail("tool.writeFile", { ...c, path: "w", content })).code).toBe(
      "tool.too-large",
    );
    expect(existsSync(join(h.root, "w"))).toBe(false);
  });

  test("bad params are refused before anything runs", async () => {
    const h = harness();
    expect((await h.fail("tool.readFile", { path: "a" })).code).toBe("tool.bad-params");
    expect(
      (await h.fail("tool.exec", { ...c, command: "true", cwd: ".", timeoutMs: 0 })).code,
    ).toBe("tool.bad-params");
  });
});

describe("exec", () => {
  test("runs in the workspace with the box environment only", async () => {
    process.env["HEARTH_JOIN_TOKEN"] = "hj_secret_should_not_leak";
    try {
      const h = harness({ env: { ...DEFAULT_EXEC_ENV, HOME: "/home/box" } });
      mkdirSync(join(h.root, "sub"));
      const result = await h.ok("tool.exec", {
        ...c,
        command: "pwd; env",
        cwd: "sub",
        timeoutMs: 5_000,
        // pi hands the hub's environment to exec; the protocol has no field for it.
        env: { LEAK: "from-the-hub" },
      });
      expect(result.outcome).toBe("exited");
      expect(result.exitCode).toBe(0);
      const lines = result.output.trim().split("\n");
      expect(lines[0]).toBe(join(h.root, "sub"));
      const vars = lines.slice(1).map((line) => line.split("=")[0]);
      expect(result.output).not.toContain("hj_secret_should_not_leak");
      expect(result.output).not.toContain("from-the-hub");
      expect(result.output).toContain("HOME=/home/box");
      expect(
        vars.filter(
          (v) => !["PATH", "HOME", "LANG", "TERM", "PWD", "SHLVL", "_"].includes(v ?? ""),
        ),
      ).toEqual([]);
    } finally {
      delete process.env["HEARTH_JOIN_TOKEN"];
    }
  });

  test("reports exit codes, and 128 + signal for a signal", async () => {
    const h = harness();
    expect(
      (await h.ok("tool.exec", { ...c, command: "exit 3", cwd: ".", timeoutMs: 5_000 })).exitCode,
    ).toBe(3);
    const killed = await h.ok("tool.exec", {
      ...c,
      command: "kill -TERM $$",
      cwd: ".",
      timeoutMs: 5_000,
    });
    expect(killed).toMatchObject({ outcome: "exited", exitCode: 128 + 15 });
  });

  test("huge output keeps the tail, marks the cut and spills the whole output into the box", async () => {
    const h = harness();
    const total = MAX_TOOL_OUTPUT_BYTES * 3;
    const result = await h.ok("tool.exec", {
      ...c,
      command: `head -c ${total - 3} /dev/zero | tr '\\0' a; printf END`,
      cwd: ".",
      timeoutMs: 10_000,
    });
    expect(result.truncatedBytes).toBe(total - MAX_TOOL_OUTPUT_BYTES);
    expect(result.output.startsWith("[hearth: ")).toBe(true);
    expect(result.output).toContain(
      `${total - MAX_TOOL_OUTPUT_BYTES} bytes of earlier output omitted`,
    );
    expect(result.output.endsWith("aEND")).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES + 200);
    expect(result.fullOutputPath).not.toBeNull();
    expect(result.fullOutputPath?.startsWith(`${h.root}/.hearth/exec/`)).toBe(true);
    expect(statSync(result.fullOutputPath ?? "").size).toBe(total);
    expect(readFileSync(result.fullOutputPath ?? "", "latin1").endsWith("aEND")).toBe(true);
    // The model can read the spill file back through the tools.
    expect((await h.ok("tool.stat", { ...c, path: result.fullOutputPath })).size).toBe(total);
  });

  test("small output is not marked and not spilled", async () => {
    const h = harness();
    const result = await h.ok("tool.exec", {
      ...c,
      command: "echo hi; echo err >&2",
      cwd: ".",
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      outcome: "exited",
      exitCode: 0,
      output: "hi\nerr\n",
      truncatedBytes: 0,
      fullOutputPath: null,
    });
    expect(existsSync(join(h.root, ".hearth"))).toBe(false);
  });

  test("the timeout kills the whole process group, also children that ignore SIGTERM", async () => {
    const h = harness();
    const started = Date.now();
    const result = await h.ok("tool.exec", {
      ...c,
      command: "(trap '' TERM; sleep 30) & echo $! > child.pid; trap '' TERM; sleep 30",
      cwd: ".",
      timeoutMs: 300,
    });
    expect(result.outcome).toBe("timed-out");
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(readFileSync(join(h.root, "child.pid"), "utf8"));
    pids.push(pid);
    expect(await gone(pid)).toBe(true);
  });

  test("a cancel mid-exec kills the group and answers cancelled", async () => {
    const h = harness();
    const running = h.send(
      "tool.exec",
      { ...c, command: "sleep 30 & echo $! > child.pid; wait", cwd: ".", timeoutMs: 60_000 },
      "rpc_exec_cancel",
    );
    const until = Date.now() + STEP_MS;
    while (!existsSync(join(h.root, "child.pid")) && Date.now() < until) await Bun.sleep(10);
    expect(await h.ok("tool.cancel", { ...c, target: "rpc_exec_cancel" })).toEqual({ found: true });
    const frame = await running;
    expect(frame.ok && frame.result).toMatchObject({ outcome: "cancelled", exitCode: null });
    const pid = Number(readFileSync(join(h.root, "child.pid"), "utf8"));
    pids.push(pid);
    expect(await gone(pid)).toBe(true);
    expect(await h.ok("tool.cancel", { ...c, target: "rpc_exec_cancel" })).toEqual({
      found: false,
    });
  });

  test("a background child holding the output pipe does not keep the call open", async () => {
    const h = harness();
    const started = Date.now();
    const result = await h.ok("tool.exec", {
      ...c,
      command: "sleep 30 & echo $! > child.pid; echo started",
      cwd: ".",
      timeoutMs: 20_000,
    });
    pids.push(Number(readFileSync(join(h.root, "child.pid"), "utf8")));
    expect(result).toMatchObject({ outcome: "exited", exitCode: 0, output: "started\n" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("calls", () => {
  test("sibling calls run concurrently", async () => {
    const h = harness();
    const started = Date.now();
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        h.ok("tool.exec", { ...c, command: `sleep 0.4; echo ${n}`, cwd: ".", timeoutMs: 5_000 }),
      ),
    );
    expect(results.map((r) => r.output)).toEqual(["1\n", "2\n", "3\n", "4\n"]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("past the concurrency cap a call is refused as busy and may be re-sent", async () => {
    const h = harness({ maxConcurrent: 1 });
    const slow = h.ok("tool.exec", { ...c, command: "sleep 0.3", cwd: ".", timeoutMs: 5_000 });
    const busy = await h.send("tool.exists", { ...c, path: "." }, "rpc_busy");
    expect(!busy.ok && busy.error.code).toBe("tool.busy");
    await slow;
    expect(await h.ok("tool.exists", { ...c, path: "." }, "rpc_busy")).toEqual({ exists: true });
  });

  test("an rpc id runs at most once per boot; a re-send gets the same answer", async () => {
    const h = harness();
    const params = {
      ...c,
      command: "echo run >> runs.log; cat runs.log | wc -l",
      cwd: ".",
      timeoutMs: 5_000,
    };
    const first = h.send("tool.exec", params, "rpc_once");
    // A re-send while it runs is answered once, when it ends.
    h.executor.handle({ type: "rpc", id: "rpc_once", method: "tool.exec", params });
    const answer = await first;
    const again = await h.send("tool.exec", params, "rpc_once");
    expect(again).toEqual(answer);
    expect(readFileSync(join(h.root, "runs.log"), "utf8")).toBe("run\n");
    expect(h.frames.filter((f) => f.id === "rpc_once")).toHaveLength(2);
  });

  test("an id whose answer was evicted is never run again", async () => {
    const h = harness({ resultCacheBytes: 1 });
    const params = { ...c, command: "echo run >> runs.log", cwd: ".", timeoutMs: 5_000 };
    await h.ok("tool.exec", params, "rpc_old");
    await h.ok("tool.exists", { ...c, path: "." });
    const replay = await h.send("tool.exec", params, "rpc_old");
    expect(!replay.ok && replay.error.code).toBe("tool.result-expired");
    expect(readFileSync(join(h.root, "runs.log"), "utf8")).toBe("run\n");
  });
});

describe("search", () => {
  test("glob honours ignore and limit", async () => {
    const h = harness();
    mkdirSync(join(h.root, "a/node_modules"), { recursive: true });
    for (const name of ["a/1.ts", "a/2.ts", "a/3.ts", "a/node_modules/x.ts"])
      writeFileSync(join(h.root, name), "");
    const all = await h.ok("tool.glob", {
      ...c,
      pattern: "**/*.ts",
      cwd: ".",
      ignore: ["**/node_modules/**"],
      limit: 100,
    });
    expect([...all.paths].sort()).toEqual(["a/1.ts", "a/2.ts", "a/3.ts"]);
    const some = await h.ok("tool.glob", {
      ...c,
      pattern: "**/*.ts",
      cwd: "a",
      ignore: [],
      limit: 2,
    });
    expect(some.paths).toHaveLength(2);
    expect(some.limitReached).toBe(true);
  });

  test.skipIf(Bun.which("rg") === null)(
    "grep runs rg in the workspace and caps matches",
    async () => {
      const h = harness();
      writeFileSync(join(h.root, "a.txt"), "alpha\nbeta\nAlpha again\n");
      writeFileSync(join(h.root, "b.txt"), "nothing\n");
      const found = await h.ok("tool.grep", {
        ...c,
        pattern: "alpha",
        path: ".",
        ignoreCase: true,
        literal: false,
        context: 0,
        limit: 10,
      });
      expect(found.matches).toBe(2);
      expect(found.output).toContain("a.txt:1:alpha");
      expect(found.output).toContain("a.txt:3:Alpha again");
      const capped = await h.ok("tool.grep", {
        ...c,
        pattern: "a",
        path: ".",
        ignoreCase: false,
        literal: true,
        context: 0,
        limit: 1,
      });
      expect(capped.matches).toBe(1);
      expect(capped.limitReached).toBe(true);
      expect(
        (
          await h.fail("tool.grep", {
            ...c,
            pattern: "x",
            path: "../",
            ignoreCase: false,
            literal: false,
            context: 0,
            limit: 1,
          })
        ).code,
      ).toBe("tool.path-escape");
    },
  );
});
