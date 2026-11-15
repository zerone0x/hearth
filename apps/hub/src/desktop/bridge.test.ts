/**
 * The desktop bridge (decision 0016) with a fake box connection and a fake
 * browser socket: authorization before the box starts, bytes in order both
 * ways, the view-only filter on the real call path, bounded buffers, and
 * every way a viewer is closed.
 */

import { describe, expect, test } from "bun:test";
import {
  type Authorizer,
  type BoxId,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  LOCAL_PRINCIPAL,
  type Principal,
} from "@hearth/core";
import type { Frame, StreamCloseFrame, StreamDataFrame } from "@hearth/protocol";
import type { BoxConnectionListener } from "../box/connections";
import { DESKTOP_CLOSE, DesktopBridge, type ViewerSocket, type ViewerTicket } from "./bridge";

const enc = (s: string) => new TextEncoder().encode(s);
const HANDSHAKE = Uint8Array.from([...enc("RFB 003.008\n"), 1, 0]);
const UPDATE_REQUEST = Uint8Array.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const KEY = Uint8Array.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const POINTER = Uint8Array.from([5, 1, 0, 10, 0, 20]);

class FakeBoxes {
  listener: BoxConnectionListener | undefined;
  readonly sent: { boxId: BoxId; frame: Frame }[] = [];
  connected = true;
  listen(listener: BoxConnectionListener) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  sendStream(boxId: BoxId, frame: Frame): boolean {
    if (!this.connected) return false;
    this.sent.push({ boxId, frame });
    return true;
  }
  data(): StreamDataFrame[] {
    return this.sent
      .map((s) => s.frame)
      .filter((f): f is StreamDataFrame => f.type === "stream.data");
  }
  closes(): StreamCloseFrame[] {
    return this.sent
      .map((s) => s.frame)
      .filter((f): f is StreamCloseFrame => f.type === "stream.close");
  }
  fromBox(frame: StreamDataFrame | StreamCloseFrame, boxId = "box_1"): boolean | undefined {
    return this.listener?.stream?.(boxId, frame);
  }
}

class FakeSocket implements ViewerSocket {
  readonly sent: Uint8Array[] = [];
  buffered = 0;
  closedWith: { code: number | undefined; reason: string | undefined } | undefined;
  send(data: Uint8Array) {
    this.sent.push(data);
    return data.byteLength;
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
  }
  getBufferedAmount() {
    return this.buffered;
  }
}

function setup(
  options: {
    allow?: boolean;
    limitBytes?: number;
    highWaterBytes?: number;
    reauthIntervalMs?: number;
  } = {},
) {
  const boxes = new FakeBoxes();
  const calls: string[] = [];
  const authorizer: Authorizer = {
    async authorize(_principal, action, resource) {
      calls.push(`authorize ${action} ${resource.type}:${resource.id}`);
      return options.allow === false
        ? { allowed: false, policy: "test", reason: "not yours" }
        : { allowed: true, policy: "test" };
    },
  };
  const sessions = {
    scope: { workspaceId: DEFAULT_WORKSPACE_ID },
    async get(_p: Principal, id: string) {
      calls.push(`get ${id}`);
      return { id } as never;
    },
    async ensureBox(id: string) {
      calls.push(`ensureBox ${id}`);
      return { sessionId: id, boxId: "box_1", release: () => calls.push(`release ${id}`) };
    },
  };
  const bridge = new DesktopBridge({
    boxes,
    sessions,
    authorizer,
    log: () => undefined,
    ...(options.limitBytes === undefined ? {} : { limitBytes: options.limitBytes }),
    ...(options.highWaterBytes === undefined ? {} : { highWaterBytes: options.highWaterBytes }),
    ...(options.reauthIntervalMs === undefined
      ? {}
      : { reauthIntervalMs: options.reauthIntervalMs }),
  });
  let signedIn: Principal | undefined = LOCAL_PRINCIPAL;
  const ticket = (): ViewerTicket => ({
    principal: LOCAL_PRINCIPAL,
    sessionId: "ses_1",
    boxId: "box_1",
    authenticate: () => signedIn,
  });
  return {
    boxes,
    bridge,
    calls,
    ticket,
    signOut() {
      signedIn = undefined;
    },
    open() {
      const socket = new FakeSocket();
      const viewer = bridge.attach(socket, ticket());
      if (viewer === undefined) throw new Error("not attached");
      return { socket, viewer };
    },
  };
}

describe("DesktopBridge.prepare", () => {
  test("authorizes desktop.view, reads the session, starts the box and releases the lease", async () => {
    const t = setup();
    const ticket = await t.bridge.prepare(LOCAL_PRINCIPAL, "ses_1", () => LOCAL_PRINCIPAL);
    expect(ticket.boxId).toBe("box_1");
    expect(t.calls).toEqual([
      "authorize desktop.view session:ses_1",
      "get ses_1",
      "ensureBox ses_1",
      "release ses_1",
    ]);
  });

  test("a denied viewer gets authz.denied and no box is started", async () => {
    const t = setup({ allow: false });
    const error = await t.bridge
      .prepare(LOCAL_PRINCIPAL, "ses_1", () => LOCAL_PRINCIPAL)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("authz.denied");
    expect(t.calls).toEqual(["authorize desktop.view session:ses_1"]);
  });
});

describe("DesktopBridge streams", () => {
  test("opens an even-id vnc stream and relays bytes in order both ways", () => {
    const t = setup();
    const { socket, viewer } = t.open();
    expect(viewer.streamId % 2).toBe(0);
    expect(t.boxes.sent[0]?.frame).toEqual({
      type: "stream.open",
      streamId: viewer.streamId,
      kind: "vnc",
    });
    const id = viewer.streamId;
    for (let seq = 0; seq < 5; seq++) {
      expect(
        t.boxes.fromBox({ type: "stream.data", streamId: id, seq, data: Uint8Array.of(seq) }),
      ).toBe(true);
    }
    expect(socket.sent.map((d) => d[0])).toEqual([0, 1, 2, 3, 4]);

    t.bridge.message(viewer, HANDSHAKE);
    t.bridge.message(viewer, UPDATE_REQUEST);
    const data = t.boxes.data();
    expect(data.map((f) => f.seq)).toEqual([0, 1]);
    expect([...(data[0] as StreamDataFrame).data]).toEqual([...enc("RFB 003.008\n"), 1, 1]);
    expect([...(data[1] as StreamDataFrame).data]).toEqual([...UPDATE_REQUEST]);
    // A second viewer gets another even id.
    const second = t.open();
    expect(second.viewer.streamId).not.toBe(id);
    expect(second.viewer.streamId % 2).toBe(0);
  });

  test("view-only: key and pointer events never reach the box", () => {
    const t = setup();
    const { viewer } = t.open();
    t.bridge.message(viewer, HANDSHAKE);
    t.bridge.message(viewer, KEY);
    t.bridge.message(viewer, POINTER);
    t.bridge.message(viewer, Uint8Array.from([...KEY, ...UPDATE_REQUEST, ...POINTER]));
    const forwarded = t.boxes.data().flatMap((f) => [...f.data]);
    expect(forwarded).toEqual([...enc("RFB 003.008\n"), 1, 1, ...UPDATE_REQUEST]);
    expect(viewer.filter.dropped).toBe(4);
  });

  test("a viewer that breaks RFB is closed with 1008 and the box stream is cancelled", () => {
    const t = setup();
    const { socket, viewer } = t.open();
    t.bridge.message(viewer, enc("RFB 003.003\n"));
    expect(socket.closedWith?.code).toBe(DESKTOP_CLOSE.protocol);
    expect(t.boxes.closes()).toEqual([
      expect.objectContaining({ streamId: viewer.streamId, reason: "cancelled" }),
    ]);
    const text = t.open();
    t.bridge.message(text.viewer, "RFB 003.008\n");
    expect(text.socket.closedWith?.code).toBe(DESKTOP_CLOSE.protocol);
  });

  test("backpressure: requests are held while the browser is backed up, then flushed in order", async () => {
    const t = setup({ highWaterBytes: 1000 });
    const { socket, viewer } = t.open();
    t.bridge.message(viewer, HANDSHAKE);
    socket.buffered = 1001;
    t.bridge.message(viewer, UPDATE_REQUEST);
    t.bridge.message(viewer, UPDATE_REQUEST);
    expect(t.boxes.data().length).toBe(1);
    expect(viewer.heldBytes).toBe(20);
    await Bun.sleep(60);
    expect(t.boxes.data().length).toBe(1);
    socket.buffered = 1000;
    await Bun.sleep(60);
    expect(t.boxes.data().map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(viewer.heldBytes).toBe(0);
    expect(socket.closedWith).toBeUndefined();
  });

  test("held browser bytes are bounded: past the limit the viewer is closed", () => {
    const t = setup({ highWaterBytes: 0 });
    const { socket, viewer } = t.open();
    t.bridge.message(viewer, HANDSHAKE);
    socket.buffered = 1;
    const many = new Uint8Array(UPDATE_REQUEST.byteLength * 7000);
    for (let i = 0; i < 7000; i++) many.set(UPDATE_REQUEST, i * UPDATE_REQUEST.byteLength);
    t.bridge.message(viewer, many);
    expect(socket.closedWith?.code).toBe(DESKTOP_CLOSE.protocol);
    expect(viewer.heldBytes).toBe(0);
  });

  test("a browser whose queue would pass the limit is closed, not buffered", () => {
    const t = setup({ limitBytes: 100 });
    const { socket, viewer } = t.open();
    const id = viewer.streamId;
    socket.buffered = 60;
    t.boxes.fromBox({ type: "stream.data", streamId: id, seq: 0, data: new Uint8Array(40) });
    expect(socket.sent.length).toBe(1);
    t.boxes.fromBox({ type: "stream.data", streamId: id, seq: 1, data: new Uint8Array(41) });
    expect(socket.sent.length).toBe(1);
    expect(socket.closedWith?.code).toBe(DESKTOP_CLOSE.slowViewer);
    expect(t.boxes.closes()).toEqual([
      expect.objectContaining({ streamId: id, reason: "cancelled" }),
    ]);
    // Later bytes of the stream are no longer the bridge's.
    expect(
      t.boxes.fromBox({ type: "stream.data", streamId: id, seq: 2, data: new Uint8Array(1) }),
    ).toBe(false);
  });

  test("out-of-order data from the box ends the viewer", () => {
    const t = setup();
    const { socket, viewer } = t.open();
    t.boxes.fromBox({
      type: "stream.data",
      streamId: viewer.streamId,
      seq: 1,
      data: new Uint8Array(1),
    });
    expect(socket.sent.length).toBe(0);
    expect(socket.closedWith?.code).toBe(DESKTOP_CLOSE.boxGone);
  });

  test("closes viewers when the box disconnects (exit, hibernate) and when the box ends the stream", () => {
    const t = setup();
    const a = t.open();
    const b = t.open();
    t.boxes.fromBox({ type: "stream.close", streamId: a.viewer.streamId, reason: "done" });
    expect(a.socket.closedWith?.code).toBe(DESKTOP_CLOSE.boxGone);
    expect(t.boxes.closes()).toEqual([]);
    t.boxes.listener?.disconnected?.("box_1", "boot_1");
    expect(b.socket.closedWith?.code).toBe(DESKTOP_CLOSE.boxGone);
    expect(t.bridge.viewers("box_1")).toBe(0);
  });

  test("a revoked login closes the viewer on its next message and on the timer", async () => {
    const t = setup({ reauthIntervalMs: 20 });
    const a = t.open();
    t.signOut();
    t.bridge.message(a.viewer, HANDSHAKE);
    expect(a.socket.closedWith?.code).toBe(DESKTOP_CLOSE.revoked);
    expect(t.boxes.data()).toEqual([]);
    expect(t.boxes.closes()).toEqual([
      expect.objectContaining({ streamId: a.viewer.streamId, reason: "revoked" }),
    ]);

    const u = setup({ reauthIntervalMs: 20 });
    const idle = u.open();
    await Bun.sleep(50);
    expect(idle.socket.closedWith).toBeUndefined();
    u.signOut();
    await Bun.sleep(60);
    expect(idle.socket.closedWith?.code).toBe(DESKTOP_CLOSE.revoked);
  });

  test("a box that is not connected, too many viewers and shutdown are refused", () => {
    const t = setup();
    for (let i = 0; i < 4; i++) t.open();
    const fifth = new FakeSocket();
    expect(t.bridge.attach(fifth, t.ticket())).toBeUndefined();
    expect(fifth.closedWith?.code).toBe(DESKTOP_CLOSE.tooMany);

    const u = setup();
    u.boxes.connected = false;
    const gone = new FakeSocket();
    expect(u.bridge.attach(gone, u.ticket())).toBeUndefined();
    expect(gone.closedWith?.code).toBe(DESKTOP_CLOSE.boxGone);

    const v = setup();
    const open = v.open();
    v.bridge.shutdown();
    expect(open.socket.closedWith?.code).toBe(DESKTOP_CLOSE.shutdown);
    const late = new FakeSocket();
    expect(v.bridge.attach(late, v.ticket())).toBeUndefined();
    expect(late.closedWith?.code).toBe(DESKTOP_CLOSE.shutdown);
  });
});
