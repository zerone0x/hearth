/**
 * Hub-box connection end to end, without Docker (#7): the hub runs in this
 * process, box-agent runs as a child process and dials it.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PRINCIPAL } from "@hearth/core";
import { BoxAgent } from "../../../box-agent/src/connection";
import { type Hub, startHub } from "../server";
import type { AppliedDelivery } from "./connections";

const AGENT_MAIN = join(import.meta.dir, "../../../box-agent/src/main.ts");
const STREAM_AGENT = join(import.meta.dir, "../../../box-agent/src/testdata/stream-agent.ts");
/** Deadline for one step of a test (a connect, an exit, a stream). */
const STEP_MS = 15_000;

interface Child {
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly lines: string[];
  readonly stderr: Promise<string>;
  waitForLine(match: (line: string) => boolean): Promise<string>;
}

const children: Child[] = [];
const hubs: Hub[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.proc.kill("SIGKILL");
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-conn-"));
  dirs.push(dir);
  return join(dir, "hub.db");
}

function hub(
  dbPath: string,
  options: {
    port?: number;
    onApplied?: (a: AppliedDelivery) => void;
    echoDeadlineMs?: number;
    log?: (line: string) => void;
  } = {},
) {
  const started = startHub({ dbPath, port: options.port ?? 0, log: () => {}, ...options });
  hubs.push(started);
  return started;
}

function spawn(script: string, env: Record<string, string>): Child {
  const proc = Bun.spawn([process.execPath, script], {
    // Hermetic: only what the box would get, plus PATH for Bun itself.
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: string[] = [];
  const listeners = new Set<() => void>();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts);
      for (const wake of [...listeners]) wake();
    }
  })();
  const child: Child = {
    proc,
    lines,
    stderr: new Response(proc.stderr).text(),
    waitForLine(match) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = lines.find(match);
          if (found === undefined) return false;
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`no matching line within ${STEP_MS} ms; got ${JSON.stringify(lines)}`));
        }, STEP_MS);
        if (!check()) listeners.add(check);
      });
    },
  };
  children.push(child);
  return child;
}

function agentEnv(h: Hub, boxId: string, token: string): Record<string, string> {
  return { HEARTH_HUB_URL: h.boxSocketUrl, HEARTH_BOX_ID: boxId, HEARTH_JOIN_TOKEN: token };
}

async function exitOf(child: Child): Promise<{ code: number; stderr: string }> {
  const timer = setTimeout(() => child.proc.kill("SIGKILL"), STEP_MS);
  const code = await child.proc.exited;
  clearTimeout(timer);
  return { code, stderr: await child.stderr };
}

function auditActions(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ action: string }, []>("SELECT action FROM audit ORDER BY id")
      .all()
      .map((r) => r.action);
  } finally {
    db.close();
  }
}

describe("join and echo", () => {
  test("a box joins with its token and answers echo over HTTP", async () => {
    const dbPath = tempDb();
    const h = hub(dbPath);
    const { token } = await h.issueJoinToken("box_echo", "ses_echo");
    const agent = spawn(AGENT_MAIN, agentEnv(h, "box_echo", token));
    await h.boxes.waitForBox("box_echo", STEP_MS);

    const res = await fetch(new URL("/v1/boxes/box_echo/echo", h.url), {
      method: "POST",
      body: JSON.stringify({ message: "hello box", n: [1, 2, 3] }),
      signal: AbortSignal.timeout(STEP_MS),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      result: { message: "hello box", n: [1, 2, 3] },
    });

    // authorize ran (and was audited) for the connect and for the echo.
    expect(auditActions(dbPath)).toEqual(["box.connect", "box.echo"]);

    // Only the token's hash is stored.
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<{ token_hash: string; used_at: number | null }, []>(
        "SELECT token_hash, used_at FROM box_join_token",
      )
      .all();
    const credentials = db
      .query<{ credential_hash: string }, []>("SELECT credential_hash FROM box_credential")
      .all();
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(rows[0]?.used_at).not.toBeNull();
    expect(credentials).toHaveLength(1);
    expect(await Bun.file(dbPath).text()).not.toContain(token);

    agent.proc.kill("SIGTERM");
    expect((await exitOf(agent)).code).toBe(0);
  }, 30_000);

  test("echo to a box that is not connected answers 409 box.not-connected", async () => {
    const h = hub(tempDb());
    const res = await fetch(new URL("/v1/boxes/box_nobody/echo", h.url), {
      method: "POST",
      body: JSON.stringify("hi"),
      signal: AbortSignal.timeout(STEP_MS),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: { code: string; owner: string } };
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: "box.not-connected", owner: "box" });
  });

  test("a box launched through a BoxProvider dials in with its boot env", async () => {
    const h = hub(tempDb());
    // A BoxProvider whose "runtime" is a box-agent child process: the same
    // path the Docker provider takes, minus the container.
    let started: Child | undefined;
    const provider = processProvider((env) => {
      started = spawn(AGENT_MAIN, env);
    });
    await h.launchBox(
      LOCAL_PRINCIPAL,
      provider,
      { boxId: "box_prov", workspaceId: "ws_default", sessionId: "ses_prov", image: "unused" },
      h.boxSocketUrl,
    );
    expect(started).toBeDefined();
    await h.boxes.waitForBox("box_prov", STEP_MS);
    expect(await h.boxes.echo(LOCAL_PRINCIPAL, "box_prov", { ping: true })).toEqual({ ping: true });
  }, 30_000);
});

function processProvider(run: (env: Record<string, string>) => void) {
  const info = (boxId: string) => ({
    boxId,
    workspaceId: "ws_default",
    sessionId: "ses_prov",
    state: "running" as const,
    image: "unused",
    volumeRef: "none",
    labels: {},
    createdAt: 0,
  });
  return {
    name: "process",
    create: async (spec: { boxId: string }) => info(spec.boxId),
    start: async (spec: { boxId: string }, boot: { env: Readonly<Record<string, string>> }) => {
      run({ ...boot.env });
      return info(spec.boxId);
    },
    stop: async () => "not-found" as const,
    destroy: async () => "not-found" as const,
    snapshot: async () => ({ kind: "not-supported" as const }),
    attach: async () => undefined,
    adopt: async () => [],
  };
}

describe("join tokens", () => {
  test("a reused join token is rejected with bad-credential", async () => {
    const h = hub(tempDb());
    const { token } = await h.issueJoinToken("box_reuse", "ses_reuse");
    const first = spawn(AGENT_MAIN, agentEnv(h, "box_reuse", token));
    await h.boxes.waitForBox("box_reuse", STEP_MS);
    first.proc.kill("SIGTERM");
    await exitOf(first);

    const second = spawn(AGENT_MAIN, agentEnv(h, "box_reuse", token));
    const { code, stderr } = await exitOf(second);
    expect(code).toBe(3);
    expect(stderr).toContain("the hub refused this box (bad-credential)");
    expect(h.boxes.isConnected("box_reuse")).toBe(false);
  }, 30_000);

  test("a box without a hub URL exits with a clear message", async () => {
    const child = spawn(AGENT_MAIN, {});
    const { code, stderr } = await exitOf(child);
    expect(code).toBe(2);
    expect(stderr).toContain("HEARTH_HUB_URL and HEARTH_BOX_ID must be set");
  });
});

describe("protocol version", () => {
  test("a hello from another major gets a version-mismatch reject naming both versions", async () => {
    const h = hub(tempDb());
    const ws = new WebSocket(h.boxSocketUrl);
    const messages: string[] = [];
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    ws.addEventListener("message", (e) => messages.push(String(e.data)));
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    // A v2 hello may have any other shape; only type and version are frozen.
    ws.send(JSON.stringify({ type: "hello", version: { major: 2, minor: 3 }, whatever: 1 }));
    expect(await closed).toBe(4001);
    expect(messages).toHaveLength(1);
    const reject = JSON.parse(messages[0] ?? "{}");
    expect(reject).toMatchObject({
      type: "reject",
      reason: "version-mismatch",
      hubVersion: { major: 1, minor: 0 },
      boxVersion: { major: 2, minor: 3 },
    });
    expect(reject.message).toContain("2.3");
    expect(reject.message).toContain("1.0");
  });

  test("a box-agent speaking another major stops with the hub's message", async () => {
    const h = hub(tempDb());
    const { token } = await h.issueJoinToken("box_v2", "ses_v2");
    const agent = new BoxAgent({
      hubUrl: h.boxSocketUrl,
      boxId: "box_v2",
      joinToken: token,
      version: { major: 2, minor: 0 },
      log: () => {},
    });
    agent.start();
    const exit = await agent.done;
    expect(exit).toMatchObject({ kind: "rejected", reason: "version-mismatch" });
    expect(exit.kind === "rejected" && exit.message).toContain("major versions must match");
  });

  test("a first frame that is not hello is rejected as malformed-hello", async () => {
    const h = hub(tempDb());
    const ws = new WebSocket(h.boxSocketUrl);
    const messages: string[] = [];
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    ws.addEventListener("message", (e) => messages.push(String(e.data)));
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    ws.send(JSON.stringify({ type: "ping", nonce: 1 }));
    expect(await closed).toBe(4001);
    expect(JSON.parse(messages[0] ?? "{}")).toMatchObject({ reason: "malformed-hello" });
  });
});

describe("at-least-once across a hub restart", () => {
  test("killing the hub mid-stream loses and duplicates nothing", async () => {
    const COUNT = 120;
    /** The hub dies right after applying this delivery, before acking it. */
    const KILL_AFTER = 40;
    const dbPath = tempDb();
    const applied: AppliedDelivery[] = [];
    let killed: Promise<void> | undefined;
    const first = hub(dbPath, {
      onApplied: (a) => {
        applied.push(a);
        if (applied.length === KILL_AFTER) killed = first.stop();
      },
    });
    const port = Number(first.url.port);
    const { token } = await first.issueJoinToken("box_stream", "ses_stream");
    const agent = spawn(STREAM_AGENT, {
      ...agentEnv(first, "box_stream", token),
      STREAM_SESSION_ID: "ses_stream",
      STREAM_COUNT: String(COUNT),
      STREAM_INTERVAL_MS: "3",
    });

    while (killed === undefined) await Bun.sleep(5);
    await killed;
    expect(applied.length).toBe(KILL_AFTER);

    // Restart on the same port and database; the box reconnects with its
    // per-box credential (the join token is spent) and redelivers.
    const restarted: AppliedDelivery[] = [];
    const second = hub(dbPath, { port, onApplied: (a) => restarted.push(a) });
    await agent.waitForLine((l) => l.includes('"all-acked"'));

    const page = await second.events.read({ workspaceId: "ws_default" }, "ses_stream", 0, 1000);
    expect(page.events.map((e) => e.seq)).toEqual(range(COUNT));
    expect(page.events.map((e) => e.delivery?.deliveryId)).toEqual(range(COUNT));
    expect(page.events.map((e) => (e.payload as { seq: number }).seq)).toEqual(range(COUNT));
    expect(new Set(page.events.map((e) => e.delivery?.bootId)).size).toBe(1);
    // Delivery KILL_AFTER was applied but never acked, so it came back and
    // the idempotent apply turned it into a no-op.
    expect(restarted.some((a) => a.duplicate && a.deliveryId === KILL_AFTER)).toBe(true);
    expect(restarted.filter((a) => !a.duplicate).length).toBe(COUNT - KILL_AFTER);
    const last = JSON.parse(agent.lines.find((l) => l.includes("all-acked")) ?? "{}");
    expect(last.connects).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

// -- a raw box: a plain WebSocket that speaks the protocol by hand -----------

/** How long a raw socket waits for the hub to close it. */
const CLOSE_WAIT_MS = 3_000;

interface RawFrame {
  readonly type?: unknown;
  readonly [key: string]: unknown;
}

interface RawBox {
  readonly ws: WebSocket;
  readonly frames: RawFrame[];
  send(frame: RawFrame): void;
  /** The close code, or `"still open"` when the hub did not close within `CLOSE_WAIT_MS`. */
  closed(): Promise<number | "still open">;
  /** Resolves with the first received frame that matches. */
  frame(match: (f: RawFrame) => boolean): Promise<RawFrame>;
}

async function rawSocket(h: Hub): Promise<RawBox> {
  const ws = new WebSocket(h.boxSocketUrl);
  const frames: RawFrame[] = [];
  const listeners = new Set<() => void>();
  let closeCode: number | undefined;
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") frames.push(JSON.parse(e.data));
    for (const wake of [...listeners]) wake();
  });
  ws.addEventListener("close", (e) => {
    closeCode = e.code;
    for (const wake of [...listeners]) wake();
  });
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  const until = <T>(get: () => T | undefined, ms: number, onTimeout: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const value = get();
        if (value === undefined) return;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        try {
          resolve(onTimeout());
        } catch (error) {
          reject(error);
        }
      }, ms);
      listeners.add(check);
      check();
    });
  return {
    ws,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    closed: () =>
      until<number | "still open">(
        () => closeCode,
        CLOSE_WAIT_MS,
        () => "still open",
      ),
    frame: (match) =>
      until(
        () => frames.find(match),
        STEP_MS,
        () => {
          throw new Error(`no matching frame; got ${JSON.stringify(frames)}`);
        },
      ),
  };
}

function hello(boxId: string, credential: string, bootId = "boot_raw"): RawFrame {
  return {
    type: "hello",
    version: { major: 1, minor: 0 },
    boxId,
    bootId,
    credential,
    state: { sessionId: null, turnId: null, lastDeliveryId: 0 },
  };
}

/** A raw box that sent `hello` and got `welcome`. */
async function rawJoin(h: Hub, boxId: string, credential: string, bootId = "boot_raw") {
  const box = await rawSocket(h);
  box.send(hello(boxId, credential, bootId));
  const answer = await box.frame((f) => f.type === "welcome" || f.type === "reject");
  expect(answer.type).toBe("welcome");
  return { box, credential: (answer["credential"] as string | undefined) ?? credential };
}

function turnEvent(sessionId: string, deliveryId: number, bootId = "boot_raw"): RawFrame {
  return {
    type: "turn.event",
    bootId,
    deliveryId,
    sessionId,
    turnId: "turn_1",
    seq: deliveryId,
    event: { kind: "text", text: `event ${deliveryId}` },
  };
}

const isAck = (f: RawFrame) => f.type === "delivery.ack";
const ackedIds = (box: RawBox) => box.frames.filter(isAck).map((f) => f["deliveryId"]);

async function stored(h: Hub, sessionId: string): Promise<number> {
  return (await h.events.read({ workspaceId: "ws_default" }, sessionId, 0, 100)).events.length;
}

describe("applying box frames", () => {
  test("every applied frame is authorized as event.append, and audited", async () => {
    const dbPath = tempDb();
    const h = hub(dbPath);
    const { token } = await h.issueJoinToken("box_audit", "ses_audit");
    const { box } = await rawJoin(h, "box_audit", token);
    box.send(turnEvent("ses_audit", 1));
    box.send(turnEvent("ses_audit", 2));
    await box.frame((f) => isAck(f) && f["deliveryId"] === 2);
    expect(ackedIds(box)).toEqual([1, 2]);
    expect(auditActions(dbPath)).toEqual(["box.connect", "event.append", "event.append"]);
    expect(await stored(h, "ses_audit")).toBe(2);
  });

  test("a frame for another session is not acked or stored, and the socket closes 4003", async () => {
    const h = hub(tempDb());
    const { token } = await h.issueJoinToken("box_bound", "ses_bound");
    const { box } = await rawJoin(h, "box_bound", token);
    box.send(turnEvent("ses_someone_else", 1));
    expect(await box.closed()).toBe(4003);
    expect(ackedIds(box)).toEqual([]);
    expect(await stored(h, "ses_someone_else")).toBe(0);
    expect(await stored(h, "ses_bound")).toBe(0);
  });

  test("a frame stamped with another boot id is not acked or stored, and the socket closes 4003", async () => {
    const h = hub(tempDb());
    const { token } = await h.issueJoinToken("box_boot", "ses_boot");
    const { box } = await rawJoin(h, "box_boot", token, "boot_current");
    box.send(turnEvent("ses_boot", 1, "boot_stale"));
    expect(await box.closed()).toBe(4003);
    expect(ackedIds(box)).toEqual([]);
    expect(await stored(h, "ses_boot")).toBe(0);
  });

  test("a second socket for the same box closes the first with 4002", async () => {
    const h = hub(tempDb());
    const { token } = await h.issueJoinToken("box_twice", "ses_twice");
    const first = await rawJoin(h, "box_twice", token);
    const second = await rawJoin(h, "box_twice", first.credential);
    expect(await first.box.closed()).toBe(4002);
    expect(h.boxes.isConnected("box_twice")).toBe(true);
    // The new socket is the live one: its frames are applied and acked.
    second.box.send(turnEvent("ses_twice", 1));
    await second.box.frame(isAck);
  });

  test("junk and oversized frames after the handshake are dropped and logged, not acked", async () => {
    const lines: string[] = [];
    const h = hub(tempDb(), { log: (l) => lines.push(l) });
    const { token } = await h.issueJoinToken("box_junk", "ses_junk");
    const { box } = await rawJoin(h, "box_junk", token);
    box.ws.send(new Uint8Array([0xff, 0x00, 0x13, 0x37]));
    // Oversized: a turn id far past MAX_ID_LENGTH.
    box.send({ ...turnEvent("ses_junk", 1), turnId: "t".repeat(10_000) });
    box.send(turnEvent("ses_junk", 2));
    await box.frame(isAck);
    expect(ackedIds(box)).toEqual([2]);
    expect(lines.filter((l) => l.includes("dropped an undecodable frame"))).toHaveLength(2);
    expect(await stored(h, "ses_junk")).toBe(1);
  });
});

describe("hostile handshakes", () => {
  async function refused(h: Hub, first: RawFrame | Uint8Array): Promise<RawFrame[]> {
    const box = await rawSocket(h);
    if (first instanceof Uint8Array) box.ws.send(first);
    else box.send(first);
    expect(await box.closed()).toBe(4001);
    return box.frames;
  }

  test("an expired join token is rejected with bad-credential", async () => {
    const h = hub(tempDb());
    const { token } = await h.issueJoinToken("box_late", "ses_late", 1);
    await Bun.sleep(20);
    const frames = await refused(h, hello("box_late", token));
    expect(frames[0]).toMatchObject({ type: "reject", reason: "bad-credential" });
    expect(h.boxes.isConnected("box_late")).toBe(false);
  });

  test("box A's join token presented by box B is rejected", async () => {
    const h = hub(tempDb());
    const { token } = await h.issueJoinToken("box_a", "ses_a");
    const frames = await refused(h, hello("box_b", token));
    expect(frames[0]).toMatchObject({ type: "reject", reason: "bad-credential" });
    expect(h.boxes.isConnected("box_a")).toBe(false);
    expect(h.boxes.isConnected("box_b")).toBe(false);
  });

  test("a reliable frame before hello is refused and not stored", async () => {
    const h = hub(tempDb());
    await h.issueJoinToken("box_eager", "ses_eager");
    const frames = await refused(h, turnEvent("ses_eager", 1));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "reject", reason: "malformed-hello" });
    expect(await stored(h, "ses_eager")).toBe(0);
  });

  test("binary junk instead of hello is refused", async () => {
    const h = hub(tempDb());
    const frames = await refused(h, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(frames[0]).toMatchObject({ type: "reject" });
  });

  test("an oversized hello is refused", async () => {
    const h = hub(tempDb());
    const { token } = await h.issueJoinToken("box_big", "ses_big");
    const frames = await refused(h, hello("box_big", token + "x".repeat(10_000)));
    expect(frames[0]).toMatchObject({ type: "reject", reason: "malformed-hello" });
    expect(h.boxes.isConnected("box_big")).toBe(false);
  });
});

describe("echo deadline", () => {
  test("a box that never answers gets 504 rpc.deadline once the deadline passes", async () => {
    const DEADLINE_MS = 300;
    const h = hub(tempDb(), { echoDeadlineMs: DEADLINE_MS });
    const { token } = await h.issueJoinToken("box_mute", "ses_mute");
    const { box } = await rawJoin(h, "box_mute", token);
    const started = performance.now();
    const res = await fetch(new URL("/v1/boxes/box_mute/echo", h.url), {
      method: "POST",
      body: JSON.stringify("anyone there?"),
      signal: AbortSignal.timeout(DEADLINE_MS + 2_000),
    });
    const elapsed = performance.now() - started;
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "rpc.deadline" } });
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 1_500);
    // The box got the rpc; it just never answered.
    expect(box.frames.some((f) => f.type === "rpc" && f["method"] === "echo")).toBe(true);
  });
});
