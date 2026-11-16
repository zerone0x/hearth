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
import type { RpcFrame, RpcResultFrame, StreamCloseFrame } from "@hearth/protocol";
import { FakeDriver } from "../../../box-agent/src/browser/fake";
import { BrowserTools } from "../../../box-agent/src/browser/tools";
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
  /** Stream frames the hub sent the box (`sendStream`). */
  readonly streamFrames: Array<{ boxId: string; frame: StreamCloseFrame | { type: string } }> = [];
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

  sendStream(boxId: string, frame: StreamCloseFrame | { type: string }): boolean {
    this.streamFrames.push({ boxId, frame });
    return this.connected;
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
  test("a connection declared dead fails its calls with tool.outcome-unknown at once (decision 0028)", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {} });
    boxes.dropAnswers = true;
    const exec = client.call("box_1", "call_d", "tool.exec", {
      command: "sleep 30",
      cwd: boxes.root,
      timeoutMs: 60_000,
    });
    const read = client.call("box_1", "call_d", "tool.exists", { path: boxes.root });
    expect(client.pending).toBe(2);
    // Another boot's death does not touch these calls.
    for (const l of boxes.listeners) l.dead?.("box_1", "boot_other", { misses: 3, intervalMs: 1 });
    // Neither does another box's.
    for (const l of boxes.listeners) l.dead?.("box_2", "boot_1", { misses: 3, intervalMs: 1 });
    expect(client.pending).toBe(2);
    for (const l of boxes.listeners) l.dead?.("box_1", "boot_1", { misses: 3, intervalMs: 1_000 });
    const execError = (await rejection(exec)) as HearthError;
    const readError = (await rejection(read)) as HearthError;
    expect(execError.code).toBe("tool.outcome-unknown");
    expect(execError.disposition).toBe("give-up");
    expect(execError.message).toContain("no frame for 3000 ms");
    expect(readError.code).toBe("tool.outcome-unknown");
    expect(readError.disposition).toBe("retry");
    expect(client.pending).toBe(0);
    // Not re-sent when the box comes back on the same boot.
    const sent = boxes.sent.length;
    boxes.reconnect(false);
    expect(boxes.sent.length).toBe(sent);
    boxes.executor.abortAll();
  });

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

describe("live exec output through a real hub and box-agent (protocol 1.4)", () => {
  test("a sleep+echo command's first line reaches onOutput before the call ends", async () => {
    const root = workspace();
    const dir = mkdtempSync(join(tmpdir(), "hearth-toolrpc-live-"));
    dirs.push(dir);
    const hub = startHub({ dbPath: join(dir, "hub.db"), port: 0, boxPort: 0, log: () => {} });
    hubs.push(hub);
    const { token } = await hub.issueJoinToken("box_live", "ses_live");
    const agent = new BoxAgent({
      hubUrl: hub.listenForBoxes("127.0.0.1"),
      boxId: "box_live",
      joinToken: token,
      log: () => {},
      tools: { root },
    });
    agents.push(agent);
    agent.start();
    await hub.boxes.waitForBox("box_live", STEP_MS);
    const client = new ToolRpcClient({ boxes: hub.boxes, log: () => {} });
    const ops = client.operations("box_live", "call_live");
    const live: string[] = [];
    const final: Buffer[] = [];
    let ended = false;
    let firstBeforeEnd: boolean | undefined;
    const run = ops.bash
      .exec("echo first; sleep 1; echo second", root, {
        onData: (data) => final.push(data),
        timeout: 10,
        onOutput: (chunk) => {
          live.push(Buffer.from(chunk).toString("utf8"));
          firstBeforeEnd ??= !ended;
        },
      })
      .finally(() => {
        ended = true;
      });
    expect(client.liveStreams).toBe(1);
    const { exitCode } = await run;
    expect(exitCode).toBe(0);
    expect(firstBeforeEnd).toBe(true);
    expect(live.join("")).toBe("first\nsecond\n");
    // The result is still the whole answer, through onData once.
    expect(final.map(String)).toEqual(["first\nsecond\n"]);
    expect(client.liveStreams).toBe(0);
    // The next exec gets a new stream id the box takes too (even, in range).
    const again: string[] = [];
    const second = await ops.bash.exec("echo again", root, {
      onData: () => {},
      timeout: 10,
      onOutput: (chunk) => {
        again.push(Buffer.from(chunk).toString("utf8"));
        return true;
      },
    });
    expect(second.exitCode).toBe(0);
    expect(again.join("")).toBe("again\n");
    // A consumer that stops listening closes the stream: the box sends no more.
    const capped: string[] = [];
    const final3: Buffer[] = [];
    const third = await ops.bash.exec("echo one; sleep 0.5; echo two", root, {
      onData: (data) => final3.push(data),
      timeout: 10,
      onOutput: (chunk) => {
        capped.push(Buffer.from(chunk).toString("utf8"));
        return false;
      },
    });
    expect(third.exitCode).toBe(0);
    expect(capped).toEqual(["one\n"]);
    expect(final3.map(String)).toEqual(["one\ntwo\n"]);
    expect(client.liveStreams).toBe(0);
    client.close();
  }, 30_000);
});

describe("live exec output: stream routing", () => {
  test("only the call's own stream on its own box reaches onOutput, and only while it runs", async () => {
    const boxes = new FakeBoxes(workspace());
    const client = new ToolRpcClient({ boxes, log: () => {} });
    const got: string[] = [];
    const run = client.operations("box_1", "call_r").bash.exec("sleep 0.2", ".", {
      onData: () => {},
      onOutput: (chunk) => {
        got.push(Buffer.from(chunk).toString());
        return true;
      },
    });
    const sent = boxes.sent[0]?.params as { outputStream?: number };
    const id = sent.outputStream as number;
    expect(id).toBeGreaterThanOrEqual(2 ** 31);
    expect(id % 2).toBe(0);
    const data = (streamId: number, text: string) => ({
      type: "stream.data" as const,
      streamId,
      seq: 0,
      data: new TextEncoder().encode(text),
    });
    const claim = (boxId: string, frame: ReturnType<typeof data>) =>
      [...boxes.listeners].some((l) => l.stream?.(boxId, frame) === true);
    expect(claim("box_1", data(id, "mine"))).toBe(true);
    expect(claim("box_2", data(id, "other box"))).toBe(false);
    expect(claim("box_1", data(id + 2, "other stream"))).toBe(false);
    await run;
    expect(claim("box_1", data(id, "late"))).toBe(false);
    expect(got).toEqual(["mine"]);
    // The box's stream.close ends the routing at once, before the result.
    const run2 = client.operations("box_1", "call_c").bash.exec("sleep 0.2", ".", {
      onData: () => {},
      onOutput: (chunk) => {
        got.push(Buffer.from(chunk).toString());
        return true;
      },
    });
    const id2 = (boxes.sent.at(-1)?.params as { outputStream: number } | undefined)
      ?.outputStream as number;
    expect(id2).not.toBe(id);
    expect(id2 % 2).toBe(0);
    expect(client.liveStreams).toBe(1);
    const close = { type: "stream.close" as const, streamId: id2, reason: "done" as const };
    expect([...boxes.listeners].some((l) => l.stream?.("box_1", close) === true)).toBe(true);
    expect(client.liveStreams).toBe(0);
    expect(claim("box_1", data(id2, "after close"))).toBe(false);
    await run2;
    expect(got).toEqual(["mine"]);
    expect(boxes.streamFrames).toEqual([]);
    // Without onOutput no stream is asked for.
    await client.operations("box_1", "call_s").bash.exec("true", ".", { onData: () => {} });
    expect(
      (boxes.sent.at(-1)?.params as { outputStream?: number } | undefined)?.outputStream,
    ).toBeUndefined();
    client.close();
  });
});

describe("live exec output: the consumer stops listening", () => {
  test("onOutput returning false closes the stream on the box; the call goes on", async () => {
    const boxes = new FakeBoxes(workspace());
    const logs: string[] = [];
    const client = new ToolRpcClient({ boxes, log: (line) => logs.push(line) });
    const got: string[] = [];
    const run = client.operations("box_1", "call_k").bash.exec("sleep 0.2; echo done", ".", {
      onData: () => {},
      onOutput: (chunk) => {
        got.push(Buffer.from(chunk).toString());
        return got.length < 2;
      },
    });
    const id = (boxes.sent[0]?.params as { outputStream: number } | undefined)
      ?.outputStream as number;
    const data = (text: string) => ({
      type: "stream.data" as const,
      streamId: id,
      seq: 0,
      data: new TextEncoder().encode(text),
    });
    const claim = (frame: ReturnType<typeof data>) =>
      [...boxes.listeners].some((l) => l.stream?.("box_1", frame) === true);
    expect(claim(data("a"))).toBe(true);
    expect(boxes.streamFrames).toEqual([]);
    expect(client.liveStreams).toBe(1);
    // The second chunk hits the consumer's cap: it says no more.
    expect(claim(data("b"))).toBe(true);
    expect(boxes.streamFrames).toEqual([
      { boxId: "box_1", frame: { type: "stream.close", streamId: id, reason: "cancelled" } },
    ]);
    expect(client.liveStreams).toBe(0);
    expect(claim(data("c"))).toBe(false);
    const { exitCode } = await run;
    expect(exitCode).toBe(0);
    expect(got).toEqual(["a", "b"]);
    expect(boxes.streamFrames).toHaveLength(1);
    client.close();
  });
});

describe("browser methods through a real hub and box-agent (protocol 1.3)", () => {
  async function connect(
    boxId: string,
    options: Partial<ConstructorParameters<typeof BoxAgent>[0]>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "hearth-browser-hub-"));
    dirs.push(dir);
    const hub = startHub({ dbPath: join(dir, "hub.db"), port: 0, boxPort: 0, log: () => {} });
    hubs.push(hub);
    const { token } = await hub.issueJoinToken(boxId, `ses_${boxId}`);
    const agent = new BoxAgent({
      hubUrl: hub.listenForBoxes("127.0.0.1"),
      boxId,
      joinToken: token,
      log: () => {},
      ...options,
    });
    agents.push(agent);
    agent.start();
    await hub.boxes.waitForBox(boxId, STEP_MS);
    const client = new ToolRpcClient({ boxes: hub.boxes, log: () => {} });
    return client;
  }

  test("a 1.2 box connects, and answers a browser method unknown-method, classified give-up", async () => {
    const client = await connect("box_old", {
      version: { major: 1, minor: 2 },
      tools: { root: workspace() },
    });
    const error = await rejection(client.call("box_old", "call_b", "browser.snapshot", {}));
    expect(error).toMatchObject({ code: "unknown-method", owner: "box", disposition: "give-up" });
    // Its file tools still work.
    expect(await client.call("box_old", "call_e", "tool.exists", { path: "." })).toEqual({
      exists: true,
    });
    client.close();
  }, 30_000);

  test("a 1.3 box with a browser answers: snapshot, then a click by ref, then a stale ref", async () => {
    const root = workspace();
    const driver = new FakeDriver();
    driver.first.snapshotText = '- button "Save" [ref=e2]';
    driver.first.targets.set("e2", {});
    const client = await connect("box_new", {
      tools: { root, browser: new BrowserTools({ driver, root }) },
    });
    const snap = await client.call("box_new", "call_s", "browser.snapshot", {});
    expect(snap.snapshot.text).toBe('- button "Save" [ref=s1e2]');
    const click = await client.call("box_new", "call_c", "browser.click", {
      ref: "s1e2",
      element: "Save",
    });
    expect(click).toMatchObject({ ok: true, outcome: "done" });
    const stale = await client.call("box_new", "call_x", "browser.click", {
      ref: "s1e2",
      element: "Save",
    });
    expect(stale).toMatchObject({ ok: false, outcome: "stale_ref" });
    expect(driver.first.actions).toEqual(["click e2 left"]);
    client.close();
  }, 30_000);
});
