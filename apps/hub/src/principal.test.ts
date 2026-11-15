/**
 * Every handler behind the login guard passes the guard's principal to
 * `authorize`, and that principal is the one in the audit row (#61, decision
 * 0014). In v1 every login yields the owner, so a handler that hard-coded
 * `LOCAL_PRINCIPAL` would look right; here the guard returns another principal
 * of the same workspace, which tells the two apart. One test per route family:
 * sessions, runner, desktop, box echo, trajectory and labels. Driven through the real hub (`startHub`):
 * real routes, session manager, runners, desktop bridge, box connections,
 * `AllowAllAuthorizer` and SQLite audit sink.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Action,
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  LOCAL_PRINCIPAL,
  type Principal,
  type SecretStore,
} from "@hearth/core";
import { SESSION_COOKIE } from "./auth";
import { type Hub, startHub } from "./server";

const OTHER: Principal = { ...LOCAL_PRINCIPAL, id: "usr_other", displayName: "other" };
/** A principal of another workspace than the sessions' (`DEFAULT_WORKSPACE_ID`). */
const STRANGER: Principal = {
  ...LOCAL_PRINCIPAL,
  id: "usr_stranger",
  workspaceId: "ws_elsewhere",
  displayName: "stranger",
};

const dirs: string[] = [];
const hubs: Hub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** No secret is ever resolved: no route here reaches the model. */
const noSecrets = {
  resolve: async () => {
    throw new Error("no secret is resolved in this test");
  },
} as unknown as SecretStore;

interface AuditRow {
  principal_id: string;
  action: string;
  resource_workspace_id: string;
  allowed: number;
}

/** A hub whose login guard returns `OTHER` for a live login, and records `authorize` calls. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hearth-principal-"));
  dirs.push(dir);
  const dbPath = join(dir, "hub.db");
  const hub = startHub({
    dbPath,
    port: 0,
    boxPort: 0,
    log: () => undefined,
    runner: { config: { provider: "faux", model: "faux-1" }, secrets: noSecrets },
  });
  hubs.push(hub);

  // The principal the guard returns for a live login; a test may change it.
  const signedIn = { principal: OTHER };
  const authenticate = hub.auth.authenticate.bind(hub.auth);
  hub.auth.authenticate = (token) =>
    authenticate(token) === undefined ? undefined : signedIn.principal;

  // Every component holds this same authorizer object.
  const calls: { principal: string; action: Action }[] = [];
  const authorizer: Authorizer = hub.authorizer;
  const inner = authorizer.authorize.bind(authorizer);
  authorizer.authorize = async (principal, action, resource) => {
    calls.push({ principal: principal.id, action });
    return await inner(principal, action, resource);
  };

  const cookie = `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}`;
  const request = (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    fetch(new URL(path, hub.url), {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        cookie,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  return {
    hub,
    signedIn,
    calls,
    request,
    /** Creates a session through the API (as `OTHER`); returns its id. */
    async createSession(): Promise<string> {
      const res = await request("/v1/sessions", { body: { title: "t" } });
      expect(res.status).toBe(201);
      return ((await res.json()) as { session: { id: string } }).session.id;
    },
    /** The workspace the session row is in (the store's own record). */
    sessionWorkspace(id: string): string {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .query<{ workspace_id: string }, [string]>(
            "SELECT workspace_id FROM session WHERE id = ?",
          )
          .get(id);
        if (row === null) throw new Error(`no session row ${id}`);
        return row.workspace_id;
      } finally {
        db.close();
      }
    },
    /** How many events of `type` the session has. */
    eventCount(id: string, type: string): number {
      const db = new Database(dbPath, { readonly: true });
      try {
        return (
          db
            .query<{ n: number }, [string, string]>(
              "SELECT count(*) AS n FROM event WHERE session_id = ? AND type = ?",
            )
            .get(id, type)?.n ?? 0
        );
      } finally {
        db.close();
      }
    },
    auditRows(): AuditRow[] {
      const db = new Database(dbPath, { readonly: true });
      try {
        return db
          .query<AuditRow, []>(
            "SELECT principal_id, action, resource_workspace_id, allowed FROM audit ORDER BY id",
          )
          .all();
      } finally {
        db.close();
      }
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

/**
 * `actions` reached `authorize` and the audit log, and every decision from
 * `from` on (the calls made by the routes under test) was for `OTHER`.
 */
function expectOther(f: Fixture, from: { calls: number; rows: number }, actions: Action[]) {
  const calls = f.calls.slice(from.calls);
  const rows = f.auditRows().slice(from.rows);
  for (const action of actions) {
    expect({ action, called: calls.some((c) => c.action === action) }).toEqual({
      action,
      called: true,
    });
    expect({ action, audited: rows.some((r) => r.action === action) }).toEqual({
      action,
      audited: true,
    });
  }
  expect(calls.length).toBeGreaterThan(0);
  expect(rows.length).toBe(calls.length);
  for (const c of calls)
    expect({ action: c.action, principal: c.principal }).toEqual({
      action: c.action,
      principal: OTHER.id,
    });
  for (const r of rows)
    expect({ action: r.action, principal: r.principal_id }).toEqual({
      action: r.action,
      principal: OTHER.id,
    });
}

function mark(f: Fixture) {
  return { calls: f.calls.length, rows: f.auditRows().length };
}

describe("the signed-in principal reaches authorize and the audit row", () => {
  test("session routes: create, list, get, archive", async () => {
    const f = fixture();
    const from = mark(f);
    const id = await f.createSession();
    expect((await f.request("/v1/sessions")).status).toBe(200);
    expect((await f.request(`/v1/sessions/${id}`)).status).toBe(200);
    expect((await f.request(`/v1/sessions/${id}/archive`, { body: {} })).status).toBe(200);
    expectOther(f, from, ["session.create", "session.list", "session.read", "session.archive"]);
  });

  test("runner routes: messages, interrupt, events, runner options", async () => {
    const f = fixture();
    const id = await f.createSession();
    const from = mark(f);
    // An empty message is refused after `authorize`, so no model is called.
    const sent = await f.request(`/v1/sessions/${id}/messages`, { body: { text: "" } });
    expect(sent.status).toBe(400);
    expect((await f.request(`/v1/sessions/${id}/interrupt`, { body: {} })).status).toBe(200);
    expect((await f.request(`/v1/sessions/${id}/events?after=0&limit=10`)).status).toBe(200);
    expect((await f.request(`/v1/sessions/${id}/runner`)).status).toBe(200);
    const configured = await f.request(`/v1/sessions/${id}/runner`, { body: { codemode: true } });
    expect(configured.status).toBe(200);
    expectOther(f, from, [
      "session.message",
      "session.interrupt",
      "session.events",
      "session.configure",
      "session.read",
    ]);
  });

  test("desktop: the upgrade request authorizes desktop.view as the signed-in principal", async () => {
    const f = fixture();
    const id = await f.createSession();
    // No box provider: the bridge authorizes and looks the session up, then
    // cannot get a box, so the upgrade is refused after `authorize` ran.
    // It records the principal the box would be woken for (audited transitions).
    const wokenFor: (string | undefined)[] = [];
    f.hub.sessions.ensureBox = async (_sessionId, principal) => {
      wokenFor.push(principal?.id);
      throw new HearthError("no box in this test", {
        owner: "hub",
        disposition: "give-up",
        code: "session.unavailable",
      });
    };
    const from = mark(f);
    const res = await f
      .request(`/v1/sessions/${id}/desktop`, {
        headers: { upgrade: "websocket", connection: "Upgrade" },
      })
      .catch(() => undefined);
    expect(res?.status).toBe(409);
    await res?.body?.cancel();
    expectOther(f, from, ["desktop.view", "session.read"]);
    expect(wokenFor).toEqual([OTHER.id]);
  });

  test("desktop: desktop.view is checked against the session's workspace, not the caller's", async () => {
    const f = fixture();
    const id = await f.createSession();
    const woken: string[] = [];
    f.hub.sessions.ensureBox = async (sessionId) => {
      woken.push(sessionId);
      throw new Error("the box must not be woken for a caller of another workspace");
    };
    // The guard now returns a principal of another workspace than the session's.
    f.signedIn.principal = STRANGER;
    const from = mark(f);
    const res = await f
      .request(`/v1/sessions/${id}/desktop`, {
        headers: { upgrade: "websocket", connection: "Upgrade" },
      })
      .catch(() => undefined);
    expect(res?.status).toBe(403);
    await res?.body?.cancel();
    // `authorize` saw the session's workspace and denied; nothing ran after it.
    expect(f.auditRows().slice(from.rows)).toEqual([
      {
        principal_id: STRANGER.id,
        action: "desktop.view",
        resource_workspace_id: DEFAULT_WORKSPACE_ID,
        allowed: 0,
      },
    ]);
    expect(woken).toEqual([]);
  });

  test("trajectory routes: the trajectory and its labels (decision 0021)", async () => {
    const f = fixture();
    const id = await f.createSession();
    const from = mark(f);
    const got = await f.request(`/v1/sessions/${id}/trajectory`);
    expect(got.status).toBe(200);
    expect(await got.text()).toContain('"kind":"session"');
    const labelled = await f.request(`/v1/sessions/${id}/labels`, {
      body: { outcome: "success" },
    });
    expect(labelled.status).toBe(200);
    // Each route authorizes its action, then reads the session (session.read).
    expectOther(f, from, ["session.trajectory", "session.label", "session.read"]);
    // The resource is the session, in the workspace its row is in.
    const workspace = f.sessionWorkspace(id);
    const rows = f.auditRows().slice(from.rows);
    expect(rows.map((r) => [r.action, r.resource_workspace_id, r.allowed])).toEqual([
      ["session.trajectory", workspace, 1],
      ["session.read", workspace, 1],
      ["session.label", workspace, 1],
      ["session.read", workspace, 1],
    ]);
    expect(f.eventCount(id, "trajectory.label")).toBe(1);
  });

  test("trajectory routes: checked against the session's workspace, not the caller's", async () => {
    const f = fixture();
    const id = await f.createSession();
    const workspace = f.sessionWorkspace(id);
    expect(workspace).not.toBe(STRANGER.workspaceId);
    f.signedIn.principal = STRANGER;
    const from = mark(f);
    expect((await f.request(`/v1/sessions/${id}/trajectory`)).status).toBe(403);
    const labelled = await f.request(`/v1/sessions/${id}/labels`, {
      body: { outcome: "fail" },
    });
    expect(labelled.status).toBe(403);
    expect(f.auditRows().slice(from.rows)).toEqual([
      {
        principal_id: STRANGER.id,
        action: "session.trajectory",
        resource_workspace_id: workspace,
        allowed: 0,
      },
      {
        principal_id: STRANGER.id,
        action: "session.label",
        resource_workspace_id: workspace,
        allowed: 0,
      },
    ]);
    // Denied before anything was written.
    expect(f.eventCount(id, "trajectory.label")).toBe(0);
  });

  test("box echo", async () => {
    const f = fixture();
    const from = mark(f);
    const res = await f.request("/v1/boxes/box_none/echo", { body: { x: 1 } });
    expect(res.status).toBe(409);
    expectOther(f, from, ["box.echo"]);
  });
});
