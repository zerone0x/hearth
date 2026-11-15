/**
 * Tool RPC through the real box image (#41, decision 0011): the hub creates a
 * box with `DockerBoxProvider`, the box's own box-agent dials in, and the
 * hub's `ToolRpcClient` writes and reads a file, searches it with the image's
 * `rg`, runs a command in `/workspace`, and checks that a `setsid` child dies
 * with a timed-out or cancelled command and that a FIFO is refused at once.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md), with the box image's real
 * default command, like `echo.docker.test.ts`:
 *
 *   HEARTH_BOX_AGENT_IMAGE  defaults to `hearth-box:ci`.
 *   HEARTH_DOCKER_SOCKET    optional, defaults to /var/run/docker.sock.
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
import { ToolRpcClient } from "./tool-rpc";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const instance = `hearthtools${process.pid}${Math.floor(Math.random() * 1e6)}`;
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

describe.skipIf(!enabled)("tool RPC through DockerBoxProvider and the box image", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;

  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("write, read, grep and exec in /workspace of a real box", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-tools-docker-"));
    hub = startHub({ hostname: "0.0.0.0", port: 0, dbPath: join(dir, "hub.db") });
    const spec: BoxSpec = {
      boxId: "tools",
      workspaceId: "ws_default",
      sessionId: "se_tools",
      image,
    };
    await provider.create(spec);
    const gateway = await gatewayOf(provider.objectName(spec.boxId));
    const info = await hub.launchBox(
      LOCAL_PRINCIPAL,
      provider,
      spec,
      `ws://${gateway}:${hub.url.port}/v1/box/socket`,
    );
    try {
      await hub.boxes.waitForBox(spec.boxId, CONNECT_DEADLINE_MS);
    } catch (error) {
      throw new Error(`${String(error)}\nbox logs:\n${await logsOf(info.providerRef)}`);
    }

    const client = new ToolRpcClient({ boxes: hub.boxes });
    const ops = client.operations(spec.boxId, "call_docker");
    await ops.write.mkdir("/workspace/notes");
    await ops.write.writeFile("/workspace/notes/hello.txt", "hello from the hub\n");
    expect((await ops.read.readFile("notes/hello.txt")).toString()).toBe("hello from the hub\n");
    expect(await ops.ls.readdir("/workspace/notes")).toEqual(["hello.txt"]);

    const found = await ops.grep.search({
      pattern: "from the",
      path: "/workspace",
      ignoreCase: false,
      literal: true,
      context: 0,
      limit: 10,
    });
    expect(found.matches).toBe(1);
    expect(found.output).toContain("notes/hello.txt:1:hello from the hub");

    const chunks: Buffer[] = [];
    const { exitCode } = await ops.bash.exec(
      'pwd; cat notes/hello.txt; test -z "$HEARTH_JOIN_TOKEN" && echo no-token',
      "/workspace",
      { onData: (data) => chunks.push(data), timeout: 30 },
    );
    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe("/workspace\nhello from the hub\nno-token\n");

    const outside = ops.read.readFile("/etc/passwd");
    await expect(outside).rejects.toMatchObject({ code: "tool.path-escape" });

    const timedOut = ops.bash.exec("sleep 60", "/workspace", { onData: () => {}, timeout: 1 });
    await expect(timedOut).rejects.toThrow("timeout:1");

    // A child in its own session (setsid) dies with the call, on timeout and on cancel.
    const run = async (command: string) => {
      const out: Buffer[] = [];
      await ops.bash.exec(command, "/workspace", { onData: (d) => out.push(d), timeout: 30 });
      return Buffer.concat(out).toString();
    };
    // Dead, or a zombie waiting for tini to reap it.
    const deadCheck = (pidFile: string) =>
      `p=$(cat ${pidFile}); for i in $(seq 1 30); do ` +
      `if [ ! -e /proc/$p ] || [ "$(cut -d' ' -f3 /proc/$p/stat)" = Z ]; then echo dead; exit 0; fi; ` +
      "sleep 0.1; done; echo alive";
    const escaper = (pidFile: string) =>
      `setsid sleep 300 >/dev/null 2>&1 </dev/null & echo $! > ${pidFile}\nsleep 60`;
    const timedOutSetsid = ops.bash.exec(escaper("setsid-timeout.pid"), "/workspace", {
      onData: () => {},
      timeout: 1,
    });
    await expect(timedOutSetsid).rejects.toThrow("timeout:1");
    expect(await run(deadCheck("setsid-timeout.pid"))).toBe("dead\n");
    const abort = new AbortController();
    const cancelled = ops.bash.exec(escaper("setsid-cancel.pid"), "/workspace", {
      onData: () => {},
      signal: abort.signal,
      timeout: 60,
    });
    const waitPid = "for i in $(seq 1 50); do [ -s setsid-cancel.pid ] && break; sleep 0.1; done";
    expect(await run(`${waitPid}; echo ok`)).toBe("ok\n");
    abort.abort();
    await expect(cancelled).rejects.toThrow("aborted");
    expect(await run(deadCheck("setsid-cancel.pid"))).toBe("dead\n");

    // A FIFO is refused at once instead of hanging a slot.
    await run("mkfifo /workspace/fifo");
    const started = Date.now();
    await expect(ops.read.readFile("/workspace/fifo")).rejects.toMatchObject({
      code: "tool.not-regular-file",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    client.close();
  }, 300_000);
});
