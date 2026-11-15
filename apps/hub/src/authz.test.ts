/**
 * `authorize` denials on the hub's handlers (PRD §7 E3, #34).
 *
 * Every handler calls `authorize` before it reads or changes anything, and a
 * denial (including the fail-closed one when the audit log is down) must stop
 * it: no box admitted, no event stored or acked, no RPC sent, no box started.
 * These tests pin each denial branch, and check that the denial is audited.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Action,
  AllowAllAuthorizer,
  type Authorizer,
  type BoxProvider,
  DEFAULT_WORKSPACE_ID,
  type Decision,
  HearthError,
  LOCAL_PRINCIPAL,
  type Principal,
  type Resource,
} from "@hearth/core";
import { PROTOCOL_VERSION } from "@hearth/protocol";
import { createApp } from "./app";
import { AuthService, SESSION_COOKIE } from "./auth";
import { type BoxConnection, BoxConnections, type BoxSocket, CLOSE_CODES } from "./box/connections";
import { type Hub, startHub } from "./server";
import {
  openDatabase,
  SqliteAuditSink,
  SqliteBoxCredentialStore,
  SqliteEventStore,
  SqliteLoginStore,
} from "./store";

const OTHER_WORKSPACE_ID = "ws_other";

const dirs: string[] = [];
const dbs: Database[] = [];
const hubs: Hub[] = [];
const all: BoxConnections[] = [];

afterEach(async () => {
  for (const boxes of all.splice(0)) boxes.shutdown();
  for (const h of hubs.splice(0)) await h.stop();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-authz-"));
  dirs.push(dir);
  return join(dir, "hub.db");
}

/**
 * The real allow-all policy over the real audit sink, except that `denied`
 * actions are refused. The refusal is audited like any other decision, so the
 * double behaves as a stricter policy would.
 */
class DenyingAuthorizer implements Authorizer {
  readonly calls: { action: Action; resource: Resource }[] = [];
  readonly #inner: AllowAllAuthorizer;
  readonly #audit: SqliteAuditSink;
  readonly #denied: ReadonlySet<Action>;

  readonly #allowEverything: boolean;

  /** `allowEverything`: a broken policy that allows even another workspace's resources. */
  constructor(audit: SqliteAuditSink, denied: readonly Action[], allowEverything = false) {
    this.#inner = new AllowAllAuthorizer({ audit });
    this.#audit = audit;
    this.#denied = new Set(denied);
    this.#allowEverything = allowEverything;
  }

  async authorize(principal: Principal, action: Action, resource: Resource): Promise<Decision> {
    this.calls.push({ action, resource });
    if (!this.#denied.has(action) && !this.#allowEverything) {
      return await this.#inner.authorize(principal, action, resource);
    }
    const decision: Decision = this.#denied.has(action)
      ? { allowed: false, policy: "test-deny", reason: "denied by test" }
      : { allowed: true, policy: "test-allow-everything" };
    try {
      await this.#audit.write({
        workspaceId: principal.workspaceId,
        principalId: principal.id,
        principalKind: principal.kind,
        action,
        resource,
        decision,
        at: Date.now(),
      });
    } catch {
      return { allowed: false, policy: "test-deny", reason: "audit unavailable" };
    }
    return decision;
  }
}

/** A `BoxSocket` that records what the hub sent and how it closed the socket. */
class FakeSocket implements BoxSocket {
  readonly sent: Record<string, unknown>[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string | Uint8Array): void {
    if (typeof data !== "string") throw new Error("expected a text frame");
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
  }

  types(): unknown[] {
    return this.sent.map((f) => f["type"]);
  }
}

interface AuditRow {
  workspace_id: string;
  principal_id: string;
  action: string;
  resource_workspace_id: string;
  resource_type: string;
  resource_id: string | null;
  allowed: number | null;
  reason: string | null;
}

/** A `BoxConnections` over a fresh database, with `denied` actions refused. */
function setup(denied: readonly Action[], options: { allowEverything?: boolean } = {}) {
  const db = openDatabase(tempDbPath());
  dbs.push(db);
  db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, 'other', 0)", [
    OTHER_WORKSPACE_ID,
  ]);
  const audit = new SqliteAuditSink(db);
  const authorizer = new DenyingAuthorizer(audit, denied, options.allowEverything === true);
  const events = new SqliteEventStore(db);
  const credentials = new SqliteBoxCredentialStore(db);
  const applied: unknown[] = [];
  const logs: string[] = [];
  const boxes = new BoxConnections({
    authorizer,
    events,
    credentials,
    log: (line) => logs.push(line),
    onApplied: (a) => applied.push(a),
    echoDeadlineMs: 2_000,
  });
  all.push(boxes);
  const auth = new AuthService({ store: new SqliteLoginStore(db) });
  const cookie = `${SESSION_COOKIE}=${auth.issueSession(LOCAL_PRINCIPAL).token}`;

  return {
    db,
    authorizer,
    events,
    credentials,
    boxes,
    applied,
    logs,
    app: createApp({ boxes, auth }),
    cookie,
    auditRows(action?: string): AuditRow[] {
      const rows = db
        .query<AuditRow, []>(
          `SELECT workspace_id, principal_id, action, resource_workspace_id, resource_type,
             resource_id, allowed, reason FROM audit ORDER BY id`,
        )
        .all();
      return action === undefined ? rows : rows.filter((r) => r.action === action);
    },
    count(table: string): number {
      return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
    },
    /** Open a socket and send `frames` in order; resolves once all were handled. */
    async connect(frames: readonly object[]): Promise<{ socket: FakeSocket; conn: BoxConnection }> {
      const socket = new FakeSocket();
      const conn = boxes.open(socket);
      for (const frame of frames) boxes.message(conn, JSON.stringify(frame));
      await conn.queue;
      return { socket, conn };
    },
  };
}

function hello(boxId: string, credential: string, bootId = "boot_1") {
  return {
    type: "hello",
    version: PROTOCOL_VERSION,
    boxId,
    bootId,
    credential,
    state: { sessionId: null, turnId: null, lastDeliveryId: 0 },
  };
}

function turnEvent(sessionId: string, deliveryId: number, bootId = "boot_1") {
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

/** POST /v1/boxes/:boxId/echo as the local UI would. */
async function echoOverHttp(
  t: { app: ReturnType<typeof createApp>; cookie: string },
  boxId: string,
) {
  const res = await t.app.request(`/v1/boxes/${boxId}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: t.cookie },
    body: JSON.stringify({ ping: 1 }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("box.connect denied", () => {
  test("a denied hello gets reject bad-credential and close 4001; the box is not admitted", async () => {
    const t = setup(["box.connect"]);
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: DEFAULT_WORKSPACE_ID },
      "box_a",
      "ses_a",
    );
    const { socket } = await t.connect([hello("box_a", token)]);

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ type: "reject", reason: "bad-credential" });
    // Neither a welcome nor the per-box credential ever reaches the box.
    expect(socket.types()).not.toContain("welcome");
    expect(JSON.stringify(socket.sent)).not.toContain("hbc_");
    expect(socket.closeCode).toBe(CLOSE_CODES.rejected);
    expect(t.boxes.isConnected("box_a")).toBe(false);

    const rows = t.auditRows("box.connect");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      principal_id: "box:box_a",
      resource_type: "box",
      resource_id: "box_a",
      allowed: 0,
      reason: "denied by test",
    });
  });

  test("frames after a denied hello are neither stored nor acked", async () => {
    const t = setup(["box.connect"]);
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: DEFAULT_WORKSPACE_ID },
      "box_a",
      "ses_a",
    );
    const { socket } = await t.connect([hello("box_a", token), turnEvent("ses_a", 1)]);

    expect(socket.types()).toEqual(["reject"]);
    expect(t.count("event")).toBe(0);
    expect(t.applied).toHaveLength(0);
    expect(t.auditRows("event.append")).toHaveLength(0);
  });

  test("an echo to a box whose connect was denied answers 409 and sends nothing", async () => {
    const t = setup(["box.connect"]);
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: DEFAULT_WORKSPACE_ID },
      "box_a",
      "ses_a",
    );
    const { socket } = await t.connect([hello("box_a", token)]);
    const res = await echoOverHttp(t, "box_a");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: { code: "box.not-connected" } });
    expect(socket.types()).toEqual(["reject"]);
  });
});

describe("event.append denied", () => {
  test("a denied frame is not stored or acked, and the socket closes with 4003", async () => {
    const t = setup(["event.append"]);
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: DEFAULT_WORKSPACE_ID },
      "box_a",
      "ses_a",
    );
    const { socket } = await t.connect([hello("box_a", token), turnEvent("ses_a", 1)]);

    expect(socket.types()).toEqual(["welcome"]);
    expect(socket.closeCode).toBe(CLOSE_CODES.applyFailed);
    expect(t.count("event")).toBe(0);
    expect(t.applied).toHaveLength(0);
    expect(await t.events.lastSeq({ workspaceId: DEFAULT_WORKSPACE_ID }, "ses_a")).toBe(0);
    expect(t.boxes.isConnected("box_a")).toBe(false);

    const rows = t.auditRows("event.append");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      principal_id: "box:box_a",
      resource_type: "session",
      resource_id: "ses_a",
      allowed: 0,
      reason: "denied by test",
    });
    // The connect itself was allowed, and audited as such.
    expect(t.auditRows("box.connect")).toMatchObject([{ allowed: 1 }]);
  });

  test("the control: the same frame is stored and acked when event.append is allowed", async () => {
    const t = setup([]);
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: DEFAULT_WORKSPACE_ID },
      "box_a",
      "ses_a",
    );
    const { socket } = await t.connect([hello("box_a", token), turnEvent("ses_a", 1)]);

    expect(socket.types()).toEqual(["welcome", "delivery.ack"]);
    expect(socket.closeCode).toBeUndefined();
    expect(t.count("event")).toBe(1);
    expect(t.auditRows("event.append")).toMatchObject([{ allowed: 1 }]);
  });

  test("fail closed: when the audit log is unavailable, the frame is not stored or acked", async () => {
    const t = setup([]);
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: DEFAULT_WORKSPACE_ID },
      "box_a",
      "ses_a",
    );
    const { socket, conn } = await t.connect([hello("box_a", token)]);
    expect(socket.types()).toEqual(["welcome"]);
    // The audit table rejects every write from here on, so the real
    // AllowAllAuthorizer denies with "audit unavailable".
    t.db.run(
      "CREATE TRIGGER audit_down BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    t.boxes.message(conn, JSON.stringify(turnEvent("ses_a", 1)));
    await conn.queue;

    expect(socket.types()).toEqual(["welcome"]);
    expect(socket.closeCode).toBe(CLOSE_CODES.applyFailed);
    expect(t.count("event")).toBe(0);
    expect(t.applied).toHaveLength(0);
    expect(t.logs.some((l) => l.includes("audit unavailable"))).toBe(true);
  });
});

describe("box.echo denied", () => {
  test("a denied echo answers 403 authz.denied and sends no rpc to the box", async () => {
    const t = setup(["box.echo"]);
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: DEFAULT_WORKSPACE_ID },
      "box_a",
      "ses_a",
    );
    const { socket } = await t.connect([hello("box_a", token)]);
    expect(t.boxes.isConnected("box_a")).toBe(true);

    const res = await echoOverHttp(t, "box_a");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: { code: "authz.denied" } });
    expect(socket.types()).toEqual(["welcome"]);
    expect(socket.closeCode).toBeUndefined();

    const rows = t.auditRows("box.echo");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      principal_id: LOCAL_PRINCIPAL.id,
      resource_type: "box",
      resource_id: "box_a",
      allowed: 0,
      reason: "denied by test",
    });
  });

  test("an echo to a box in another workspace answers 409 and sends no rpc to the box", async () => {
    const t = setup([]);
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: OTHER_WORKSPACE_ID },
      "box_b",
      "ses_b",
    );
    const { socket } = await t.connect([hello("box_b", token)]);
    expect(t.boxes.isConnected("box_b")).toBe(true);
    expect(t.auditRows("box.connect")).toMatchObject([
      { workspace_id: OTHER_WORKSPACE_ID, allowed: 1 },
    ]);

    // LOCAL_PRINCIPAL lives in the default workspace; box_b does not.
    const res = await echoOverHttp(t, "box_b");

    // The answer does not reveal that the box exists in another workspace.
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: { code: "box.not-connected" } });
    expect(socket.types()).toEqual(["welcome"]);
    expect(socket.closeCode).toBeUndefined();
    // `authorize` ran first, as for every handler, and saw the box's workspace:
    // the real policy denied it, and the audit row says so (#50, decision 0022).
    expect(t.authorizer.calls.map((c) => c.action)).toEqual(["box.connect", "box.echo"]);
    expect(t.auditRows("box.echo")).toEqual([
      {
        workspace_id: DEFAULT_WORKSPACE_ID,
        principal_id: LOCAL_PRINCIPAL.id,
        action: "box.echo",
        resource_workspace_id: OTHER_WORKSPACE_ID,
        resource_type: "box",
        resource_id: "box_b",
        allowed: 0,
        reason: "resource is in another workspace",
      },
    ]);
  });

  test("a policy that allows a cross-workspace echo still sends no rpc to the box", async () => {
    // A broken policy that allows everything, even across workspaces: the hub's
    // own check after `authorize` still keeps the echo away from the box.
    const t = setup([], { allowEverything: true });
    const { token } = await t.credentials.issueJoinToken(
      { workspaceId: OTHER_WORKSPACE_ID },
      "box_b",
      "ses_b",
    );
    const { socket } = await t.connect([hello("box_b", token)]);
    const res = await echoOverHttp(t, "box_b");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: { code: "box.not-connected" } });
    expect(socket.types()).toEqual(["welcome"]);
    expect(t.auditRows("box.echo")).toMatchObject([
      { resource_workspace_id: OTHER_WORKSPACE_ID, allowed: 1 },
    ]);
  });

  // A box the caller cannot see answers alike whether it is absent or in
  // another workspace, whatever the policy decides: an unknown id and another
  // workspace's box are indistinguishable (#50, decision 0022). Each audit row
  // still says which workspace `authorize` saw.
  for (const policy of [
    { name: "allow-all", denied: [] as Action[], unknownAllowed: 1, unknownReason: null },
    {
      name: "deny box.echo",
      denied: ["box.echo"] as Action[],
      unknownAllowed: 0,
      unknownReason: "denied by test",
    },
  ]) {
    test(`${policy.name}: an unknown box and another workspace's box get the same answer`, async () => {
      const t = setup(policy.denied);
      const { token } = await t.credentials.issueJoinToken(
        { workspaceId: OTHER_WORKSPACE_ID },
        "box_b",
        "ses_b",
      );
      const { socket } = await t.connect([hello("box_b", token)]);
      expect(t.boxes.isConnected("box_b")).toBe(true);

      const unknown = await echoOverHttp(t, "box_x");
      const elsewhere = await echoOverHttp(t, "box_b");

      // Same status and body, once the id the caller sent is masked.
      const masked = (res: typeof unknown, id: string) => ({
        status: res.status,
        body: JSON.parse(JSON.stringify(res.body).replaceAll(id, "<id>")) as unknown,
      });
      expect(masked(unknown, "box_x")).toEqual(masked(elsewhere, "box_b"));
      expect(unknown.status).toBe(409);
      expect(unknown.body).toMatchObject({ ok: false, error: { code: "box.not-connected" } });
      expect(socket.types()).toEqual(["welcome"]);

      const row = {
        workspace_id: DEFAULT_WORKSPACE_ID,
        principal_id: LOCAL_PRINCIPAL.id,
        action: "box.echo",
        resource_type: "box",
      };
      expect(t.auditRows("box.echo")).toEqual([
        // An unknown box has no binding: checked against the caller's workspace.
        {
          ...row,
          resource_workspace_id: DEFAULT_WORKSPACE_ID,
          resource_id: "box_x",
          allowed: policy.unknownAllowed,
          reason: policy.unknownReason,
        },
        {
          ...row,
          resource_workspace_id: OTHER_WORKSPACE_ID,
          resource_id: "box_b",
          allowed: 0,
          reason:
            policy.denied.length === 0 ? "resource is in another workspace" : "denied by test",
        },
      ]);
    });
  }
});

describe("box.start denied", () => {
  /** A provider that records `start` calls and never runs anything. */
  function recordingProvider() {
    const starts: { boxId: string; env: Readonly<Record<string, string>> }[] = [];
    const provider = {
      name: "recording",
      create: async () => {
        throw new Error("create must not be called");
      },
      start: async (spec: { boxId: string }, boot: { env: Readonly<Record<string, string>> }) => {
        starts.push({ boxId: spec.boxId, env: boot.env });
        return {
          boxId: spec.boxId,
          workspaceId: DEFAULT_WORKSPACE_ID,
          sessionId: "ses_s",
          state: "running" as const,
          image: "unused",
          volumeRef: "none",
          labels: {},
          createdAt: 0,
        };
      },
      stop: async () => "not-found" as const,
      destroy: async () => "not-found" as const,
      snapshot: async () => ({ kind: "not-supported" as const }),
      attach: async () => undefined,
      adopt: async () => [],
    } as unknown as BoxProvider;
    return { provider, starts };
  }

  function hubRows(dbPath: string, query: string): Record<string, unknown>[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query<Record<string, unknown>, []>(query).all();
    } finally {
      db.close();
    }
  }

  const spec = {
    boxId: "box_s",
    workspaceId: DEFAULT_WORKSPACE_ID,
    sessionId: "ses_s",
    image: "unused",
  };

  test("a principal of another workspace is denied: no start, no join token, audited", async () => {
    const dbPath = tempDbPath();
    const h = startHub({ dbPath, port: 0, boxPort: 0, log: () => {} });
    hubs.push(h);
    const { provider, starts } = recordingProvider();
    const stranger: Principal = { ...LOCAL_PRINCIPAL, id: "pr_stranger", workspaceId: "ws_x" };

    const error = await h.launchBox(stranger, provider, spec, h.listenForBoxes("127.0.0.1")).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("authz.denied");
    expect(starts).toHaveLength(0);
    expect(hubRows(dbPath, "SELECT * FROM box_join_token")).toHaveLength(0);
    expect(
      hubRows(
        dbPath,
        `SELECT principal_id, action, resource_workspace_id, resource_id, allowed, reason
         FROM audit WHERE action = 'box.start'`,
      ),
    ).toEqual([
      {
        principal_id: "pr_stranger",
        action: "box.start",
        resource_workspace_id: DEFAULT_WORKSPACE_ID,
        resource_id: "box_s",
        allowed: 0,
        reason: "resource is in another workspace",
      },
    ]);
  });

  test("the control: the owner's launch starts the box with a join token", async () => {
    const dbPath = tempDbPath();
    const h = startHub({ dbPath, port: 0, boxPort: 0, log: () => {} });
    hubs.push(h);
    const { provider, starts } = recordingProvider();

    await h.launchBox(LOCAL_PRINCIPAL, provider, spec, h.listenForBoxes("127.0.0.1"));

    expect(starts).toHaveLength(1);
    expect(starts[0]?.env["HEARTH_JOIN_TOKEN"]).toStartWith("hjt_");
    expect(hubRows(dbPath, "SELECT * FROM box_join_token")).toHaveLength(1);
  });
});
