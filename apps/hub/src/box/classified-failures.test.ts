/**
 * Every failure on the hub-box path is classified (#32, PRD §8.1 principles 2
 * and 6): params the protocol cannot carry, a credential store that throws
 * during `hello`, and a body that is not JSON, which is read only after
 * `authorize`. Driven in process, with a fake socket and no box-agent.
 */

import { describe, expect, test } from "bun:test";
import {
  AllowAllAuthorizer,
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  type EventStore,
  HearthError,
  LOCAL_PRINCIPAL,
  MemoryAuditSink,
} from "@hearth/core";
import {
  decodeFrame,
  encodeFrame,
  type Frame,
  MAX_JSON_DEPTH,
  PROTOCOL_VERSION,
} from "@hearth/protocol";
import { createApp } from "../app";
import { AuthService, SESSION_COOKIE } from "../auth";
import { openDatabase, SqliteLoginStore } from "../store";
import { type BoxConnection, BoxConnections, CLOSE_CODES } from "./connections";
import type { BoxBinding, BoxCredentialStore } from "./credentials";
import { ToolRpcClient } from "./tool-rpc";

const BOX = "box_1";
const BINDING: BoxBinding = { workspaceId: DEFAULT_WORKSPACE_ID, boxId: BOX, sessionId: "se_1" };

interface FakeSocket {
  readonly frames: Frame[];
  readonly closes: { code?: number; reason?: string }[];
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

function fakeSocket(): FakeSocket {
  const frames: Frame[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  return {
    frames,
    closes,
    send(data) {
      const decoded = decodeFrame(data);
      if (!decoded.ok)
        throw new Error(`the hub sent an undecodable frame: ${decoded.error.message}`);
      frames.push(decoded.frame);
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
  };
}

/** A store that accepts any credential for `BOX`, unless a method is overridden. */
function store(overrides: Partial<BoxCredentialStore> = {}): BoxCredentialStore {
  return {
    issueJoinToken: async () => {
      throw new Error("not used");
    },
    redeemJoinToken: async () => ({ kind: "issued", binding: BINDING, credential: "hbc_new" }),
    verifyCredential: async () => BINDING,
    ...overrides,
  };
}

function setup(options: { credentials?: BoxCredentialStore; authorizer?: Authorizer } = {}) {
  const audit = new MemoryAuditSink();
  const lines: string[] = [];
  const boxes = new BoxConnections({
    authorizer: options.authorizer ?? new AllowAllAuthorizer({ audit }),
    events: {} as EventStore,
    credentials: options.credentials ?? store(),
    log: (line) => lines.push(line),
    heartbeat: { clock: { every: () => () => {} } },
    echoDeadlineMs: 60_000,
  });
  return { audit, lines, boxes };
}

async function hello(
  boxes: BoxConnections,
  credential = "hjt_token",
): Promise<{ conn: BoxConnection; socket: FakeSocket }> {
  const socket = fakeSocket();
  const conn = boxes.open(socket);
  boxes.message(
    conn,
    encodeFrame({
      type: "hello",
      version: PROTOCOL_VERSION,
      boxId: BOX,
      bootId: "boot_1",
      credential,
      state: { sessionId: null, turnId: null, lastDeliveryId: 0 },
    }) as string,
  );
  await conn.queue;
  return { conn, socket };
}

function sqliteBusy(): Error {
  return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
}

/** An array nested `levels` deep: `[[[...]]]`. */
function nested(levels: number): unknown {
  let value: unknown = [];
  for (let i = 1; i < levels; i++) value = [value];
  return value;
}

function http(boxes: BoxConnections) {
  const auth = new AuthService({ store: new SqliteLoginStore(openDatabase(":memory:")) });
  const cookie = `${SESSION_COOKIE}=${auth.issueSession(LOCAL_PRINCIPAL).token}`;
  const app = createApp({ boxes, auth });
  return async (boxId: string, body: string) => {
    const res = await app.request(`http://localhost/v1/boxes/${boxId}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body,
    });
    return { status: res.status, body: (await res.json()) as { error?: { code?: string } } };
  };
}

describe("a credential store that throws during hello (#32)", () => {
  test("redeemJoinToken throwing SQLITE_BUSY sends reject internal and closes 4001", async () => {
    const { boxes, lines } = setup({
      credentials: store({
        redeemJoinToken: async () => {
          throw sqliteBusy();
        },
      }),
    });
    const { conn, socket } = await hello(boxes, "hjt_token");
    expect(socket.frames.map((f) => (f.type === "reject" ? `reject ${f.reason}` : f.type))).toEqual(
      ["reject internal"],
    );
    expect(socket.closes).toEqual([{ code: CLOSE_CODES.rejected, reason: "internal" }]);
    expect(conn.state).toBe("closed");
    expect(boxes.isConnected(BOX)).toBe(false);
    expect(lines.some((l) => l.includes("database is locked"))).toBe(true);
  });

  test("verifyCredential throwing sends reject internal too", async () => {
    const { boxes } = setup({
      credentials: store({
        verifyCredential: async () => {
          throw new Error("disk I/O error");
        },
      }),
    });
    const { socket } = await hello(boxes, "hbc_credential");
    expect(socket.frames).toEqual([
      expect.objectContaining({ type: "reject", reason: "internal" }),
    ]);
    expect(socket.closes).toEqual([{ code: CLOSE_CODES.rejected, reason: "internal" }]);
  });

  test("an authorizer that throws on box.connect sends reject internal", async () => {
    const { boxes } = setup({
      authorizer: {
        authorize: async () => {
          throw new Error("policy backend down");
        },
      },
    });
    const { socket } = await hello(boxes);
    expect(socket.frames).toEqual([
      expect.objectContaining({ type: "reject", reason: "internal" }),
    ]);
    expect(socket.closes).toEqual([{ code: CLOSE_CODES.rejected, reason: "internal" }]);
  });

  test("a store that works still welcomes the box", async () => {
    const { boxes } = setup();
    const { socket } = await hello(boxes);
    expect(socket.frames.map((f) => f.type)).toEqual(["welcome"]);
    expect(socket.closes).toEqual([]);
  });
});

describe("rpc params the protocol cannot carry (#32)", () => {
  test("echo with JSON deeper than MAX_JSON_DEPTH answers 400 rpc.invalid-params and leaks nothing", async () => {
    const { boxes, audit } = setup();
    const { conn, socket } = await hello(boxes);
    const echo = http(boxes);
    const res = await echo(BOX, JSON.stringify(nested(MAX_JSON_DEPTH + 2)));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("rpc.invalid-params");
    expect(conn.pending.size).toBe(0);
    expect(socket.frames.map((f) => f.type)).toEqual(["welcome"]);
    expect(audit.records.filter((r) => r.action === "box.echo")).toHaveLength(1);
    // A box still answers params it can carry.
    const ok = boxes.echo(LOCAL_PRINCIPAL, BOX, { x: 1 });
    for (let i = 0; i < 100 && socket.frames.length < 2; i++) await Bun.sleep(1);
    const rpc = socket.frames.at(-1);
    if (rpc?.type !== "rpc") throw new Error("no rpc frame sent");
    boxes.message(
      conn,
      encodeFrame({ type: "rpc.result", id: rpc.id, ok: true, result: { x: 1 } }) as string,
    );
    expect(await ok).toEqual({ x: 1 });
  });

  test("rpc rejects with a classified error before anything is pending", async () => {
    const { boxes } = setup();
    const { conn } = await hello(boxes);
    const error = await boxes.rpc(BOX, "echo", Number.NaN, 60_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("rpc.invalid-params");
    expect((error as HearthError).owner).toBe("user");
    expect(conn.pending.size).toBe(0);
  });

  test("sendRpc throws rpc.invalid-params and sends nothing", async () => {
    const { boxes } = setup();
    const { socket } = await hello(boxes);
    let thrown: unknown;
    try {
      boxes.sendRpc(BOX, {
        type: "rpc",
        id: "tool_x",
        method: "tool.glob",
        params: { limit: Infinity },
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as HearthError).code).toBe("rpc.invalid-params");
    expect(socket.frames.map((f) => f.type)).toEqual(["welcome"]);
  });

  test("a tool call with unencodable params rejects with tool.bad-params, never throws", async () => {
    const { boxes } = setup();
    const { socket } = await hello(boxes);
    const client = new ToolRpcClient({ boxes, log: () => {} });
    let result: Promise<unknown> | undefined;
    expect(() => {
      result = client.call(BOX, "call_1", "tool.glob", {
        pattern: "*",
        cwd: "/",
        ignore: [],
        limit: Number.POSITIVE_INFINITY,
      });
    }).not.toThrow();
    const error = await result?.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("tool.bad-params");
    expect(client.pending).toBe(0);
    expect(socket.frames.map((f) => f.type)).toEqual(["welcome"]);
    client.close();
  });
});

describe("the echo body is read after authorize (#32)", () => {
  test("invalid JSON to a connected box is authorized and audited, then answers 400", async () => {
    const { boxes, audit } = setup();
    await hello(boxes);
    const before = audit.records.filter((r) => r.action === "box.echo").length;
    const res = await http(boxes)(BOX, "{not json");
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("request.invalid-json");
    expect(audit.records.filter((r) => r.action === "box.echo")).toHaveLength(before + 1);
  });

  test("a caller who cannot see the box gets the same answer whatever the body", async () => {
    const { boxes } = setup();
    const echo = http(boxes);
    const bad = await echo("box_unknown", "{not json");
    const good = await echo("box_unknown", "{}");
    expect(bad).toEqual(good);
    expect(bad.status).toBe(409);
    expect(bad.body.error?.code).toBe("box.not-connected");
  });

  test("a denied caller gets 403 whatever the body", async () => {
    const audit = new MemoryAuditSink();
    const allow = new AllowAllAuthorizer({ audit });
    const { boxes } = setup({
      authorizer: {
        authorize: (principal, action, resource) =>
          action === "box.echo"
            ? Promise.resolve({ allowed: false, reason: "test policy" } as never)
            : allow.authorize(principal, action, resource),
      },
    });
    await hello(boxes);
    const echo = http(boxes);
    const bad = await echo(BOX, "{not json");
    const good = await echo(BOX, "{}");
    expect(bad).toEqual(good);
    expect(bad.status).toBe(403);
  });
});
