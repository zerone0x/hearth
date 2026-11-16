/**
 * Live output of a running command (decision 0036): the box-side sender's
 * coalescing, cap and backpressure, and the executor streaming a real
 * command before it answers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_OUTPUT_STREAM_BASE,
  type RpcResultFrame,
  type StreamCloseFrame,
  type StreamDataFrame,
} from "@hearth/protocol";
import { ToolExecutor } from "./executor";
import { LiveOutputSender } from "./live-output";

type Out = StreamDataFrame | StreamCloseFrame;
const text = (frames: readonly (Out | RpcResultFrame)[]) =>
  frames
    .flatMap((f) => (f.type === "stream.data" ? [Buffer.from(f.data).toString("utf8")] : []))
    .join("");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = LIVE_OUTPUT_STREAM_BASE + 2;

function sender(options: { backlog?: () => number; maxBytes?: number; chunkBytes?: number } = {}) {
  const frames: Out[] = [];
  const s = new LiveOutputSender({
    streamId: ID,
    send: (f) => frames.push(f),
    backlog: options.backlog ?? (() => 0),
    intervalMs: 20,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
  });
  return { s, frames };
}

describe("LiveOutputSender", () => {
  test("coalesces the reads of one interval into one frame, seq from 0", async () => {
    const { s, frames } = sender();
    for (const part of ["a", "b", "c"]) s.write(Buffer.from(part));
    expect(frames).toHaveLength(0);
    await wait(40);
    s.write(Buffer.from("d"));
    await wait(40);
    expect(frames.map((f) => (f.type === "stream.data" ? f.seq : -1))).toEqual([0, 1]);
    expect(text(frames)).toBe("abcd");
  });

  test("sends at once when a chunk's worth waits", () => {
    const { s, frames } = sender({ chunkBytes: 4 });
    s.write(Buffer.from("ab"));
    expect(frames).toHaveLength(0);
    s.write(Buffer.from("cd"));
    expect(text(frames)).toBe("abcd");
  });

  test("caps the bytes per command", async () => {
    const { s, frames } = sender({ maxBytes: 5 });
    s.write(Buffer.from("1234"));
    s.write(Buffer.from("5678"));
    s.write(Buffer.from("9"));
    s.end();
    expect(text(frames)).toBe("12345");
  });

  test("drops what waits while the hub socket is backed up, and never queues it", async () => {
    let backlog = 10 * 1024 * 1024;
    const { s, frames } = sender({ backlog: () => backlog });
    s.write(Buffer.from("lost"));
    await wait(40);
    expect(frames).toHaveLength(0);
    expect(s.dropped).toBe(4);
    backlog = 0;
    s.write(Buffer.from("kept"));
    s.end();
    expect(text(frames)).toBe("kept");
  });

  test("end sends what waits, then one close; stop sends nothing more", () => {
    const { s, frames } = sender();
    s.write(Buffer.from("tail"));
    s.end();
    s.end();
    s.write(Buffer.from("after"));
    expect(frames.map((f) => f.type)).toEqual(["stream.data", "stream.close"]);
    expect(frames[1]).toEqual({ type: "stream.close", streamId: ID, reason: "done" });
    const other = sender();
    other.s.write(Buffer.from("x"));
    other.s.stop();
    other.s.end();
    expect(other.frames).toHaveLength(0);
  });
});

describe("executor live output", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(withStream = true) {
    const base = mkdtempSync(join(tmpdir(), "hearth-live-"));
    dirs.push(base);
    const root = join(base, "workspace");
    mkdirSync(root);
    const frames: Array<Out | RpcResultFrame> = [];
    let answered: (() => void) | undefined;
    const answer = new Promise<void>((r) => {
      answered = r;
    });
    const executor = new ToolExecutor({
      root,
      send: (f) => {
        frames.push(f);
        answered?.();
      },
      ...(withStream ? { sendStream: (f: Out) => frames.push(f) } : {}),
    });
    return { executor, frames, answer };
  }

  test("a sleep+echo command streams its first line before it ends; close comes before the result", async () => {
    const { executor, frames, answer } = setup();
    executor.handle({
      type: "rpc",
      id: "rpc_1",
      method: "tool.exec",
      params: {
        callId: "c1",
        command: "echo first; sleep 1; echo second",
        cwd: ".",
        timeoutMs: 10_000,
        outputStream: ID,
      },
    });
    const until = Date.now() + 5_000;
    while (text(frames) === "" && Date.now() < until) await wait(20);
    // The first line is out while the command still sleeps.
    expect(text(frames)).toBe("first\n");
    expect(frames.some((f) => f.type === "rpc.result")).toBe(false);
    await answer;
    expect(text(frames)).toBe("first\nsecond\n");
    const types = frames.map((f) => f.type);
    expect(types.slice(-2)).toEqual(["stream.close", "rpc.result"]);
    const result = frames.at(-1) as RpcResultFrame;
    expect(result.ok && (result.result as { output: string }).output).toBe("first\nsecond\n");
  });

  test("without an outputStream, or without a stream sender, it answers once as before", async () => {
    for (const [withStream, params] of [
      [true, {}],
      [false, { outputStream: ID }],
    ] as const) {
      const { executor, frames, answer } = setup(withStream);
      executor.handle({
        type: "rpc",
        id: "rpc_2",
        method: "tool.exec",
        params: { callId: "c2", command: "echo hi", cwd: ".", timeoutMs: 5_000, ...params },
      });
      await answer;
      expect(frames.map((f) => f.type)).toEqual(["rpc.result"]);
    }
  });

  test("the hub closing the stream stops it; the command runs on and answers", async () => {
    const { executor, frames, answer } = setup();
    executor.handle({
      type: "rpc",
      id: "rpc_3",
      method: "tool.exec",
      params: {
        callId: "c3",
        command: "echo first; sleep 0.5; echo second",
        cwd: ".",
        timeoutMs: 10_000,
        outputStream: ID,
      },
    });
    const until = Date.now() + 5_000;
    while (text(frames) === "" && Date.now() < until) await wait(20);
    expect(executor.closeStream(ID)).toBe(true);
    expect(executor.closeStream(ID)).toBe(false);
    await answer;
    expect(text(frames)).toBe("first\n");
    expect(frames.map((f) => f.type)).toEqual(["stream.data", "rpc.result"]);
  });
});
