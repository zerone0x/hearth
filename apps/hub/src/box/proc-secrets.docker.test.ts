/**
 * A command in a real box cannot read box-agent's start-up secrets or its
 * memory (#57, decision 0018). The hub starts a box with `DockerBoxProvider`
 * on the box image's real default command; once box-agent has joined, a
 * command run through the tool RPC (the way pi runs one) scans every process
 * in the box through `/proc`, as the box's uid, and reports:
 *
 * - which processes' `environ` or `cmdline` hold the join token (none may:
 *   the entrypoint moved it to a file before tini, Xvnc or box-agent started,
 *   and box-agent deleted the file);
 * - whether box-agent's `environ`, `maps` and `mem` open, and whether
 *   `ptrace(PTRACE_ATTACH)` on it succeeds (none may: it is non-dumpable);
 * - a control: Xvnc's `environ` is readable and holds `HEARTH_BOX_ID`, so the
 *   scan does read other processes and a refusal is not an accident;
 * - the variable names in the desktop Chromium's `environ` (#92): only the
 *   entrypoint's clean set, no `HEARTH_*` from the boot env. The command first
 *   waits for Chromium's CDP, so the browser is up when the scan runs.
 *
 * The token the hub minted is read from the container's config (the host
 * side) and handed to the scan reversed, so the scan's own command line does
 * not contain it.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md); see `tools.docker.test.ts`
 * for the variables and the hub's production defaults.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxSpec, LOCAL_PRINCIPAL } from "@hearth/core";
import { BOX_ENV, DEFAULT_BOX_PORT, type Hub, parsePort, startHub } from "../server";
import { DEFAULT_DOCKER_API_VERSION, DEFAULT_DOCKER_SOCKET } from "./docker/config";
import { DockerEngine } from "./docker/engine";
import { DockerBoxProvider } from "./docker/provider";
import { ToolRpcClient } from "./tool-rpc";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const boxPort = parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT);
const instance = `hearthproc${process.pid}${Math.floor(Math.random() * 1e6)}`;
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

/** The scan, run by python3 in the box as the box's uid. argv[1] is the token reversed. */
const SCAN = String.raw`
import ctypes, json, os, sys
token = sys.argv[1][::-1].encode()
me = {os.getpid(), os.getppid()}
def read(pid, name):
    try:
        with open(f"/proc/{pid}/{name}", "rb") as f:
            return f.read()
    except OSError as e:
        return e.errno
report = {"tokenIn": [], "agent": None, "xvncEnviron": None, "chromiumEnv": None, "tokenFile": os.path.exists("/run/hearth/join-token"), "processes": []}
for entry in os.listdir("/proc"):
    if not entry.isdigit() or int(entry) in me:
        continue
    pid = int(entry)
    cmdline = read(pid, "cmdline")
    if not isinstance(cmdline, bytes):
        continue
    report["processes"].append(os.path.basename(cmdline.split(b"\0")[0].decode(errors="replace")))
    environ = read(pid, "environ")
    for name, data in (("cmdline", cmdline), ("environ", environ)):
        if isinstance(data, bytes) and token in data:
            report["tokenIn"].append(f"{pid}:{name}:{cmdline.split(b'\0')[0].decode(errors='replace')}")
    if b"apps/box-agent/src/main.ts" in cmdline:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
        attached = libc.ptrace(16, pid, None, None)
        ptrace_errno = ctypes.get_errno()
        if attached == 0:
            os.waitpid(pid, 0)
            libc.ptrace(17, pid, None, None)
        def outcome(name):
            data = read(pid, name)
            return "readable" if isinstance(data, bytes) else os.strerror(data)
        report["agent"] = {
            "environ": outcome("environ"),
            "maps": outcome("maps"),
            "mem": "readable" if isinstance(read(pid, "mem"), bytes) else "refused",
            "ptrace": "attached" if attached == 0 else os.strerror(ptrace_errno),
        }
    argv = cmdline.split(b"\0")
    if argv[0].endswith(b"chromium") and b"--remote-debugging-port=9222" in argv and not any(a.startswith(b"--type=") for a in argv):
        report["chromiumEnv"] = sorted(kv.split(b"=", 1)[0].decode() for kv in environ.split(b"\0") if kv) if isinstance(environ, bytes) else os.strerror(environ)
    if cmdline.startswith(b"Xvnc\0"):
        report["xvncEnviron"] = "refused" if not isinstance(environ, bytes) else ("has-box-id" if b"\0HEARTH_BOX_ID=" in b"\0" + environ else "no-box-id")
print(json.dumps(report))
`;

/** Waits up to 60 s for the desktop Chromium's CDP on loopback. */
const WAIT_FOR_CDP = `for _ in $(seq 1 120); do python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=1)" 2>/dev/null && break; sleep 0.5; done`;

/**
 * Variables Debian's `/usr/bin/chromium` wrapper sets itself before it execs
 * the browser (its public API keys, flags, `PWD`): not from the box's
 * environment, so the clean-environment checks set them aside.
 */
const CHROMIUM_WRAPPER_ENV = /^(CHROME_[A-Z_]+|CHROMIUM_FLAGS|GOOGLE_[A-Z_]+|PWD)$/;

interface ScanReport {
  readonly tokenIn: string[];
  readonly agent: {
    readonly environ: string;
    readonly maps: string;
    readonly mem: string;
    readonly ptrace: string;
  } | null;
  readonly xvncEnviron: string | null;
  /** The variable names in the desktop Chromium's environ (#92). */
  readonly chromiumEnv: string[] | string | null;
  readonly tokenFile: boolean;
  /** The program name (argv[0] basename) of each process the scan read. */
  readonly processes: string[];
}

async function containerEnv(containerId: string): Promise<Record<string, string>> {
  const res = await engine.request({
    method: "GET",
    path: `/containers/${containerId}/json`,
    ok: [200],
    timeoutMs: 10_000,
    endpoint: "container.inspect",
  });
  const env = (res.body as { Config?: { Env?: string[] } }).Config?.Env ?? [];
  return Object.fromEntries(
    env.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
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

describe.skipIf(!enabled)("box-agent's secrets through /proc in a real box", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;

  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("a command reads neither the join token nor box-agent's environ or memory", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-proc-docker-"));
    hub = startHub({ port: 0, boxPort, provider, dbPath: join(dir, "hub.db") });
    const spec: BoxSpec = {
      boxId: "procsecrets",
      workspaceId: "ws_default",
      sessionId: "se_procsecrets",
      image,
    };
    const info = await hub.startBox(LOCAL_PRINCIPAL, spec);
    if (info.providerRef === undefined) throw new Error("the box has no container");
    try {
      await hub.boxes.waitForBox(spec.boxId, CONNECT_DEADLINE_MS);
    } catch (error) {
      throw new Error(`${String(error)}\nbox logs:\n${await logsOf(info.providerRef)}`);
    }
    const token = (await containerEnv(info.providerRef))[BOX_ENV.joinToken];
    expect(token).toStartWith("hjt_");

    const client = new ToolRpcClient({ boxes: hub.boxes });
    const ops = client.operations(spec.boxId, "call_proc");
    const out: Buffer[] = [];
    const reversed = [...(token ?? "")].reverse().join("");
    const { exitCode } = await ops.bash.exec(
      `${WAIT_FOR_CDP}\npython3 - '${reversed}' <<'HEARTH_SCAN'\n${SCAN}\nHEARTH_SCAN`,
      "/workspace",
      { onData: (data) => out.push(data), timeout: 60 },
    );
    const text = Buffer.concat(out).toString();
    if (exitCode !== 0) throw new Error(`the scan exited ${exitCode}: ${text}`);
    const report = JSON.parse(text) as ScanReport;
    console.log(`proc scan: ${JSON.stringify(report)}`);

    // The scan saw the box's processes, and could read another process's environ.
    expect(report.processes).toEqual(
      expect.arrayContaining(["tini", "Xvnc", "openbox", "bun", "chromium"]),
    );
    expect(report.xvncEnviron).toBe("has-box-id");
    // The desktop's Chromium (#92, decision 0026) starts from a clean
    // environment: readable to the command, and nothing of the boot env in it.
    const chromiumEnv = Array.isArray(report.chromiumEnv)
      ? report.chromiumEnv.filter((k) => !CHROMIUM_WRAPPER_ENV.test(k))
      : report.chromiumEnv;
    expect(chromiumEnv).toEqual(["DISPLAY", "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "USER"]);
    // No process carries the join token, and its file is gone.
    expect(report.tokenIn).toEqual([]);
    expect(report.tokenFile).toBe(false);
    // box-agent (which holds the per-box credential) is closed to the command.
    expect(report.agent).toEqual({
      environ: "Permission denied",
      maps: "Permission denied",
      mem: "refused",
      ptrace: "Operation not permitted",
    });
    client.close();
  }, 300_000);
});
