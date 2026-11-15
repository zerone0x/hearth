/**
 * The M0 exit criterion through the real box image (#7): the hub creates a box
 * with `DockerBoxProvider`, the box's own box-agent dials the hub, and `echo`
 * comes back.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md) and needs the box image with
 * its real default command (desktop, then box-agent):
 *
 *   HEARTH_BOX_AGENT_IMAGE  defaults to `hearth-box:ci` (built by the CI
 *                           `box-provider` job).
 *   HEARTH_DOCKER_SOCKET    optional, defaults to /var/run/docker.sock.
 *
 * The box sits on a bridge network of its own (decision 0007), so it reaches
 * the hub through that network's gateway, which is the host. The hub listens
 * on all interfaces for this test only (decision 0008).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxSpec, LOCAL_PRINCIPAL } from "@hearth/core";
import { type Hub, startHub } from "../server";
import { DEFAULT_DOCKER_API_VERSION, DEFAULT_DOCKER_SOCKET } from "./docker/config";
import { DockerEngine } from "./docker/engine";
import { DockerBoxProvider } from "./docker/provider";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const instance = `hearthecho${process.pid}${Math.floor(Math.random() * 1e6)}`;
/** Container start, desktop start and one dial; the image is already local. */
const CONNECT_DEADLINE_MS = 120_000;

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

/** The IP of the host on the box's own bridge network: where the box can reach the hub. */
async function gatewayOf(network: string): Promise<string> {
  const res = await engine.request({
    method: "GET",
    path: `/networks/${network}`,
    ok: [200],
    timeoutMs: 10_000,
    endpoint: "network.inspect",
  });
  const config = (res.body as { IPAM: { Config: { Gateway?: string }[] | null } }).IPAM.Config;
  const gateway = config?.find((c) => c.Gateway !== undefined && !c.Gateway.includes(":"))?.Gateway;
  if (gateway === undefined) throw new Error(`network ${network} has no IPv4 gateway`);
  return gateway;
}

async function logsOf(containerId: string | undefined): Promise<string> {
  if (containerId === undefined) return "(no container)";
  try {
    const res = await engine.request({
      method: "GET",
      path: `/containers/${containerId}/logs?stdout=1&stderr=1&tail=200`,
      ok: [200],
      timeoutMs: 10_000,
      endpoint: "container.logs",
    });
    return res.text;
  } catch (error) {
    return `(logs unavailable: ${String(error)})`;
  }
}

describe.skipIf(!enabled)("echo through DockerBoxProvider and the box image", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;

  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("the hub creates a box, the box dials in, and echo comes back", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-echo-docker-"));
    hub = startHub({ hostname: "0.0.0.0", port: 0, dbPath: join(dir, "hub.db") });
    const spec: BoxSpec = {
      boxId: "echo",
      workspaceId: "ws_default",
      sessionId: "se_echo",
      image,
    };
    await provider.create(spec);
    const gateway = await gatewayOf(provider.objectName(spec.boxId));
    const hubUrl = `ws://${gateway}:${hub.url.port}/v1/box/socket`;

    const info = await hub.launchBox(LOCAL_PRINCIPAL, provider, spec, hubUrl);
    expect(info.state).toBe("running");
    try {
      await hub.boxes.waitForBox(spec.boxId, CONNECT_DEADLINE_MS);
    } catch (error) {
      throw new Error(`${String(error)}\nbox logs:\n${await logsOf(info.providerRef)}`);
    }

    const params = { message: "hello from the hub", n: 7 };
    expect(await hub.boxes.echo(LOCAL_PRINCIPAL, spec.boxId, params)).toEqual(params);

    // Over HTTP too, the way the M0 demo calls it.
    const res = await fetch(new URL(`/v1/boxes/${spec.boxId}/echo`, hub.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("ping"),
      signal: AbortSignal.timeout(10_000),
    });
    expect(await res.json()).toEqual({ ok: true, result: "ping" });
  }, 300_000);
});
