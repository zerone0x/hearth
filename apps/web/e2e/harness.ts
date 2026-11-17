/**
 * A real hub for the web UI's e2e (#46), without Docker or model credits:
 *
 * - `startHub` as `main.ts` runs it, serving the built `apps/web/dist`;
 * - the runner on pi-ai's faux model (decision 0015), scripted per turn;
 * - boxes are real box-agent processes on this machine (like `demo.ts`),
 *   started by the session manager through `LocalBoxProvider`, with their
 *   workspace in a temporary directory;
 * - each box's "Xvnc" is `startFakeVnc`, a minimal RFB 3.8 server that draws
 *   a test picture, so the noVNC panel has a desktop to show.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type BoxId, type BoxInfo, type BoxSpec, createDefaultSecretStore } from "@hearth/core";
import { type BoxNetworkProvider, type Hub, startHub } from "../../hub/src/server";

const BOX_AGENT = join(import.meta.dir, "../../box-agent/src/main.ts");

/** Runs each box as a local box-agent process (no isolation: tests only). */
export class LocalBoxProvider implements BoxNetworkProvider {
  readonly name = "local-e2e";
  readonly #boxes = new Map<BoxId, { spec: BoxSpec; child?: ChildProcess; exitCode?: number }>();

  constructor(
    readonly workspace: string,
    readonly vncPort: number,
    /** More box environment, such as `HEARTH_CDP_PORT` of a test Chromium. */
    readonly env: Readonly<Record<string, string>> = {},
  ) {}

  #info(boxId: BoxId): BoxInfo | undefined {
    const box = this.#boxes.get(boxId);
    if (box === undefined) return undefined;
    const running = box.child !== undefined && box.exitCode === undefined;
    return {
      boxId,
      workspaceId: box.spec.workspaceId,
      sessionId: box.spec.sessionId,
      state: running ? "running" : box.exitCode === undefined ? "stopped" : "exited",
      image: box.spec.image,
      volumeRef: this.workspace,
      labels: {},
      createdAt: 0,
      ...(box.exitCode === undefined ? {} : { exitCode: box.exitCode }),
    };
  }

  async create(spec: BoxSpec): Promise<BoxInfo> {
    if (!this.#boxes.has(spec.boxId)) this.#boxes.set(spec.boxId, { spec });
    return this.#info(spec.boxId) as BoxInfo;
  }

  async hubAddress(): Promise<string> {
    return "127.0.0.1";
  }

  async start(spec: BoxSpec, boot: { env: Readonly<Record<string, string>> }): Promise<BoxInfo> {
    await this.create(spec);
    const box = this.#boxes.get(spec.boxId);
    if (box === undefined) throw new Error("unreachable");
    if (box.child !== undefined && box.exitCode === undefined)
      return this.#info(spec.boxId) as BoxInfo;
    const child = spawn(process.execPath, [BOX_AGENT], {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        ...boot.env,
        ...this.env,
        HEARTH_WORKSPACE: this.workspace,
        HEARTH_VNC_PORT: String(this.vncPort),
      },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    });
    box.child = child;
    delete box.exitCode;
    // A signal leaves `child.exitCode` null, so track the exit here.
    child.on("exit", (code) => {
      box.exitCode = code ?? 137;
    });
    return this.#info(spec.boxId) as BoxInfo;
  }

  async stop(boxId: BoxId): Promise<"stopped" | "already-stopped" | "not-found"> {
    const box = this.#boxes.get(boxId);
    if (box === undefined) return "not-found";
    const child = box.child;
    if (child === undefined || box.exitCode !== undefined) return "already-stopped";
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await exited;
    return "stopped";
  }

  async destroy(boxId: BoxId): Promise<"destroyed" | "not-found"> {
    if ((await this.stop(boxId)) === "not-found") return "not-found";
    this.#boxes.delete(boxId);
    return "destroyed";
  }

  async snapshot() {
    return { kind: "not-supported" } as const;
  }

  async attach(boxId: BoxId): Promise<BoxInfo | undefined> {
    return this.#info(boxId);
  }

  async adopt(): Promise<readonly BoxInfo[]> {
    return [...this.#boxes.keys()].map((id) => this.#info(id) as BoxInfo);
  }

  /** Kill every running box, as a crash or hibernate would end its connection. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#boxes.keys()].map((id) => this.stop(id)));
  }
}

/** What reached the fake Xvnc: key syms pressed, and pointer events. */
export interface FakeVncInput {
  readonly keys: number[];
  pointers: number;
}

/** Width and height of the fake desktop. */
export const FAKE_DESKTOP = { width: 640, height: 400 } as const;

/** The colour of the fake desktop at (x, y): a title bar, a window and a gradient. */
function pixel(x: number, y: number): [number, number, number] {
  if (y < 28) return [40, 44, 52];
  if (x > 80 && x < 560 && y > 70 && y < 330) {
    if (y < 96) return [230, 230, 230];
    return [250, 250, 250];
  }
  return [
    Math.round((x / FAKE_DESKTOP.width) * 80) + 30,
    90,
    Math.round((y / FAKE_DESKTOP.height) * 120) + 100,
  ];
}

/**
 * A minimal RFB 3.8 server, security None, raw encoding: the stand-in for
 * Xvnc behind box-agent's relay. Answers non-incremental update requests
 * with the whole picture and holds incremental ones (nothing changes).
 * Records the key and pointer events that reach it (decision 0033: only
 * while the viewer holds the desktop lock).
 */
export function startFakeVnc(): { port: number; stop(): void; input: FakeVncInput } {
  interface Conn {
    buf: Buffer;
    phase: "version" | "security" | "init" | "normal";
    format: { bpp: number; bigEndian: boolean; shifts: [number, number, number] };
  }
  const input: FakeVncInput = { keys: [], pointers: 0 };
  const server = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = {
          buf: Buffer.alloc(0),
          phase: "version",
          format: { bpp: 32, bigEndian: false, shifts: [16, 8, 0] },
        };
        socket.write("RFB 003.008\n");
      },
      data(socket, chunk) {
        const c = socket.data;
        c.buf = Buffer.concat([c.buf, chunk]);
        for (;;) {
          if (c.phase === "version") {
            if (c.buf.length < 12) return;
            c.buf = c.buf.subarray(12);
            c.phase = "security";
            socket.write(Uint8Array.of(1, 1));
          } else if (c.phase === "security") {
            if (c.buf.length < 1) return;
            c.buf = c.buf.subarray(1);
            c.phase = "init";
            socket.write(Uint8Array.of(0, 0, 0, 0));
          } else if (c.phase === "init") {
            if (c.buf.length < 1) return;
            c.buf = c.buf.subarray(1);
            c.phase = "normal";
            const name = Buffer.from("hearth e2e desktop");
            const init = Buffer.alloc(24 + name.length);
            init.writeUInt16BE(FAKE_DESKTOP.width, 0);
            init.writeUInt16BE(FAKE_DESKTOP.height, 2);
            Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
            init.writeUInt32BE(name.length, 20);
            name.copy(init, 24);
            socket.write(init);
          } else {
            const type = c.buf[0];
            if (type === undefined) return;
            if (type === 0) {
              if (c.buf.length < 20) return;
              c.format = {
                bpp: c.buf[4] as number,
                bigEndian: c.buf[6] !== 0,
                shifts: [c.buf[14] as number, c.buf[15] as number, c.buf[16] as number],
              };
              c.buf = c.buf.subarray(20);
            } else if (type === 2) {
              if (c.buf.length < 4) return;
              const n = c.buf.readUInt16BE(2);
              if (c.buf.length < 4 + 4 * n) return;
              c.buf = c.buf.subarray(4 + 4 * n);
            } else if (type === 3) {
              if (c.buf.length < 10) return;
              const incremental = c.buf[1] !== 0;
              c.buf = c.buf.subarray(10);
              if (!incremental) socket.write(frame(c.format));
            } else if (type === 4) {
              if (c.buf.length < 8) return;
              if (c.buf[1] !== 0) input.keys.push(c.buf.readUInt32BE(4));
              c.buf = c.buf.subarray(8);
            } else if (type === 5) {
              if (c.buf.length < 6) return;
              input.pointers += 1;
              c.buf = c.buf.subarray(6);
            } else {
              socket.end();
              return;
            }
          }
        }
      },
    },
  });
  function frame(format: Conn["format"]): Buffer {
    const { width, height } = FAKE_DESKTOP;
    const out = Buffer.alloc(16 + width * height * 4);
    out.writeUInt8(0, 0);
    out.writeUInt16BE(1, 2);
    out.writeUInt16BE(width, 8);
    out.writeUInt16BE(height, 10);
    out.writeInt32BE(0, 12);
    let at = 16;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = pixel(x, y);
        const value =
          ((r << format.shifts[0]) | (g << format.shifts[1]) | (b << format.shifts[2])) >>> 0;
        if (format.bigEndian) out.writeUInt32BE(value, at);
        else out.writeUInt32LE(value, at);
        at += 4;
      }
    }
    return out;
  }
  return { port: server.port, stop: () => server.stop(true), input };
}

/** The vault's key (decision 0031): the Settings page adds, rotates and deletes real entries. */
const VAULT_KEY = Buffer.alloc(32, 0x5e).toString("base64");

export interface E2eHub {
  readonly hub: Hub;
  readonly url: URL;
  readonly setupToken: string;
  readonly faux: FauxProviderHandle;
  readonly workspace: string;
  readonly boxes: LocalBoxProvider;
  /** Key and pointer events that reached the fake desktop. */
  readonly vncInput: FakeVncInput;
  stop(): Promise<void>;
}

/** Starts the hub on a free loopback port with the UI from `webRoot`. */
/** How long the owner has to decide in the e2e (the hub's default is 10 minutes). */
export const APPROVAL_TIMEOUT_MS = 12_000;

export async function startE2eHub(webRoot: string): Promise<E2eHub> {
  const dir = mkdtempSync(join(tmpdir(), "hearth-web-e2e-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const vnc = startFakeVnc();
  const boxes = new LocalBoxProvider(workspace, vnc.port);
  const faux = fauxProvider({ provider: "faux" });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const logs: string[] = [];
  const hub = startHub({
    port: 0,
    boxPort: 0,
    dbPath: join(dir, "hub.db"),
    webRoot,
    provider: boxes,
    boxEgress: () => ({ state: "unrestricted", detail: "e2e: local processes" }),
    vault: {
      keyRef: "env:HEARTH_E2E_VAULT_KEY",
      keySecrets: createDefaultSecretStore({ env: { HEARTH_E2E_VAULT_KEY: VAULT_KEY } }),
    },
    // No HEARTH_MODEL: the run picks the model, and its vault key, on the Settings page.
    runner: {
      config: {},
      modelRuntime,
      boxCwd: workspace,
    },
    // S3 (decision 0048): short enough that the run sees an approval expire.
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    log: (line) => logs.push(line),
  });
  const setupToken = hub.auth.setupToken();
  if (setupToken === undefined) throw new Error("a fresh hub has a setup token");
  return {
    hub,
    url: new URL(hub.url),
    setupToken,
    faux,
    workspace,
    boxes,
    vncInput: vnc.input,
    async stop() {
      await boxes.stopAll();
      await hub.stop();
      vnc.stop();
      if (process.env["HEARTH_E2E_LOGS"] === "1") console.log(logs.join("\n"));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
