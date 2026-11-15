/**
 * The desktop route end to end (decision 0016): a browser WebSocket on the
 * hub's public listener, the real login and request guards, the real box
 * connection and a real box-agent relaying to a fake RFB server.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PRINCIPAL } from "@hearth/core";
import { BoxAgent } from "../../../box-agent/src/connection";
import { SESSION_COOKIE } from "../auth";
import { type Hub, startHub } from "../server";
import { DESKTOP_CLOSE } from "./bridge";

const dirs: string[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
const KEY = [4, 1, 0, 0, 0, 0, 0, 0x61];
const UPDATE_REQUEST = [3, 1, 0, 0, 0, 0, 5, 0, 3, 32];

async function until(what: string, cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

interface Fixture {
  hub: Hub;
  agent: BoxAgent;
  rfbClients: Socket[];
  rfbReceived: number[];
  ensured: string[];
  url: string;
  cookie: string;
}

/** A hub whose session `ses_1` maps to a connected box-agent; the box's Xvnc is a fake RFB server. */
async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "hearth-desktop-"));
  dirs.push(dir);
  const rfbClients: Socket[] = [];
  const rfbReceived: number[] = [];
  const rfb: Server = createServer((socket) => {
    rfbClients.push(socket);
    socket.on("data", (chunk: Buffer) => rfbReceived.push(...chunk));
    socket.on("error", () => undefined);
    socket.write("RFB 003.008\n");
  });
  await new Promise<void>((resolve) => rfb.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => rfb.close());
  const rfbPort = (rfb.address() as { port: number }).port;

  const hub = startHub({ dbPath: join(dir, "hub.db"), port: 0, boxPort: 0, log: () => undefined });
  cleanups.push(() => hub.stop());
  const boxUrl = hub.listenForBoxes("127.0.0.1");
  const { token } = await hub.issueJoinToken("box_1", "ses_1");
  const agent = new BoxAgent({
    hubUrl: boxUrl,
    boxId: "box_1",
    joinToken: token,
    log: () => undefined,
    vnc: { port: rfbPort },
  });
  cleanups.push(() => agent.stop());
  agent.start();
  await until("box connected", () => hub.boxes.isConnected("box_1"));

  // No Docker here: the session manager's lookups answer for `ses_1` with the agent's box.
  const ensured: string[] = [];
  hub.sessions.get = async (_p, id) => {
    if (id !== "ses_1") throw new Error("no such session");
    return { id } as never;
  };
  hub.sessions.ensureBox = async (id) => {
    ensured.push(id);
    return { sessionId: id, boxId: "box_1", release: () => undefined };
  };
  const url = `ws://127.0.0.1:${hub.server.port}/v1/sessions/ses_1/desktop`;
  const cookie = `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}`;
  return { hub, agent, rfbClients, rfbReceived, ensured, url, cookie };
}

function browser(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const received: number[] = [];
  let opened = false;
  let closeCode: number | undefined;
  ws.addEventListener("open", () => {
    opened = true;
  });
  ws.addEventListener("message", (e) => received.push(...new Uint8Array(e.data as ArrayBuffer)));
  ws.addEventListener("close", (e) => {
    closeCode = e.code;
  });
  return {
    ws,
    received,
    get opened() {
      return opened;
    },
    get closeCode() {
      return closeCode;
    },
  };
}

describe("GET /v1/sessions/:id/desktop", () => {
  test("relays the RFB banner to the browser and filtered input to the box", async () => {
    const f = await fixture();
    const b = browser(f.url, { cookie: f.cookie, origin: `http://127.0.0.1:${f.hub.server.port}` });
    await until("banner", () => b.received.length >= 12);
    expect(new TextDecoder().decode(Uint8Array.from(b.received))).toBe("RFB 003.008\n");
    expect(f.ensured).toEqual(["ses_1"]);
    b.ws.send(Uint8Array.from([...enc("RFB 003.008\n"), 1, 0, ...KEY, ...UPDATE_REQUEST]));
    await until("bytes at the box", () => f.rfbReceived.length >= 24);
    await Bun.sleep(50);
    expect(f.rfbReceived).toEqual([...enc("RFB 003.008\n"), 1, 1, ...UPDATE_REQUEST]);
    // Bytes from the desktop after the banner arrive in order.
    const tail = Array.from({ length: 50_000 }, (_, i) => i & 0xff);
    f.rfbClients[0]?.write(Uint8Array.from(tail));
    await until("tail", () => b.received.length >= 12 + tail.length);
    expect(b.received.slice(12)).toEqual(tail);
    b.ws.close();
  });

  test("without a login the upgrade is refused with 401 and no box is started", async () => {
    const f = await fixture();
    const res = await fetch(f.url.replace("ws:", "http:"), {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(401);
    const signedOut = browser(f.url, {});
    await until("closed", () => signedOut.closeCode !== undefined);
    expect(signedOut.opened).toBe(false);
    expect(f.ensured).toEqual([]);
    expect(f.rfbClients.length).toBe(0);
  });

  test("a cross-origin or foreign-host upgrade is refused even with a login", async () => {
    const f = await fixture();
    const http = f.url.replace("ws:", "http:");
    const upgrade = {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    const cross = await fetch(http, {
      headers: { ...upgrade, cookie: f.cookie, origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    const foreign = await fetch(http, {
      headers: { ...upgrade, cookie: f.cookie, host: "evil.example" },
    });
    expect(foreign.status).toBe(421);
    const b = browser(f.url, { cookie: f.cookie, origin: "https://evil.example" });
    await until("closed", () => b.closeCode !== undefined);
    expect(b.opened).toBe(false);
    expect(f.ensured).toEqual([]);
    expect(f.rfbClients.length).toBe(0);
  });

  test("a plain GET without an upgrade gets 426", async () => {
    const f = await fixture();
    const res = await fetch(f.url.replace("ws:", "http:"), { headers: { cookie: f.cookie } });
    expect(res.status).toBe(426);
  });

  test("the browser is closed when the box exits, and when its login is revoked", async () => {
    const f = await fixture();
    const b = browser(f.url, { cookie: f.cookie });
    await until("banner", () => b.received.length >= 12);
    f.agent.stop();
    await until("closed", () => b.closeCode !== undefined);
    expect(b.closeCode).toBe(DESKTOP_CLOSE.boxGone);
  });

  test("signing out closes an open desktop with 4401", async () => {
    const f = await fixture();
    const token = f.cookie.split("=")[1] as string;
    const b = browser(f.url, { cookie: f.cookie });
    await until("banner", () => b.received.length >= 12);
    f.hub.auth.logout(token);
    b.ws.send(Uint8Array.from(enc("RFB 003.008\n")));
    await until("closed", () => b.closeCode !== undefined);
    expect(b.closeCode).toBe(DESKTOP_CLOSE.revoked);
    await until(
      "desktop socket closed at the box",
      () => f.rfbClients[0]?.destroyed === true || f.rfbClients[0]?.readableEnded === true,
    );
  });
});
