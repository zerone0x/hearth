/**
 * The approval records (decision 0048) over a real SQLite file: a request
 * waits until the owner decides, the timeout expires it, a cancel or a
 * restart ends it; each end is audited and logged once; the owner's route
 * authorizes first, refuses unknown and foreign ids alike, and is idempotent.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AllowAllAuthorizer,
  type AuditSink,
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  type EventStore,
  type HearthError,
  LOCAL_PRINCIPAL,
  type Principal,
} from "@hearth/core";
import { Hono } from "hono";
import { type HubEnv, SESSION_COOKIE } from "../auth";
import { RequestBody } from "../request-body";
import { startHub } from "../server";
import { openDatabase, SqliteApprovalStore, SqliteAuditSink, SqliteEventStore } from "../store";
import { APPROVAL_INTERRUPTED, type ApprovalRequest, Approvals, mountApprovalRoutes } from ".";

const SCOPE = { workspaceId: DEFAULT_WORKSPACE_ID };
const BOX: Principal = Object.freeze({
  id: "pr_box",
  workspaceId: DEFAULT_WORKSPACE_ID,
  kind: "box",
  displayName: "box",
});

let dir: string;
let dbs: Database[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-approvals-"));
  dbs = [];
});
afterEach(() => {
  for (const db of dbs) db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly db: Database;
  readonly approvals: Approvals;
  readonly store: SqliteApprovalStore;
  readonly events: SqliteEventStore;
  readonly logs: string[];
}

function start(
  options: {
    timeoutMs?: number;
    audit?: (db: Database) => AuditSink;
    authorizer?: (audit: AuditSink) => Authorizer;
    db?: Database;
    now?: () => number;
    events?: (events: SqliteEventStore) => EventStore;
  } = {},
): Harness {
  const db = options.db ?? openDatabase(join(dir, "hub.db"));
  if (options.db === undefined) dbs.push(db);
  const audit = options.audit?.(db) ?? new SqliteAuditSink(db);
  const store = new SqliteApprovalStore(db);
  const events = new SqliteEventStore(db);
  const logs: string[] = [];
  let n = 0;
  const approvals = new Approvals({
    store,
    events: options.events?.(events) ?? events,
    audit,
    authorizer: options.authorizer?.(audit) ?? new AllowAllAuthorizer({ audit }),
    timeoutMs: options.timeoutMs ?? 60_000,
    newId: () => `ap_${++n}`,
    log: (line) => logs.push(line),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { db, approvals, store, events, logs };
}

function request(toolCallId = "c_1", sessionId = "se_a"): ApprovalRequest {
  return {
    sessionId,
    toolCallId,
    tool: "bash",
    summary: "git push",
    command: "git push",
    rule: "git-push",
    reason: "git push needs the owner",
    mode: "ask",
    turnId: "tu_1",
  };
}

async function types(h: Harness, sessionId = "se_a"): Promise<string[]> {
  return (await h.events.read(SCOPE, sessionId, 0, 100)).events.map((e) => e.type);
}

/** Audit rows written by the service (not the authorizer's decisions). */
function auditActions(db: Database): string[] {
  return db
    .query<{ action: string }, []>(
      "SELECT action FROM audit WHERE allowed IS NULL AND action LIKE 'approval.%' ORDER BY id",
    )
    .all()
    .map((r) => r.action);
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as HearthError).code ?? "";
}

describe("a request", () => {
  test("waits for the owner; approve releases it, audited and logged before it applies", async () => {
    const h = start();
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    expect(h.store.pending(SCOPE).map((r) => r.id)).toEqual(["ap_1"]);
    const view = await h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", {
      decision: "approve",
    });
    expect(view).toMatchObject({ id: "ap_1", status: "approved", decidedBy: "user:pr_local" });
    const outcome = await waiting;
    expect(outcome).toMatchObject({
      approvalId: "ap_1",
      status: "approved",
      approved: true,
      decidedBy: "user:pr_local",
    });
    expect(h.approvals.hasPending("se_a")).toBe(false);
    expect(await types(h)).toEqual(["approval.requested", "approval.approved"]);
    expect(auditActions(h.db)).toEqual(["approval.request", "approval.approve"]);
    const events = (await h.events.read(SCOPE, "se_a", 0, 100)).events;
    expect(events[0]).toMatchObject({
      turnId: "tu_1",
      payload: { approvalId: "ap_1", toolCallId: "c_1", summary: "git push", rule: "git-push" },
    });
    expect(events[1]?.payload).toMatchObject({ by: "user:pr_local", channel: "web" });
  });

  test("deny blocks with the owner's reason", async () => {
    const h = start();
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    await h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "deny" });
    expect(await waiting).toMatchObject({ status: "denied", approved: false });
    expect((await waiting).reason).toContain("Denied by the owner");
    expect(await types(h)).toEqual(["approval.requested", "approval.denied"]);
  });

  test("no decision before the timeout: expired, denied, once", async () => {
    const h = start({ timeoutMs: 40 });
    const outcome = await h.approvals.request(request());
    expect(outcome).toMatchObject({ status: "expired", approved: false });
    expect(outcome.reason).toContain("no decision within");
    expect(await types(h)).toEqual(["approval.requested", "approval.expired"]);
    expect(h.store.pending(SCOPE)).toEqual([]);
    // A late click finds it closed.
    expect(
      await codeOf(h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" })),
    ).toBe("approval.closed");
  });

  test("a stop (the call's signal) and a new message cancel it", async () => {
    const h = start();
    const controller = new AbortController();
    const first = h.approvals.request(request("c_1"), controller.signal);
    await until(() => h.approvals.hasPending("se_a"));
    controller.abort();
    expect(await first).toMatchObject({ status: "cancelled", approved: false });
    const second = h.approvals.request(request("c_2"));
    await until(() => h.approvals.hasPending("se_a"));
    expect(await h.approvals.cancel("se_b", "new message")).toBe(0);
    expect(await h.approvals.cancel("se_a", "new message")).toBe(1);
    const outcome = await second;
    expect(outcome.reason).toContain("new message");
    const page = await h.events.read(SCOPE, "se_a", 0, 100);
    expect(
      page.events.filter((e) => e.type === "approval.cancelled").map((e) => e.payload),
    ).toMatchObject([{ why: "stopped" }, { why: "new message" }]);
  });

  test("a signal already aborted records nothing and denies", async () => {
    const h = start();
    const controller = new AbortController();
    controller.abort();
    expect(await h.approvals.request(request(), controller.signal)).toMatchObject({
      status: "cancelled",
    });
    expect(await types(h)).toEqual([]);
  });

  test("a stop while the request is still being recorded cancels it at once; it is never approvable", async () => {
    const recording = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = start({
      events: (events) => ({
        append: async (scope, sessionId, event) => {
          if (event.type === "approval.requested") {
            recording.resolve();
            await release.promise;
          }
          return events.append(scope, sessionId, event);
        },
        read: (scope, sessionId, after, limit) => events.read(scope, sessionId, after, limit),
        lastSeq: (scope, sessionId) => events.lastSeq(scope, sessionId),
      }),
    });
    const controller = new AbortController();
    const waiting = h.approvals.request(request(), controller.signal);
    await recording.promise;
    // The stop lands between the start of the record and the wait.
    controller.abort();
    release.resolve();
    const started = Date.now();
    const outcome = await waiting;
    // At once, not at the 60 s timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toMatchObject({ status: "cancelled", approved: false });
    expect(h.approvals.hasPending("se_a")).toBe(false);
    expect(h.store.pending(SCOPE)).toEqual([]);
    expect(await types(h)).toEqual(["approval.requested", "approval.cancelled"]);
    expect(
      await codeOf(h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" })),
    ).toBe("approval.closed");
  });

  test("hasPending is per session: another session's approval is not this one's", async () => {
    const h = start();
    const waiting = h.approvals.request(request("c_1", "se_a"));
    await until(() => h.approvals.hasPending("se_a"));
    expect(h.approvals.hasPending("se_b")).toBe(false);
    await h.approvals.cancel("se_a", "stopped");
    await waiting;
    expect(h.approvals.hasPending("se_a")).toBe(false);
  });

  test("close() (hub stop) denies every waiting call as interrupted, never approved", async () => {
    const h = start();
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    h.approvals.close();
    expect(await waiting).toMatchObject({
      status: "interrupted",
      approved: false,
      reason: APPROVAL_INTERRUPTED,
    });
    expect(h.approvals.hasPending("se_a")).toBe(false);
    // The row stays pending for the next hub's recover().
    expect(h.store.pending(SCOPE).map((r) => r.id)).toEqual(["ap_1"]);
  });

  test("a request that cannot be audited rejects, and nothing is pending", async () => {
    const h = start({
      audit: () => ({
        write: async () => {
          throw new Error("disk full");
        },
      }),
    });
    expect(await codeOf(h.approvals.request(request()))).toBe("audit.write-failed");
    expect(h.approvals.hasPending("se_a")).toBe(false);
    expect(h.store.pending(SCOPE)).toEqual([]);
    expect(await types(h)).toEqual([]);
  });
});

describe("the owner's decision", () => {
  test("authorizes session.approve on the session before reading the body", async () => {
    const seen: string[] = [];
    const h = start({
      authorizer: () => ({
        authorize: async (_p, action, resource) => {
          seen.push(`${action} ${resource.type}:${resource.id}`);
          return { allowed: false, reason: "no", policy: "test" };
        },
      }),
    });
    const spy = { read: false };
    const body = new RequestBody(async () => {
      spy.read = true;
      return { decision: "approve" };
    });
    expect(await codeOf(h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", body))).toBe(
      "authz.denied",
    );
    expect(spy.read).toBe(false);
    expect(seen).toEqual(["session.approve session:se_a"]);
  });

  test("only a person decides: a box principal is refused and the approval stays pending", async () => {
    const h = start();
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    expect(await codeOf(h.approvals.decide(BOX, "se_a", "ap_1", { decision: "approve" }))).toBe(
      "authz.denied",
    );
    expect(h.approvals.hasPending("se_a")).toBe(true);
    expect(h.logs.join("\n")).toContain("box:pr_box tried to decide ap_1");
    await h.approvals.cancel("se_a", "stopped");
    expect((await waiting).status).toBe("cancelled");
  });

  test("a bad body is refused and changes nothing", async () => {
    const h = start();
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    for (const body of [{ decision: "yes" }, {}, { decision: "approve", x: 1 }, [], null]) {
      expect(await codeOf(h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", body))).toBe(
        "request.invalid",
      );
    }
    expect(h.approvals.hasPending("se_a")).toBe(true);
    await h.approvals.cancel("se_a", "stopped");
    await waiting;
  });

  test("an unknown id and another session's id get the same answer; neither changes it", async () => {
    const h = start();
    const waiting = h.approvals.request(request("c_1", "se_b"));
    await until(() => h.approvals.hasPending("se_b"));
    const unknown = await h.approvals
      .decide(LOCAL_PRINCIPAL, "se_a", "ap_9", { decision: "approve" })
      .catch((e: HearthError) => [e.code, e.message.replace("ap_9", "<id>")]);
    const foreign = await h.approvals
      .decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" })
      .catch((e: HearthError) => [e.code, e.message.replace("ap_1", "<id>")]);
    expect(unknown).toEqual(["approval.not-found", "no approval <id>"]);
    expect(foreign).toEqual(unknown);
    expect(h.approvals.hasPending("se_b")).toBe(true);
    expect(await types(h, "se_a")).toEqual([]);
    await h.approvals.decide(LOCAL_PRINCIPAL, "se_b", "ap_1", { decision: "deny" });
    expect((await waiting).status).toBe("denied");
  });

  test("idempotent: the same decision again answers the same; the other one is a 409", async () => {
    const h = start();
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    const [a, b] = await Promise.all([
      h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" }),
      h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" }),
    ]);
    expect(a).toEqual(b);
    expect(
      await codeOf(h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "deny" })),
    ).toBe("approval.closed");
    expect((await waiting).status).toBe("approved");
    // One end, recorded once.
    expect(await types(h)).toEqual(["approval.requested", "approval.approved"]);
    expect(auditActions(h.db)).toEqual(["approval.request", "approval.approve"]);
  });

  test("approve and deny at once: one wins, the other is refused", async () => {
    const h = start();
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    const results = await Promise.allSettled([
      h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" }),
      h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "deny" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((await waiting).status).toBe("approved");
    expect(await types(h)).toEqual(["approval.requested", "approval.approved"]);
  });

  test("when its audit row cannot be written nothing changes; a retry then works", async () => {
    let failing = true;
    const h = start({
      audit: (db) => {
        const sink = new SqliteAuditSink(db);
        return {
          write: async (record) => {
            if (failing && record.action === "approval.approve") throw new Error("disk full");
            await sink.write(record);
          },
        };
      },
    });
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    expect(
      await codeOf(h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" })),
    ).toBe("audit.write-failed");
    expect(h.approvals.hasPending("se_a")).toBe(true);
    expect(h.store.pending(SCOPE).map((r) => r.id)).toEqual(["ap_1"]);
    expect(await types(h)).toEqual(["approval.requested"]);
    failing = false;
    await h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" });
    expect((await waiting).status).toBe("approved");
  });
});

describe("the pending list", () => {
  test("authorizes session.list on the workspace first; a denial lists nothing", async () => {
    const seen: string[] = [];
    const h = start({
      authorizer: () => ({
        authorize: async (_p, action, resource) => {
          seen.push(`${action} ${resource.type}:${resource.id}`);
          return { allowed: false, reason: "no", policy: "test" };
        },
      }),
    });
    expect(await codeOf(h.approvals.list(LOCAL_PRINCIPAL))).toBe("authz.denied");
    expect(seen).toEqual([`session.list workspace:${DEFAULT_WORKSPACE_ID}`]);
  });
});

describe("the owner's decision past the deadline", () => {
  test("an approve whose audit fails after the approval's time ends it as expired, not pending", async () => {
    let clock = 1_000;
    const h = start({
      now: () => clock,
      audit: (db) => {
        const sink = new SqliteAuditSink(db);
        return {
          write: async (record) => {
            if (record.action === "approval.approve") throw new Error("disk full");
            await sink.write(record);
          },
        };
      },
    });
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    // Past `expiresAt`, but the 60 s timer has not fired yet.
    clock += 61_000;
    expect(
      await codeOf(h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" })),
    ).toBe("audit.write-failed");
    expect(await waiting).toMatchObject({ status: "expired", approved: false });
    expect(await types(h)).toEqual(["approval.requested", "approval.expired"]);
  });
});

describe("the store", () => {
  test("a row leaves pending once: a second end does not overwrite the first", () => {
    const h = start();
    h.store.insert(SCOPE, {
      id: "ap_x",
      sessionId: "se_a",
      toolCallId: "c",
      tool: "bash",
      summary: "git push",
      command: "git push",
      rule: "git-push",
      mode: "ask",
      requestedAt: 1,
      expiresAt: 2,
    });
    expect(
      h.store.finish(SCOPE, "ap_x", { status: "expired", at: 3, by: null, reason: "late" }),
    ).toBe(true);
    expect(
      h.store.finish(SCOPE, "ap_x", { status: "approved", at: 4, by: "user:x", reason: "ok" }),
    ).toBe(false);
    expect(h.store.get(SCOPE, "se_a", "ap_x")).toMatchObject({
      status: "expired",
      decidedAt: 3,
      decidedBy: null,
    });
  });
});

describe("a hub restart", () => {
  test("every approval still pending becomes interrupted, with an event, and is never approvable", async () => {
    const db = openDatabase(join(dir, "hub.db"));
    dbs.push(db);
    const before = start({ db });
    void before.approvals.request(request("c_1", "se_a"));
    await until(() => before.approvals.hasPending("se_a"));
    // The process dies: its waiters are gone, the row stays pending.
    const after = start({ db });
    expect(await after.approvals.recover()).toBe(1);
    expect(after.store.pending(SCOPE)).toEqual([]);
    const page = await after.events.read(SCOPE, "se_a", 0, 100);
    expect(page.events.map((e) => e.type)).toEqual(["approval.requested", "approval.interrupted"]);
    expect(page.events[1]?.payload).toMatchObject({
      approvalId: "ap_1",
      toolCallId: "c_1",
      reason: APPROVAL_INTERRUPTED,
    });
    expect(
      await codeOf(
        after.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" }),
      ),
    ).toBe("approval.closed");
    expect(await after.approvals.recover()).toBe(0);
    before.approvals.close();
  });

  test("recover() leaves an approval this hub is still waiting on alone", async () => {
    const h = start();
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    expect(await h.approvals.recover()).toBe(0);
    expect(h.store.pending(SCOPE).map((r) => r.id)).toEqual(["ap_1"]);
    expect(await types(h)).toEqual(["approval.requested"]);
    await h.approvals.decide(LOCAL_PRINCIPAL, "se_a", "ap_1", { decision: "approve" });
    expect((await waiting).status).toBe("approved");
  });
});

describe("the routes' status codes", () => {
  function app(approvals: Approvals) {
    const routes = new Hono<HubEnv>();
    routes.use(async (c, next) => {
      c.set("principal", LOCAL_PRINCIPAL);
      await next();
    });
    mountApprovalRoutes(routes, approvals);
    return routes;
  }

  test("503 when the owner's audit row cannot be written; the approval stays pending", async () => {
    const h = start({
      audit: (db) => {
        const sink = new SqliteAuditSink(db);
        return {
          write: async (record) => {
            if (record.action === "approval.approve") throw new Error("disk full");
            await sink.write(record);
          },
        };
      },
    });
    const waiting = h.approvals.request(request());
    await until(() => h.approvals.hasPending("se_a"));
    const res = await app(h.approvals).request("/v1/sessions/se_a/approvals/ap_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"decision":"approve"}',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "audit.write-failed" } });
    expect(h.approvals.hasPending("se_a")).toBe(true);
    await h.approvals.cancel("se_a", "stopped");
    await waiting;
  });

  test("403 authz.denied on the list when session.list is denied", async () => {
    const h = start({
      authorizer: () => ({
        authorize: async () => ({ allowed: false, reason: "no", policy: "test" }),
      }),
    });
    const res = await app(h.approvals).request("/v1/approvals");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "authz.denied" } });
  });
});

describe("the hub", () => {
  test("serves the approval routes behind the request and login guards", async () => {
    const hub = startHub({ port: 0, dbPath: join(dir, "served.db"), log: () => {} });
    try {
      const cookie = `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}`;
      const headers = { cookie, "content-type": "application/json" };
      const session = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "a" });
      const waiting = hub.approvals.request(request("c_1", session.id));
      await until(() => hub.approvals.hasPending(session.id));
      const pending = (await hub.approvals.list(LOCAL_PRINCIPAL))[0];
      const url = new URL(`/v1/sessions/${session.id}/approvals/${pending?.id}`, hub.url);
      const body = '{"decision":"approve"}';
      const anonymous = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(anonymous.status).toBe(401);
      const foreign = await fetch(url, {
        method: "POST",
        headers: { ...headers, origin: "https://evil.example" },
        body,
      });
      expect(foreign.status).toBe(403);
      const form = await fetch(url, {
        method: "POST",
        headers: { cookie, "content-type": "text/plain" },
        body,
      });
      expect(form.status).toBe(415);
      expect(hub.approvals.hasPending(session.id)).toBe(true);

      const list = await fetch(new URL("/v1/approvals", hub.url), { headers });
      expect(await list.json()).toMatchObject({
        ok: true,
        approvals: [{ sessionId: session.id, toolCallId: "c_1", status: "pending" }],
      });
      const bad = await fetch(url, { method: "POST", headers, body: '{"decision":"maybe"}' });
      expect(bad.status).toBe(400);
      const other = new URL(`/v1/sessions/se_other/approvals/${pending?.id}`, hub.url);
      expect((await fetch(other, { method: "POST", headers, body })).status).toBe(404);
      const ok = await fetch(url, { method: "POST", headers, body });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, approval: { status: "approved" } });
      expect((await waiting).status).toBe("approved");
      const again = await fetch(url, { method: "POST", headers, body: '{"decision":"deny"}' });
      expect(again.status).toBe(409);
      expect(await (await fetch(new URL("/v1/approvals", hub.url), { headers })).json()).toEqual({
        ok: true,
        approvals: [],
      });
    } finally {
      await hub.stop();
    }
  });
});
