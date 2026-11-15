/**
 * The desktop stream against the real box image (#45; decision 0016): a
 * signed-in browser WebSocket on the hub starts the session's box lazily and
 * reads the real Xvnc's `RFB 003.008` banner through box-agent's relay. Then
 * the box is stopped (hibernate) and the browser is closed with 4410.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md); CI runs it in the
 * `box-provider` job after `scripts/box-firewall.sh apply`.
 *
 *   HEARTH_BOX_AGENT_IMAGE  defaults to `hearth-box:ci`.
 *   HEARTH_DOCKER_SOCKET    optional, defaults to /var/run/docker.sock.
 *   HEARTH_BOX_PORT         the box listener port the firewall allows (8788).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PRINCIPAL } from "@hearth/core";
import { SESSION_COOKIE } from "../auth";
import { DEFAULT_DOCKER_SOCKET } from "../box/docker/config";
import { DockerBoxProvider } from "../box/docker/provider";
import { DEFAULT_BOX_PORT, type Hub, parsePort, startHub } from "../server";
import { DESKTOP_CLOSE } from "./bridge";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const boxPort = parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT);
const instance = `hearthdesk${process.pid}${Math.floor(Math.random() * 1e6)}`;

const provider = new DockerBoxProvider({
  config: {
    socketPath,
    instance,
    pullPolicy: "never",
    limits: { cpus: 1, memoryBytes: 1024 ** 3, pids: 512 },
    stopGraceMs: 2_000,
  },
});

async function until(what: string, cond: () => boolean, ms = 120_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

describe.skipIf(!enabled)("desktop stream with a Docker box", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;

  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("reads the real Xvnc banner RFB 003.008 through the hub, then closes on hibernate", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-desktop-docker-"));
    hub = startHub({
      port: 0,
      boxPort,
      provider,
      boxImage: image,
      dbPath: join(dir, "hub.db"),
      log: (line) => console.log(line),
      sessions: { connectDeadlineMs: 120_000 },
    });
    const h = hub;
    const cookie = `${SESSION_COOKIE}=${h.auth.issueSession(LOCAL_PRINCIPAL).token}`;
    const res = await fetch(new URL("/v1/sessions", h.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "desktop" }),
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { id: string; boxId: string } };

    const url = `ws://127.0.0.1:${h.server.port}/v1/sessions/${session.id}/desktop`;
    const ws = new WebSocket(url, { headers: { cookie } } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    const received: number[] = [];
    let closeCode: number | undefined;
    ws.addEventListener("message", (e) => received.push(...new Uint8Array(e.data as ArrayBuffer)));
    ws.addEventListener("close", (e) => {
      closeCode = e.code;
    });
    await until("the RFB banner", () => received.length >= 12 || closeCode !== undefined);
    const banner = new TextDecoder().decode(Uint8Array.from(received.slice(0, 12)));
    console.log(`desktop banner through the hub: ${JSON.stringify(banner)}`);
    expect(banner).toBe("RFB 003.008\n");

    // A view-only handshake: Xvnc offers security type None (1) and answers.
    ws.send(Uint8Array.from([...new TextEncoder().encode("RFB 003.008\n")]));
    await until("security types", () => received.length >= 14);
    expect(received.slice(12, 14)).toEqual([1, 1]);

    // Hibernate = stop the box: the viewer is closed.
    await provider.stop(session.boxId);
    await until("the viewer closed", () => closeCode !== undefined, 60_000);
    expect(closeCode).toBe(DESKTOP_CLOSE.boxGone);
  }, 300_000);
});
