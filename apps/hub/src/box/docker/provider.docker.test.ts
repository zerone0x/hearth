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

/**
 * Run in the box (python3, as the box's uid): waits up to 60 s for the
 * desktop's Chromium (the browser process: CDP flags, no `--type=`) and its
 * CDP `/json/version` on 127.0.0.1:9222, then reports the process's uids,
 * environment variable names and flags, whether every CDP listener is on
 * loopback, and which Chromium processes hold argv[1] (the join token).
 */
const CHROMIUM_SCAN = String.raw`
import json, os, sys, time, urllib.request
token = sys.argv[1].encode()
def read(pid, name):
    try:
        with open(f"/proc/{pid}/{name}", "rb") as f:
            return f.read()
    except OSError:
        return b""
def browser():
    for e in os.listdir("/proc"):
        if e.isdigit():
            argv = read(e, "cmdline").split(b"\0")
            if argv and argv[0].endswith(b"chromium") and any(a.startswith(b"--remote-debugging-port=") for a in argv) and not any(a.startswith(b"--type=") for a in argv):
                return int(e), [a.decode() for a in argv[1:] if a]
    return None, []
version = None
for _ in range(120):
    pid, flags = browser()
    try:
        version = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2))
    except Exception:
        version = None
    if pid and version:
        break
    time.sleep(0.5)
uids = [l.split()[1:] for l in read(pid, "status").decode().splitlines() if l.startswith("Uid:")] if pid else []
env = [kv.split(b"=", 1)[0].decode() for kv in read(pid, "environ").split(b"\0") if kv] if pid else []
token_in = []
for e in os.listdir("/proc"):
    if e.isdigit() and b"chromium" in read(e, "cmdline").split(b"\0")[0]:
        if token in read(e, "environ") or token in read(e, "cmdline"):
            token_in.append(e)
port = "%04X" % 9222
listeners = []
for table in ("tcp", "tcp6"):
    for line in read("self", "net/" + table).decode().splitlines()[1:]:
        f = line.split()
        if f[3] == "0A" and f[1].endswith(":" + port):
            listeners.append(f[1].split(":")[0])
loopback = lambda a: (len(a) == 8 and a.endswith("7F")) or a == "00000000000000000000000001000000"
print(json.dumps({
    "browser": (version or {}).get("Browser"),
    "pid": pid,
    "uids": uids[0] if uids else [],
    "envKeys": sorted(env),
    "flags": flags,
    "tokenIn": token_in,
    "loopbackOnly": bool(listeners) and all(loopback(a) for a in listeners),
}))
`;

/**
 * Variables Debian's `/usr/bin/chromium` wrapper sets itself before it execs
 * the browser (its public API keys, flags, `PWD`): not from the box's
 * environment, so the clean-environment checks set them aside.
 */
const CHROMIUM_WRAPPER_ENV = /^(CHROME_[A-Z_]+|CHROMIUM_FLAGS|GOOGLE_[A-Z_]+|PWD)$/;

interface DesktopChromium {
  readonly browser: string | null;
  readonly pid: number | null;
  readonly uids: string[];
  readonly envKeys: string[];
  readonly flags: string[];
  readonly tokenIn: string[];
  readonly loopbackOnly: boolean;
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

  test("Chromium's own sandbox cannot start under the box's sandbox (decision 0026)", async () => {
    const info = await provider.attach("a");
    const page = await exec(info?.providerRef as string, [
      "timeout",
      "60",
      "chromium",
      "--headless",
      "--disable-gpu",
      "--user-data-dir=/tmp/sandbox-probe",
      "--dump-dom",
      "data:text/html,<p>hearth-sandboxed</p>",
    ]);
    console.log(`chromium with its sandbox: exit ${page.code}: ${page.out.slice(0, 400)}`);
    expect(page.out).not.toContain("hearth-sandboxed");
    expect(page.code).not.toBe(0);
  }, 120_000);

  test("the desktop's Chromium: CDP on loopback, uid 1000, a clean environment, restarted when it exits", async () => {
    const ref = (await provider.attach("a"))?.providerRef as string;
    const scan = async (): Promise<DesktopChromium> => {
      const res = await exec(ref, ["python3", "-c", CHROMIUM_SCAN, "join-a"]);
      const line = res.out.split(/\r?\n/).find((l) => l.startsWith("{"));
      if (line === undefined) throw new Error(`the scan printed no report: ${res.out}`);
      return JSON.parse(line) as DesktopChromium;
    };
    const first = await scan();
    console.log(`desktop chromium: ${JSON.stringify(first)}`);
    expect(first.browser).toMatch(/Chrom/);
    expect(first.pid).toBeGreaterThan(1);
    expect(first.uids).toEqual(["1000", "1000", "1000", "1000"]);
    expect(first.loopbackOnly).toBe(true);
    // Only the variables the entrypoint hands it: nothing from the boot env.
    expect(first.envKeys.filter((k) => !CHROMIUM_WRAPPER_ENV.test(k))).toEqual([
      "DISPLAY",
      "HOME",
      "LANG",
      "LOGNAME",
      "PATH",
      "SHELL",
      "USER",
    ]);
    expect(first.tokenIn).toEqual([]);
    expect(first.flags).toEqual(
      expect.arrayContaining(["--remote-debugging-address=127.0.0.1", "--no-sandbox"]),
    );
    expect(first.flags.some((f) => f.startsWith("--user-data-dir=/home/hearth/"))).toBe(true);

    // Closed (SIGTERM, as a window close or the agent would end it): the
    // supervisor starts a new one, and CDP answers again.
    await exec(ref, ["kill", String(first.pid)]);
    let second = await scan();
    for (let i = 0; i < 20 && second.pid === first.pid; i++) {
      await Bun.sleep(500);
      second = await scan();
    }
    expect(second.pid).not.toBe(first.pid);
    expect(second.browser).toMatch(/Chrom/);
    const log = await exec(ref, ["cat", "/tmp/chromium.log"]);
    expect(log.out).toContain("chromium exited");
  }, 180_000);

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
