/**
 * The session manager against the real box image and Docker (#42, #28;
 * decision 0013): lazy start → hibernate → wake on demand, then a box killed
 * from outside is classified as a crash and relaunched.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md). CI runs it in the
 * `box-provider` job after `scripts/box-firewall.sh apply`, so the hub's
 * default egress check lets boxes start.
 *
 *   HEARTH_BOX_AGENT_IMAGE  defaults to `hearth-box:ci`.
 *   HEARTH_DOCKER_SOCKET    optional, defaults to /var/run/docker.sock.
 *   HEARTH_BOX_PORT         the box listener port the firewall allows (8788).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_ID } from "@hearth/core";
import { DEFAULT_DOCKER_API_VERSION, DEFAULT_DOCKER_SOCKET } from "../box/docker/config";
import { DockerEngine } from "../box/docker/engine";
import { DockerBoxProvider } from "../box/docker/provider";
import { DEFAULT_BOX_PORT, type Hub, parsePort, startHub } from "../server";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const boxPort = parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT);
const instance = `hearthsess${process.pid}${Math.floor(Math.random() * 1e6)}`;
const scope = { workspaceId: DEFAULT_WORKSPACE_ID };

const engine = new DockerEngine({ socketPath, apiVersion: DEFAULT_DOCKER_API_VERSION });
const provider = new DockerBoxProvider({
  config: {
    socketPath,
    instance,
    pullPolicy: "never",
    limits: { cpus: 1, memoryBytes: 1024 ** 3, pids: 512 },
    stopGraceMs: 2_000,
  },
});

async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 120_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

describe.skipIf(!enabled)("session lifecycle with Docker boxes", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;

  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("lazy start → hibernate → wake, then a killed box is relaunched", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-session-docker-"));
    hub = startHub({
      port: 0,
      boxPort,
      provider,
      boxImage: image,
      dbPath: join(dir, "hub.db"),
      log: (line) => console.log(line),
      sessions: {
        idleMs: 3_000,
        runningGraceMs: 500,
        connectDeadlineMs: 120_000,
        exitPollMs: 500,
        superviseIntervalMs: 1_000,
      },
    });
    const h = hub;
    const state = async (id: string) => (await h.sessions.get(sessionPrincipal, id)).state;
    const eventTypes = async (id: string) =>
      (await h.events.read(scope, id, 0, 1000)).events.map((e) => e.type);

    // Create through the API: no box starts.
    const res = await fetch(new URL("/v1/sessions", h.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "docker" }),
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { id: string; boxId: string } };
    const { id, boxId } = session;
    expect(await state(id)).toBe("idle");
    expect(await provider.attach(boxId)).toBeUndefined();

    // Lazy start: the first tool call starts the box and waits for it.
    const lease = await h.sessions.ensureBox(id);
    expect(h.boxes.isConnected(boxId)).toBe(true);
    expect(await state(id)).toBe("running");
    expect((await provider.attach(boxId))?.state).toBe("running");
    lease.release();

    // Idle → hibernated: the container goes, the volume stays.
    await until("hibernate", async () => (await state(id)) === "hibernated", 60_000);
    await until("box stopped", async () => (await provider.attach(boxId))?.state === "stopped");

    // Wake on demand.
    const again = await h.sessions.ensureBox(id);
    expect(h.boxes.isConnected(boxId)).toBe(true);
    expect(await state(id)).toBe("running");
    again.release();
    await until("idle", async () => (await state(id)) === "idle", 10_000);

    // Kill the box from outside: exit 137 is a crash, relaunched with a fresh token.
    const info = await provider.attach(boxId);
    expect(info?.providerRef).toBeDefined();
    await engine.request({
      method: "POST",
      path: `/containers/${info?.providerRef}/kill`,
      ok: [204],
      timeoutMs: 10_000,
      endpoint: "container.kill",
    });
    await until("box.restarted", async () => (await eventTypes(id)).includes("box.restarted"));
    const restarted = (await h.events.read(scope, id, 0, 1000)).events.find(
      (e) => e.type === "box.restarted",
    );
    expect(restarted?.payload).toMatchObject({ cause: "crash", exitCode: 137 });
    await until("relaunched box connects", () => h.boxes.isConnected(boxId));
    expect(await eventTypes(id)).not.toContain("box.failed");
  }, 600_000);
});

const sessionPrincipal = {
  id: "pr_local",
  workspaceId: DEFAULT_WORKSPACE_ID,
  kind: "user" as const,
  displayName: "local",
};
