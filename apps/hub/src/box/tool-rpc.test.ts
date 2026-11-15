/**
 * The hub's tool RPC client (decision 0011): deadlines, reconnect on the same
 * boot, "outcome unknown" on a new boot, pi's error strings, and one round
 * trip through a real hub and an in-process box-agent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HearthError } from "@hearth/core";
import type { RpcFrame, RpcResultFrame } from "@hearth/protocol";
import { BoxAgent } from "../../../box-agent/src/connection";
import { ToolExecutor } from "../../../box-agent/src/tools/executor";
import { type Hub, startHub } from "../server";
import type { BoxConnectionListener } from "./connections";
import { ToolRpcClient } from "./tool-rpc";

const STEP_MS = 15_000;
const dirs: string[] = [];
const hubs: Hub[] = [];
const agents: BoxAgent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.stop();
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-toolrpc-"));
  dirs.push(dir);
  const root = join(dir, "workspace");
  mkdirSync(root);
  return root;
}

/**
 * Stands in for `BoxConnections`: a box with a real executor behind a link the
 * test can cut, drop answers on, and reconnect with the same or a new boot.
 */
class FakeBoxes {
  readonly listeners = new Set<BoxConnectionListener>();
  readonly sent: RpcFrame[] = [];
  connected = true;
  bootId = "boot_1";
  /** When true, answers are lost on the way back (a cut connection). */
  dropAnswers = false;
  executor: ToolExecutor;

  constructor(readonly root: string) {
    this.executor = this.#newExecutor();
  }

  #newExecutor(): ToolExecutor {
    return new ToolExecutor({
      root: this.root,
      send: (frame: RpcResultFrame) => {
        if (this.dropAnswers || !this.connected) return;
        for (const l of this.listeners) if (l.rpcResult?.("box_1", frame)) return;
      },
    });
  }

  listen(listener: BoxConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendRpc(_boxId: string, frame: RpcFrame): string | undefined {
    if (!this.connected) return undefined;
    this.sent.push(frame);
    queueMicrotask(() => this.executor.handle(frame));
    return this.bootId;
  }

  reconnect(newBoot: boolean): void {
    if (newBoot) {
      this.executor.abortAll();
      this.executor = this.#newExecutor();
      this.bootId = `boot_${Number(this.bootId.slice(5)) + 1}`;
    }
    this.connected = true;
    this.dropAnswers = false;
    for (const l of this.listeners) l.connected?.("box_1", this.bootId);
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("ToolRpcClient against a fake box", () => {
  test("pi-shaped operations round trip", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {} });
    const ops = client.operations("box_1", "call_a");
    await ops.write.mkdir(`${boxes.root}/d`);
    await ops.write.writeFile(`${boxes.root}/d/f.txt`, "hello");
    expect((await ops.read.readFile(`${boxes.root}/d/f.txt`)).toString()).toBe("hello");
    await ops.edit.access(`${boxes.root}/d/f.txt`);
    expect(await ops.ls.exists(`${boxes.root}/d/f.txt`)).toBe(true);
    expect((await ops.ls.stat(`${boxes.root}/d`)).isDirectory()).toBe(true);
    expect(await ops.ls.readdir(`${boxes.root}/d`)).toEqual(["f.txt"]);
    expect(await ops.find.glob("**/*.txt", boxes.root, { ignore: [], limit: 10 })).toEqual([
      "d/f.txt",
    ]);
    expect(await ops.grep.isDirectory(`${boxes.root}/d`)).toBe(true);
    const chunks: Buffer[] = [];
    const { exitCode } = await ops.bash.exec("cat d/f.txt; exit 4", boxes.root, {
      onData: (data) => chunks.push(data),
      timeout: 5,
      env: { HUB_SECRET: "never-sent" },
    });
    expect(exitCode).toBe(4);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    // Every call carries pi's tool call id, and no env crosses the wire.
    expect(boxes.sent.every((f) => (f.params as { callId: string }).callId === "call_a")).toBe(
      true,
    );
    expect(JSON.stringify(boxes.sent)).not.toContain("never-sent");
    expect(client.pending).toBe(0);
  });

  test("a command timeout rejects with pi's timeout:<seconds>", async () => {
    const boxes = new FakeBoxes(workspace());
    const ops = new ToolRpcClient({ boxes, log: () => {} }).operations("box_1", "call_t");
    const error = await rejection(
      ops.bash.exec("sleep 30", boxes.root, { onData: () => {}, timeout: 0.2 }),
    );
    expect(error.message).toBe("timeout:0.2");
  });

  test("an abort rejects with pi's aborted and cancels the command in the box", async () => {
    const boxes = new FakeBoxes(workspace());
    const ops = new ToolRpcClient({ boxes, log: () => {} }).operations("box_1", "call_x");
    const controller = new AbortController();
    const running = ops.bash.exec("sleep 30", boxes.root, {
      onData: () => {},
      signal: controller.signal,
      timeout: 60,
    });
    const until = Date.now() + STEP_MS;
    while (boxes.executor.running === 0 && Date.now() < until) await Bun.sleep(5);
    controller.abort();
    expect((await rejection(running)).message).toBe("aborted");
    expect(boxes.sent.at(-1)?.method).toBe("tool.cancel");
    while (boxes.executor.running > 0 && Date.now() < until) await Bun.sleep(5);
    expect(boxes.executor.running).toBe(0);
    // Aborted before the call: nothing is sent.
    const before = boxes.sent.length;
    expect(
      (
        await rejection(
          ops.bash.exec("true", boxes.root, { onData: () => {}, signal: AbortSignal.abort() }),
        )
      ).message,
    ).toBe("aborted");
    expect(boxes.sent.length).toBe(before);
  });

  test("a call the box never answers fails at its own deadline; a command is cancelled", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {}, deadlineMs: () => 150 });
    boxes.dropAnswers = true;
    const error = await rejection(
      client.call("box_1", "call_d", "tool.exec", {
        command: "sleep 30",
        cwd: ".",
        timeoutMs: 60_000,
      }),
    );
    expect(error).toBeInstanceOf(HearthError);
    expect(error).toMatchObject({ code: "tool.deadline", owner: "box", disposition: "give-up" });
    expect(error.message).toContain("outcome is unknown");
    expect(boxes.sent.at(-1)?.method).toBe("tool.cancel");
    const read = await rejection(client.call("box_1", "call_d", "tool.exists", { path: "." }));
    expect(read).toMatchObject({ code: "tool.deadline", disposition: "retry" });
    expect(client.pending).toBe(0);
  });

  test("the deadline follows the command's own timeout, not a global one", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {} });
    const started = Date.now();
    // The default deadline is timeout + grace: a 1.5 s command must not be cut.
    const result = await client.call("box_1", "call_s", "tool.exec", {
      command: "sleep 1.5; echo ok",
      cwd: ".",
      timeoutMs: 3_000,
    });
    expect(result.output).toBe("ok\n");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  });

  test("a reconnect on the same boot re-sends the call and gets its one answer", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {} });
    boxes.dropAnswers = true;
    const call = client.call("box_1", "call_r", "tool.exec", {
      command: "echo run >> runs.log; sleep 0.2; wc -l < runs.log",
      cwd: ".",
      timeoutMs: 5_000,
    });
    await Bun.sleep(400); // the answer was lost on the cut link
    boxes.connected = false;
    boxes.reconnect(false);
    const result = await call;
    expect(result.output.trim()).toBe("1");
    const ids = boxes.sent.map((f) => f.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1] ?? "");
  });

  test("a reconnect with a new boot fails the call as outcome unknown and never re-runs it", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {} });
    const write = client.call("box_1", "call_w", "tool.exec", {
      command: "sleep 30",
      cwd: ".",
      timeoutMs: 60_000,
    });
    boxes.dropAnswers = true;
    const file = client.call("box_1", "call_w", "tool.writeFile", { path: "w.txt", content: "x" });
    await Bun.sleep(50);
    boxes.connected = false;
    boxes.reconnect(true);
    for (const error of [await rejection(write), await rejection(file)]) {
      expect(error).toMatchObject({
        code: "tool.outcome-unknown",
        owner: "box",
        disposition: "give-up",
      });
      expect(error.message).toContain("boot_1 → boot_2");
    }
    expect(boxes.sent).toHaveLength(2);
    expect(client.pending).toBe(0);
  });

  test("a read-only call on a new boot is marked retryable", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {} });
    boxes.dropAnswers = true;
    const call = client.call("box_1", "call_e", "tool.exists", { path: "." });
    await Bun.sleep(20);
    boxes.reconnect(true);
    expect(await rejection(call)).toMatchObject({
      code: "tool.outcome-unknown",
      disposition: "retry",
    });
  });

  test("a box error keeps the box's code and its classification", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {} });
    const error = await rejection(
      client.call("box_1", "call_p", "tool.readFile", { path: "../etc/passwd" }),
    );
    expect(error).toMatchObject({
      code: "tool.path-escape",
      owner: "user",
      disposition: "give-up",
    });
  });

  test("no connection: nothing is sent and the call may be retried", async () => {
    const boxes = new FakeBoxes(workspace());
    boxes.connected = false;
    const client = new ToolRpcClient({ boxes, log: () => {} });
    const error = await rejection(
      client.call("box_1", "call_n", "tool.writeFile", { path: "a", content: "" }),
    );
    expect(error).toMatchObject({ code: "box.not-connected", disposition: "retry" });
    expect(boxes.sent).toHaveLength(0);
  });
});

describe("ToolRpcClient through a real hub and box-agent", () => {
  test("write, read and exec in the box workspace over the box socket", async () => {
    const root = workspace();
    const dir = mkdtempSync(join(tmpdir(), "hearth-toolrpc-hub-"));
    dirs.push(dir);
    const hub = startHub({ dbPath: join(dir, "hub.db"), port: 0, boxPort: 0, log: () => {} });
    hubs.push(hub);
    const { token } = await hub.issueJoinToken("box_tools", "ses_tools");
    const agent = new BoxAgent({
      hubUrl: hub.listenForBoxes("127.0.0.1"),
      boxId: "box_tools",
      joinToken: token,
      log: () => {},
      tools: { root },
    });
    agents.push(agent);
    agent.start();
    await hub.boxes.waitForBox("box_tools", STEP_MS);
    const client = new ToolRpcClient({ boxes: hub.boxes, log: () => {} });
    const ops = client.operations("box_tools", "call_e2e");
    await ops.write.mkdir("notes");
    await ops.write.writeFile("notes/hello.txt", "from the hub");
    expect((await ops.read.readFile("notes/hello.txt")).toString()).toBe("from the hub");
    const chunks: Buffer[] = [];
    const { exitCode } = await ops.bash.exec("pwd; cat notes/hello.txt", root, {
      onData: (data) => chunks.push(data),
      timeout: 10,
    });
    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe(`${root}\nfrom the hub`);
    client.close();
  }, 30_000);
});
