/**
 * The M0 exit criterion through the real box image (#7), with the hub on its
 * production defaults (#27, #20; decision 0012): the public API on loopback,
 * the box socket on a box listener bound to the gateway of the box's own
 * network, and the box started by `hub.startBox` through `DockerBoxProvider`.
 * Then the box probes its egress, with fetch and through the desktop's
 * Chromium over CDP.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md) and needs the box image with
 * its real default command (desktop, then box-agent):
 *
 *   HEARTH_BOX_AGENT_IMAGE  defaults to `hearth-box:ci` (built by the CI
 *                           `box-provider` job).
 *   HEARTH_DOCKER_SOCKET    optional, defaults to /var/run/docker.sock.
 *   HEARTH_BOX_PORT         the box listener port the firewall allows (8788).
 *   HEARTH_TEST_LAN_URL     an HTTP server on a private address beyond the
 *                           host (CI: a network namespace on 192.168.77.2).
 *   HEARTH_TEST_EGRESS      `filtered` (default): `scripts/box-firewall.sh
 *                           apply` ran, so the host, the LAN and the metadata
 *                           IP must be out of reach, and the hub starts the
 *                           box only because the script's marker exists
 *                           (default egress check). `open`: no firewall and
 *                           HEARTH_BOX_EGRESS=unrestricted; the same probes
 *                           must reach the host and the LAN, which proves
 *                           they can tell the two apart.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxSpec, LOCAL_PRINCIPAL } from "@hearth/core";
import { SESSION_COOKIE } from "../auth";
import { DEFAULT_BOX_PORT, type Hub, parsePort, startHub } from "../server";
import { DEFAULT_DOCKER_API_VERSION, DEFAULT_DOCKER_SOCKET } from "./docker/config";
import { DockerEngine } from "./docker/engine";
import { DockerBoxProvider } from "./docker/provider";
import { UNRESTRICTED_EGRESS } from "./egress";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const boxPort = parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT);
const lanUrl = process.env["HEARTH_TEST_LAN_URL"];
const egress = process.env["HEARTH_TEST_EGRESS"] || "filtered";
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

/** Run a command in the box; returns its combined output. */
async function exec(containerId: string, cmd: string[]): Promise<string> {
  const created = await engine.request({
    method: "POST",
    path: `/containers/${containerId}/exec`,
    body: { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true },
    ok: [201],
    timeoutMs: 10_000,
    endpoint: "exec.create",
  });
  const id = (created.body as { Id: string }).Id;
  const started = await engine.request({
    method: "POST",
    path: `/exec/${id}/start`,
    body: { Detach: false, Tty: true },
    ok: [200],
    timeoutMs: 60_000,
    endpoint: "exec.start",
  });
  return started.text;
}

/**
 * From inside the box: `reached <status>` when an HTTP answer came back,
 * `blocked <error>` when the connection failed or timed out.
 */
async function probe(containerId: string, url: string): Promise<string> {
  const script = `try { const r = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(8000), redirect: "manual" }); console.log("reached " + r.status) } catch (e) { console.log("blocked " + (e?.code ?? e?.name)) }`;
  const out = await exec(containerId, ["bun", "-e", script]);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("reached") || l.startsWith("blocked"));
  if (line === undefined) throw new Error(`probe of ${url} printed no verdict: ${out}`);
  return line;
}

/**
 * The same probe through the desktop's Chromium (#92, decision 0026): open
 * `url` in a new tab over CDP (loopback, port 9222), and answer `reached` when
 * the tab's title matches `title` (the page itself loaded), else
 * `blocked <title>` (Chromium's error page) once 15 s have passed.
 */
async function browserProbe(containerId: string, url: string, title: RegExp): Promise<string> {
  const script = `
const base = "http://127.0.0.1:9222";
const want = new RegExp(${JSON.stringify(title.source)});
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(base + "/json/version")).ok) break } catch {}
  await Bun.sleep(500);
}
const tab = await (await fetch(base + "/json/new?" + encodeURIComponent(${JSON.stringify(url)}), { method: "PUT" })).json();
let seen = "";
for (let i = 0; i < 30 && !want.test(seen); i++) {
  await Bun.sleep(500);
  const list = await (await fetch(base + "/json/list")).json();
  seen = list.find((t) => t.id === tab.id)?.title ?? "(tab gone)";
}
await fetch(base + "/json/close/" + tab.id);
console.log(want.test(seen) ? "reached" : "blocked " + seen);
`;
  const out = await exec(containerId, ["bun", "-e", script]);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("reached") || l.startsWith("blocked"));
  if (line === undefined) throw new Error(`browser probe of ${url} printed no verdict: ${out}`);
  return line;
}

/** The host's address on its own uplink: not loopback, not a Docker bridge or veth. */
function hostAddress(): string {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/^(lo|docker|br-|hbx|veth|hlan)/.test(name)) continue;
    const v4 = addresses?.find((a) => a.family === "IPv4" && !a.internal);
    if (v4 !== undefined) return v4.address;
  }
  throw new Error("the host has no external IPv4 address");
}

describe.skipIf(!enabled)("echo and egress through a hub on production defaults", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;
  let hostService: ReturnType<typeof Bun.serve> | undefined;
  let containerId: string | undefined;
  let gateway = "";
  const spec: BoxSpec = {
    boxId: "echo",
    workspaceId: "ws_default",
    sessionId: "se_echo",
    image,
  };

  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    hostService?.stop(true);
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("the hub starts a box, the box dials its box listener, and echo comes back", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-echo-docker-"));
    // Production defaults: no hostname (loopback), the configured box port,
    // and (filtered) the default egress check, the firewall script's marker.
    hub = startHub({
      port: 0,
      boxPort,
      provider,
      ...(egress === "open" ? { boxEgress: UNRESTRICTED_EGRESS } : {}),
      dbPath: join(dir, "hub.db"),
    });
    expect(hub.server.hostname).toBe("127.0.0.1");
    expect(hub.boxEgress().state).toBe(egress === "open" ? "unrestricted" : "filtered");

    const info = await hub.startBox(LOCAL_PRINCIPAL, spec);
    expect(info.state).toBe("running");
    containerId = info.providerRef;
    gateway = await provider.hubAddress(spec.boxId);
    expect([...hub.boxListeners.keys()]).toEqual([gateway]);
    expect(hub.boxListeners.get(gateway)?.port).toBe(boxPort);
    try {
      await hub.boxes.waitForBox(spec.boxId, CONNECT_DEADLINE_MS);
    } catch (error) {
      throw new Error(`${String(error)}\nbox logs:\n${await logsOf(containerId)}`);
    }

    const params = { message: "hello from the hub", n: 7 };
    expect(await hub.boxes.echo(LOCAL_PRINCIPAL, spec.boxId, params)).toEqual(params);

    // Over HTTP on the loopback API too, the way the M0 demo calls it,
    // signed in (decision 0014).
    const { token } = hub.auth.issueSession(LOCAL_PRINCIPAL);
    const res = await fetch(new URL(`/v1/boxes/${spec.boxId}/echo`, hub.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify("ping"),
      signal: AbortSignal.timeout(10_000),
    });
    expect(await res.json()).toEqual({ ok: true, result: "ping" });
  }, 300_000);

  test(`box egress (${egress}): internet and hub always; host, LAN, metadata only when open`, async () => {
    if (hub === undefined || containerId === undefined) {
      throw new Error("the echo test must pass first");
    }
    expect(lanUrl).toBeDefined();
    const box = containerId;

    // A host service on every interface, the way many host daemons listen.
    hostService = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("host") });
    const host = hostAddress();
    const hostUrl = `http://${host}:${hostService.port}/`;
    // Positive controls from the host: both targets are up.
    expect((await fetch(hostUrl, { signal: AbortSignal.timeout(5_000) })).status).toBe(200);
    expect((await fetch(lanUrl as string, { signal: AbortSignal.timeout(5_000) })).status).toBe(
      200,
    );

    const verdicts = {
      hub: await probe(box, `http://${gateway}:${boxPort}/v1/box/socket`),
      internet: await probe(box, "https://github.com/"),
      publicApi: await probe(box, `http://${gateway}:${hub.url.port}/healthz`),
      hostIp: await probe(box, hostUrl),
      hostViaGateway: await probe(box, `http://${gateway}:${hostService.port}/`),
      lan: await probe(box, lanUrl as string),
      metadata: await probe(box, "http://169.254.169.254/metadata/instance"),
      // The desktop's browser is under the same rules as tools (#92).
      browserInternet: await browserProbe(box, "https://github.com/", /GitHub/),
      browserLan: await browserProbe(box, lanUrl as string, /^Directory listing for/),
    };
    console.log(`egress (${egress}) from ${host}, gateway ${gateway}:`, verdicts);

    // The box listener answers its socket path (426 to a plain GET).
    expect(verdicts.hub).toBe("reached 426");
    expect(verdicts.internet).toStartWith("reached");
    expect(verdicts.browserInternet).toBe("reached");
    // The API is on loopback only: never reachable from a box.
    expect(verdicts.publicApi).toStartWith("blocked");
    if (egress === "open") {
      expect(verdicts.hostIp).toBe("reached 200");
      expect(verdicts.hostViaGateway).toBe("reached 200");
      expect(verdicts.lan).toBe("reached 200");
      expect(verdicts.browserLan).toBe("reached");
    } else {
      expect(verdicts.hostIp).toStartWith("blocked");
      expect(verdicts.hostViaGateway).toStartWith("blocked");
      expect(verdicts.lan).toStartWith("blocked");
      expect(verdicts.browserLan).toStartWith("blocked");
      expect(verdicts.metadata).toStartWith("blocked");
    }
  }, 300_000);
});
