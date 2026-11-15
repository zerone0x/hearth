/**
 * A frozen box is detected by the hub's heartbeat within its bound (#31,
 * decision 0028). `docker pause` freezes every process of the box while the
 * host kernel keeps its TCP connection open: no FIN, no RST, just silence,
 * the case a NAT timeout or a sleeping host gives. The hub must declare the
 * connection dead within `(maxMisses + 1) × intervalMs`, record it, and fail
 * a call in flight; after `docker unpause` the box-agent reconnects.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md) and needs the box image
 * (`HEARTH_BOX_AGENT_IMAGE`, default `hearth-box:ci`). Like the echo test it
 * runs the hub on production defaults, so in CI it runs after the box
 * firewall is applied.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxSpec, HearthError, LOCAL_PRINCIPAL } from "@hearth/core";
import { heartbeatBoundMs } from "@hearth/protocol";
import { DEFAULT_BOX_PORT, type Hub, parsePort, startHub } from "../server";
import { CONNECTION_DEAD_EVENT } from "./connections";
import { DEFAULT_DOCKER_API_VERSION, DEFAULT_DOCKER_SOCKET } from "./docker/config";
import { DockerEngine } from "./docker/engine";
import { DockerBoxProvider } from "./docker/provider";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const boxPort = parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT);
const instance = `hearthbeat${process.pid}${Math.floor(Math.random() * 1e6)}`;
const CONNECT_DEADLINE_MS = 120_000;
/** The hub's heartbeat in this test: 1 s beats, dead after 3 misses, so 4 s at most. */
const INTERVAL_MS = 1_000;
const MAX_MISSES = 3;
const BOUND_MS = heartbeatBoundMs(INTERVAL_MS, MAX_MISSES);
/** Scheduling slack on a shared CI runner on top of the bound. */
const SLACK_MS = 1_500;

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

async function containerCall(containerId: string, op: "pause" | "unpause"): Promise<void> {
  await engine.request({
    method: "POST",
    path: `/containers/${containerId}/${op}`,
    ok: [204],
    timeoutMs: 10_000,
    endpoint: `container.${op}`,
  });
}

describe.skipIf(!enabled)("heartbeat: a paused box is declared dead within the bound", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;
  let containerId: string | undefined;
  let paused = false;
  const spec: BoxSpec = {
    boxId: "beat",
    workspaceId: "ws_default",
    sessionId: "se_beat",
    image,
  };

  afterAll(async () => {
    if (paused && containerId !== undefined) await containerCall(containerId, "unpause");
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("pause → dead within the bound, recorded, call failed; unpause → reconnect", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-heartbeat-docker-"));
    const lines: string[] = [];
    hub = startHub({
      port: 0,
      boxPort,
      provider,
      dbPath: join(dir, "hub.db"),
      heartbeat: { intervalMs: INTERVAL_MS, maxMisses: MAX_MISSES },
      log: (line) => {
        lines.push(line);
        console.error(line);
      },
    });
    const info = await hub.startBox(LOCAL_PRINCIPAL, spec);
    containerId = info.providerRef;
    await hub.boxes.waitForBox(spec.boxId, CONNECT_DEADLINE_MS);
    expect(await hub.boxes.echo(LOCAL_PRINCIPAL, spec.boxId, "before")).toBe("before");
    const firstBoot = hub.boxes.bootIdOf(spec.boxId);

    let deadAt: number | undefined;
    hub.boxes.listen({
      dead: () => {
        deadAt ??= performance.now();
      },
    });

    // Healthy and idle for several bounds: the heartbeat keeps it alive.
    await Bun.sleep(2 * BOUND_MS);
    expect(hub.boxes.isConnected(spec.boxId)).toBe(true);
    expect(deadAt).toBeUndefined();

    await containerCall(containerId as string, "pause");
    paused = true;
    const pausedAt = performance.now();
    // A call in flight with a deadline far past the bound.
    const inFlight = hub.boxes.rpc(spec.boxId, "echo", "lost", 120_000).then(
      () => undefined,
      (e: unknown) => e,
    );
    const end = pausedAt + BOUND_MS + SLACK_MS + 5_000;
    while (deadAt === undefined && performance.now() < end) await Bun.sleep(50);
    expect(deadAt).toBeDefined();
    const detectedMs = (deadAt as number) - pausedAt;
    console.error(`heartbeat: paused box declared dead after ${Math.round(detectedMs)} ms`);
    expect(detectedMs).toBeGreaterThanOrEqual((MAX_MISSES - 1) * INTERVAL_MS);
    expect(detectedMs).toBeLessThanOrEqual(BOUND_MS + SLACK_MS);
    expect(hub.boxes.isConnected(spec.boxId)).toBe(false);
    const error = await inFlight;
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("box.connection-dead");
    expect(lines.some((l) => l.startsWith(`box ${spec.boxId} connection dead`))).toBe(true);
    const events = (
      await hub.events.read({ workspaceId: spec.workspaceId }, spec.sessionId, 0, 100)
    ).events;
    expect(events.map((e) => e.type)).toContain(CONNECTION_DEAD_EVENT);

    await containerCall(containerId as string, "unpause");
    paused = false;
    await hub.boxes.waitForBox(spec.boxId, 60_000);
    // Same process, same boot: the box-agent redialled.
    expect(hub.boxes.bootIdOf(spec.boxId)).toBe(firstBoot);
    expect(await hub.boxes.echo(LOCAL_PRINCIPAL, spec.boxId, "after")).toBe("after");
  }, 300_000);
});
