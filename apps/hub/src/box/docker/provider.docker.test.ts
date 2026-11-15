/**
 * Integration tests against a real Docker daemon. They run only with
 * HEARTH_DOCKER_TESTS=1 (AGENTS.md) and need the box image:
 *
 *   HEARTH_BOX_IMAGE   an image whose default command keeps the box running,
 *                      e.g. the box image with `CMD ["sleep", "infinity"]`
 *                      (the CI `box-provider` job builds `hearth-box:ci-idle`).
 *   HEARTH_DOCKER_SOCKET  optional, defaults to /var/run/docker.sock.
 *
 * Every object is created under a unique instance name and destroyed afterwards,
 * so runs never see each other's boxes.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { BoxSpec } from "@hearth/core";
import { DEFAULT_DOCKER_API_VERSION, DEFAULT_DOCKER_SOCKET } from "./config";
import { DockerEngine } from "./engine";
import { DockerBoxProvider, LABEL } from "./provider";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_IMAGE"] ?? "hearth-box:ci-idle";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const instance = `hearthit${process.pid}${Math.floor(Math.random() * 1e6)}`;

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

const specFor = (boxId: string): BoxSpec => ({
  boxId,
  workspaceId: "ws_default",
  sessionId: `se_${boxId}`,
  image,
});

/** Run a command in the box; returns its exit code and combined output. */
async function exec(
  containerId: string,
  cmd: string[],
  detach = false,
): Promise<{ code: number; out: string }> {
  const created = await engine.request({
    method: "POST",
    path: `/containers/${containerId}/exec`,
    body: { Cmd: cmd, AttachStdout: !detach, AttachStderr: !detach, Tty: true },
    ok: [201],
    timeoutMs: 10_000,
    endpoint: "exec.create",
  });
  const id = (created.body as { Id: string }).Id;
  const started = await engine.request({
    method: "POST",
    path: `/exec/${id}/start`,
    body: { Detach: detach, Tty: true },
    ok: [200, 204],
    timeoutMs: 90_000,
    endpoint: "exec.start",
  });
  if (detach) return { code: 0, out: "" };
  const inspected = await engine.request({
    method: "GET",
    path: `/exec/${id}/json`,
    ok: [200],
    timeoutMs: 10_000,
    endpoint: "exec.inspect",
  });
  return { code: Number((inspected.body as { ExitCode: number }).ExitCode), out: started.text };
}

async function inspect(containerId: string) {
  const res = await engine.request({
    method: "GET",
    path: `/containers/${containerId}/json`,
    ok: [200],
    timeoutMs: 10_000,
    endpoint: "container.inspect",
  });
  return res.body as {
    Config: { User: string; Labels: Record<string, string> };
    HostConfig: Record<string, unknown>;
    NetworkSettings: {
      Ports: Record<string, unknown>;
      Networks: Record<string, { IPAddress: string }>;
    };
  };
}

describe.skipIf(!enabled)("DockerBoxProvider against a real daemon", () => {
  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
  });

  test("start runs an isolated, limited box with the boot env", async () => {
    const info = await provider.start(specFor("a"), {
      env: { HEARTH_HUB_URL: "ws://hub.invalid/box", HEARTH_JOIN_TOKEN: "join-a" },
    });
    expect(info.state).toBe("running");
    const c = await inspect(info.providerRef as string);
    expect(c.Config.User).toBe("1000:1000");
    expect(c.Config.Labels[LABEL.boxId]).toBe("a");
    expect(c.Config.Labels[LABEL.piVersion]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(c.HostConfig["CapDrop"]).toEqual(["ALL"]);
    expect(c.HostConfig["SecurityOpt"]).toEqual(["no-new-privileges:true"]);
    expect(c.HostConfig["NanoCpus"]).toBe(1e9);
    expect(c.HostConfig["Memory"]).toBe(1024 ** 3);
    expect(c.HostConfig["PidsLimit"]).toBe(512);
    expect(Object.keys(c.NetworkSettings.Networks)).toEqual([`${instance}-box-a`]);
    expect(Object.keys(c.NetworkSettings.Ports ?? {})).toEqual([]);

    const env = await exec(info.providerRef as string, ["printenv", "HEARTH_JOIN_TOKEN"]);
    expect(env.out.trim()).toBe("join-a");
    const caps = await exec(info.providerRef as string, ["grep", "CapBnd", "/proc/self/status"]);
    expect(caps.out).toContain("0000000000000000");
  }, 120_000);

  test("Chromium runs in the box with --no-sandbox under the provider's settings", async () => {
    const info = await provider.attach("a");
    const page = await exec(info?.providerRef as string, [
      "chromium",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "data:text/html,<p>hearth-provider</p>",
    ]);
    expect(page.out).toContain("hearth-provider");
  }, 120_000);

  test("the box has egress", async () => {
    const info = await provider.attach("a");
    const res = await exec(info?.providerRef as string, [
      "bun",
      "-e",
      "const r = await fetch('https://github.com', { signal: AbortSignal.timeout(20000) }); console.log('status=' + String(r.status))",
    ]);
    expect(res.out).toContain("status=200");
  }, 120_000);

  test("boxes cannot reach each other", async () => {
    const b = await provider.start(specFor("b"), { env: {} });
    const bRef = b.providerRef as string;
    await exec(
      bRef,
      [
        "bun",
        "-e",
        "Bun.serve({ hostname: '0.0.0.0', port: 8080, fetch: () => new Response('b') })",
      ],
      true,
    );
    const probe = (url: string) =>
      `try { const r = await fetch('${url}', { signal: AbortSignal.timeout(3000) }); console.log('reached', await r.text()) } catch (e) { console.log('blocked', e.name) }`;
    let self = "";
    for (let i = 0; i < 20 && !self.includes("reached b"); i++) {
      self = (await exec(bRef, ["bun", "-e", probe("http://127.0.0.1:8080/")])).out;
    }
    expect(self).toContain("reached b");
    const ip = Object.values((await inspect(bRef)).NetworkSettings.Networks)[0]?.IPAddress;
    expect(ip).toBeTruthy();
    const a = await provider.attach("a");
    const cross = await exec(a?.providerRef as string, ["bun", "-e", probe(`http://${ip}:8080/`)]);
    expect(cross.out).toContain("blocked");
  }, 180_000);

  test("hibernate keeps the volumes; wake gets a fresh runtime with the files", async () => {
    const before = await provider.attach("a");
    const ref = before?.providerRef as string;
    const write = await exec(ref, [
      "sh",
      "-c",
      "echo w > /workspace/marker && echo h > $HOME/marker && echo ok",
    ]);
    expect(write.out).toContain("ok");

    expect(await provider.stop("a")).toBe("stopped");
    expect(await provider.attach("a")).toMatchObject({ state: "stopped" });
    expect(await provider.stop("a")).toBe("already-stopped");

    const after = await provider.start(specFor("a"), { env: { HEARTH_JOIN_TOKEN: "join-a2" } });
    expect(after.providerRef).not.toBe(ref);
    const read = await exec(after.providerRef as string, [
      "sh",
      "-c",
      "cat /workspace/marker $HOME/marker; printenv HEARTH_JOIN_TOKEN",
    ]);
    expect(read.out.replace(/\r/g, "").trim().split("\n")).toEqual(["w", "h", "join-a2"]);
  }, 180_000);

  test("adopt finds the boxes; destroy removes everything", async () => {
    const adopted = await provider.adopt();
    expect(adopted.map((b) => b.boxId)).toEqual(["a", "b"]);
    expect(await provider.snapshot("a")).toEqual({ kind: "not-supported" });
    for (const id of ["a", "b"]) {
      expect(await provider.destroy(id)).toBe("destroyed");
      expect(await provider.destroy(id)).toBe("not-found");
      expect(await provider.attach(id)).toBeUndefined();
    }
    // Nothing of this instance is left, by label or by name.
    const list = async (path: string, filter: Record<string, string[]>) => {
      const res = await engine.request({
        method: "GET",
        path,
        query: { all: true, filters: JSON.stringify(filter) },
        ok: [200],
        timeoutMs: 10_000,
        endpoint: "list",
      });
      const body = res.body as unknown[] | { Volumes: unknown[] | null };
      return Array.isArray(body) ? body : (body.Volumes ?? []);
    };
    for (const filter of [
      { label: [`${LABEL.instance}=${instance}`] },
      { name: [`${instance}-box-`] },
    ]) {
      expect(await list("/volumes", filter)).toEqual([]);
      expect(await list("/networks", filter)).toEqual([]);
      expect(await list("/containers/json", filter)).toEqual([]);
    }
  }, 120_000);
});
