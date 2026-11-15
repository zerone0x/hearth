/**
 * The box-agent's VNC relay (decision 0016) against a fake RFB server on
 * loopback: bytes in order both ways, backpressure toward Xvnc, the inbound
 * bound, and every way a stream ends.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import type { Frame, StreamDataFrame } from "@hearth/protocol";
import { VncRelay, type VncRelayOptions, type VncSocket } from "./vnc";

const BANNER = new TextEncoder().encode("RFB 003.008\n");

interface FakeRfb {
  readonly server: Server;
  readonly port: number;
  readonly clients: Socket[];
  readonly received: Buffer[];
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function fakeRfb(onClient: (socket: Socket) => void = () => undefined): Promise<FakeRfb> {
  const clients: Socket[] = [];
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    clients.push(socket);
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => undefined);
    onClient(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, port: address.port, clients, received };
}

async function until(what: string, cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function relay(port: number, extra: Partial<VncRelayOptions> = {}) {
  const frames: Frame[] = [];
  let backlog = 0;
  const r = new VncRelay({
    port,
    log: () => undefined,
    send: (frame) => frames.push(frame),
    backlog: () => backlog,
    ...extra,
  });
  return {
    relay: r,
    frames,
    setBacklog(n: number) {
      backlog = n;
    },
    data(): StreamDataFrame[] {
      return frames.filter((f): f is StreamDataFrame => f.type === "stream.data");
    },
    bytes(): Buffer {
      return Buffer.concat(
        frames
          .filter((f): f is StreamDataFrame => f.type === "stream.data")
          .map((f) => Buffer.from(f.data)),
      );
    },
  };
}

function pattern(n: number): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}

describe("VncRelay", () => {
  test("relays RFB bytes both ways, in order, with consecutive seqs", async () => {
    const payload = pattern(300_000);
    const rfb = await fakeRfb((socket) => {
      socket.write(BANNER);
      socket.write(payload);
    });
    const r = relay(rfb.port, { chunkBytes: 4096 });
    r.relay.open({ type: "stream.open", streamId: 2, kind: "vnc" });
    await until("all bytes", () => r.bytes().byteLength === BANNER.byteLength + payload.byteLength);
    expect(r.bytes().subarray(0, 12).toString()).toBe("RFB 003.008\n");
    expect(r.bytes().subarray(12).equals(payload)).toBe(true);
    const data = r.data();
    expect(data.every((f) => f.streamId === 2 && f.data.byteLength <= 4096)).toBe(true);
    expect(data.map((f) => f.seq)).toEqual(data.map((_, i) => i));

    const parts = ["RFB 003.008\n", "\x01", "\x01", "abc"].map((s) => new TextEncoder().encode(s));
    parts.forEach((data, seq) => {
      expect(r.relay.data({ type: "stream.data", streamId: 2, seq, data })).toBe(true);
    });
    await until("bytes at the server", () => Buffer.concat(rfb.received).byteLength === 17);
    expect(Buffer.concat(rfb.received).toString()).toBe("RFB 003.008\n\x01\x01abc");
  });

  test("stops reading Xvnc while the hub socket is backed up, and resumes when it drains", async () => {
    const block = pattern(64 * 1024);
    let writing = true;
    const rfb = await fakeRfb((socket) => {
      const pump = () => {
        while (writing && socket.write(block)) {
          // Fill the kernel buffers until the relay stops reading.
        }
        if (writing) socket.once("drain", pump);
      };
      pump();
    });
    const r = relay(rfb.port, { highWaterBytes: 1024, lowWaterBytes: 512 });
    r.setBacklog(10_000);
    r.relay.open({ type: "stream.open", streamId: 4, kind: "vnc" });
    await until("first bytes", () => r.data().length > 0);
    await Bun.sleep(200);
    const whilePaused = r.bytes().byteLength;
    await Bun.sleep(200);
    // Paused: nothing more was read, though the server keeps trying to write.
    expect(r.bytes().byteLength).toBe(whilePaused);
    r.setBacklog(0);
    await until("reading again", () => r.bytes().byteLength > whilePaused + 1024 * 1024);
    writing = false;
    r.relay.closeAll();
  });

  test("closes the stream when bytes for Xvnc pile up past the inbound limit", () => {
    const frames: Frame[] = [];
    let destroyed = false;
    const stuck: VncSocket = {
      write: () => false,
      pause: () => stuck as never,
      resume: () => stuck as never,
      destroy: () => {
        destroyed = true;
        return stuck as never;
      },
      on: () => stuck as never,
      writableLength: 1000,
    } as unknown as VncSocket;
    const r = new VncRelay({
      send: (f) => frames.push(f),
      backlog: () => 0,
      connect: () => stuck,
      inboundLimitBytes: 1024,
      log: () => undefined,
    });
    r.open({ type: "stream.open", streamId: 6, kind: "vnc" });
    expect(r.data({ type: "stream.data", streamId: 6, seq: 0, data: new Uint8Array(24) })).toBe(
      true,
    );
    expect(frames).toEqual([]);
    r.data({ type: "stream.data", streamId: 6, seq: 1, data: new Uint8Array(25) });
    expect(frames).toEqual([
      expect.objectContaining({ type: "stream.close", streamId: 6, reason: "error" }),
    ]);
    expect(destroyed).toBe(true);
    expect(r.size).toBe(0);
  });

  test("ends the stream with done when Xvnc closes, and with error when it is not there", async () => {
    const rfb = await fakeRfb((socket) => socket.end(BANNER));
    const r = relay(rfb.port);
    r.relay.open({ type: "stream.open", streamId: 8, kind: "vnc" });
    await until("close", () => r.frames.some((f) => f.type === "stream.close"));
    expect(r.bytes().toString()).toBe("RFB 003.008\n");
    expect(r.frames.at(-1)).toMatchObject({ type: "stream.close", streamId: 8, reason: "done" });
    expect(r.relay.size).toBe(0);

    const closedPort = rfb.port;
    rfb.server.close();
    await Bun.sleep(20);
    const dead = relay(closedPort);
    dead.relay.open({ type: "stream.open", streamId: 10, kind: "vnc" });
    await until("error", () => dead.frames.length > 0);
    expect(dead.frames).toEqual([
      expect.objectContaining({ type: "stream.close", streamId: 10, reason: "error" }),
    ]);
  });

  test("a hub close or a lost hub connection drops the desktop socket without a frame", async () => {
    const rfb = await fakeRfb();
    const r = relay(rfb.port);
    r.relay.open({ type: "stream.open", streamId: 12, kind: "vnc" });
    r.relay.open({ type: "stream.open", streamId: 14, kind: "vnc" });
    await until("two clients", () => rfb.clients.length === 2);
    let ended = 0;
    for (const client of rfb.clients) client.on("close", () => ended++);
    expect(r.relay.close(12)).toBe(true);
    r.relay.closeAll();
    await until("desktop sockets closed", () => ended === 2);
    expect(r.frames).toEqual([]);
    expect(r.relay.size).toBe(0);
  });

  test("refuses odd ids, duplicate ids, file streams and out-of-order data", async () => {
    const rfb = await fakeRfb();
    const r = relay(rfb.port);
    r.relay.open({ type: "stream.open", streamId: 3, kind: "vnc" });
    r.relay.open({ type: "stream.open", streamId: 16, kind: "file", path: "a", mode: "read" });
    r.relay.open({ type: "stream.open", streamId: 18, kind: "vnc" });
    r.relay.open({ type: "stream.open", streamId: 18, kind: "vnc" });
    expect(r.frames.map((f) => f.type === "stream.close" && [f.streamId, f.reason])).toEqual([
      [3, "error"],
      [16, "error"],
      [18, "error"],
    ]);
    // The first 18 is still open; a skipped seq ends it.
    expect(r.relay.size).toBe(1);
    r.relay.data({ type: "stream.data", streamId: 18, seq: 1, data: new Uint8Array(1) });
    expect(r.frames.at(-1)).toMatchObject({ type: "stream.close", streamId: 18, reason: "error" });
    expect(r.relay.size).toBe(0);
    expect(
      r.relay.data({ type: "stream.data", streamId: 99, seq: 0, data: new Uint8Array(1) }),
    ).toBe(false);
  });
});
