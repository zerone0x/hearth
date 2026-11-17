/**
 * The access mode setting (decision 0045) over a real SQLite file: a global
 * default (`ask` when nothing is saved), a per-session override (null follows
 * the global default), one resolver read per tool call, and every change
 * authorized first, audited, and written to the event log.
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
  type EventStore,
  DEFAULT_WORKSPACE_ID,
  type HearthError,
  LOCAL_PRINCIPAL,
  type Principal,
} from "@hearth/core";
import { SESSION_COOKIE } from "../auth";
import { RequestBody } from "../request-body";
import { startHub } from "../server";
import {
  openDatabase,
  SqliteAuditSink,
  SqliteEventStore,
  SqliteSessionStore,
  SqliteSettingStore,
} from "../store";
import { ACCESS_MODE_KEY, AccessModes } from ".";

const SCOPE = { workspaceId: DEFAULT_WORKSPACE_ID };
const FOREIGN = Object.freeze({
  id: "pr_foreign",
  workspaceId: "ws_other",
  kind: "user",
  displayName: "foreign",
}) as Principal;

let dir: string;
let dbs: Database[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-access-mode-"));
  dbs = [];
});
afterEach(() => {
  for (const db of dbs) db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly db: Database;
  readonly modes: AccessModes;
  readonly sessions: SqliteSessionStore;
  readonly events: SqliteEventStore;
  readonly settings: SqliteSettingStore;
  readonly logs: string[];
  addSession(id: string, state?: string): void;
}

function start(
  options: {
    audit?: (db: Database) => AuditSink;
    events?: (events: SqliteEventStore) => EventStore;
    authorizer?: (audit: AuditSink) => Authorizer;
  } = {},
): Harness {
  const db = openDatabase(join(dir, "hub.db"));
  dbs.push(db);
  const audit = options.audit?.(db) ?? new SqliteAuditSink(db);
  const sessions = new SqliteSessionStore(db);
  const events = new SqliteEventStore(db);
  const settings = new SqliteSettingStore(db);
  const logs: string[] = [];
  const modes = new AccessModes({
    settings,
    sessions,
    events: options.events?.(events) ?? events,
    authorizer: options.authorizer?.(audit) ?? new AllowAllAuthorizer({ audit }),
    audit,
    log: (line) => logs.push(line),
  });
  return {
    db,
    modes,
    sessions,
    events,
    settings,
    logs,
    addSession(id, state = "idle") {
      sessions.insertSession(SCOPE, { id, title: id, state, boxId: `bx_${id}`, now: 1 });
    },
  };
}

/** The records of an action, not the authorizer's decisions of the same name. */
function auditRows(db: Database, action: string) {
  return db
    .query<{ detail_json: string; resource_type: string; resource_id: string }, [string]>(
      "SELECT detail_json, resource_type, resource_id FROM audit WHERE action = ? AND allowed IS NULL ORDER BY id",
    )
    .all(action)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail_json) as unknown }));
}

async function modeEvents(h: Harness, sessionId: string) {
  const page = await h.events.read(SCOPE, sessionId, 0, 100);
  return page.events.filter((e) => e.type === "session.access_mode").map((e) => e.payload);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as HearthError).code ?? "";
}

/** A body that records whether it was read. */
function spyBody(value: unknown) {
  const spy = { read: false };
  const body = new RequestBody(async () => {
    spy.read = true;
    return value;
  });
  return { spy, body };
}

describe("the resolver", () => {
  test("nothing saved: ask, for a new install and an existing one", async () => {
    const h = start();
    h.addSession("se_a");
    expect(h.modes.resolve("se_a")).toBe("ask");
    expect(h.modes.resolve("se_unknown")).toBe("ask");
    expect(await h.modes.getGlobal(LOCAL_PRINCIPAL)).toEqual({
      mode: "ask",
      source: "default",
      updatedAt: null,
    });
  });

  test("an override wins, null follows the global default, and each read sees the latest", async () => {
    const h = start();
    h.addSession("se_a");
    h.addSession("se_b");
    await h.modes.putGlobal(LOCAL_PRINCIPAL, { mode: "yolo" });
    expect(h.modes.resolve("se_a")).toBe("yolo");
    await h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: "ask" });
    expect(h.modes.resolve("se_a")).toBe("ask");
    expect(h.modes.resolve("se_b")).toBe("yolo");
    // The global default changes; the override still wins, the follower moves.
    await h.modes.putGlobal(LOCAL_PRINCIPAL, { mode: "ask" });
    await h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: "yolo" });
    expect(h.modes.resolve("se_a")).toBe("yolo");
    expect(h.modes.resolve("se_b")).toBe("ask");
    // Back to following.
    expect(await h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: null })).toEqual({
      sessionId: "se_a",
      override: null,
      global: "ask",
      mode: "ask",
    });
    expect(h.modes.resolve("se_a")).toBe("ask");
  });

  test("a stored value this code cannot read is ask, never yolo", () => {
    const h = start();
    h.addSession("se_a");
    h.settings.put(DEFAULT_WORKSPACE_ID, ACCESS_MODE_KEY, JSON.stringify({ mode: "YOLO" }), 5);
    expect(h.modes.resolve("se_a")).toBe("ask");
    h.settings.put(DEFAULT_WORKSPACE_ID, ACCESS_MODE_KEY, JSON.stringify("yolo"), 6);
    expect(h.modes.resolve("se_a")).toBe("ask");
  });

  test("the database refuses an override other than yolo or ask", () => {
    const h = start();
    h.addSession("se_a");
    expect(() => h.sessions.setAccessMode(SCOPE, "se_a", "maybe")).toThrow();
    expect(h.sessions.getSession(SCOPE, "se_a")?.accessMode).toBeNull();
  });
});

describe("changing the global default", () => {
  test("audits, stores, and writes session.access_mode to every session that follows it", async () => {
    const h = start();
    h.addSession("se_follow");
    h.addSession("se_own");
    h.addSession("se_old", "archived");
    await h.modes.putSession(LOCAL_PRINCIPAL, "se_own", { mode: "ask" });
    const view = await h.modes.putGlobal(
      LOCAL_PRINCIPAL,
      new RequestBody(async () => ({ mode: "yolo" })),
    );
    expect(view).toMatchObject({ mode: "yolo", source: "settings" });
    expect(view.updatedAt).toBeNumber();

    const rows = auditRows(h.db, "settings.access_mode.update");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource_type: "setting",
      resource_id: ACCESS_MODE_KEY,
      detail: { mode: "yolo", previous: "ask", previous_source: "default", sessions_following: 1 },
    });
    expect(await modeEvents(h, "se_follow")).toEqual([
      {
        mode: "yolo",
        previous: "ask",
        override: null,
        global: "yolo",
        changed: "global",
        by: { kind: LOCAL_PRINCIPAL.kind, id: LOCAL_PRINCIPAL.id },
      },
    ]);
    // Its own override keeps it in `ask`: one event, from its own change.
    expect((await modeEvents(h, "se_own")).map((p) => (p as { changed: string }).changed)).toEqual([
      "session",
    ]);
    expect(await modeEvents(h, "se_old")).toEqual([]);
    expect(h.logs.at(-1)).toContain("global default set to yolo (was ask)");
  });

  test("a bad body is refused and nothing changes", async () => {
    const h = start();
    for (const body of [
      { mode: "maybe" },
      { mode: null },
      { mode: "yolo", extra: 1 },
      "yolo",
      null,
    ]) {
      expect(await codeOf(h.modes.putGlobal(LOCAL_PRINCIPAL, body))).toBe("request.invalid");
    }
    expect(h.settings.get(DEFAULT_WORKSPACE_ID, ACCESS_MODE_KEY)).toBeUndefined();
    expect(auditRows(h.db, "settings.access_mode.update")).toEqual([]);
  });

  test("a foreign principal is refused before its body is read", async () => {
    const h = start();
    h.addSession("se_a");
    const { spy, body } = spyBody({ mode: "yolo" });
    expect(await codeOf(h.modes.putGlobal(FOREIGN, body))).toBe("authz.denied");
    expect(await codeOf(h.modes.getGlobal(FOREIGN))).toBe("authz.denied");
    expect(spy.read).toBe(false);
    expect(h.modes.resolve("se_a")).toBe("ask");
    expect(auditRows(h.db, "settings.access_mode.update")).toEqual([]);
    expect(await modeEvents(h, "se_a")).toEqual([]);
  });

  test("when the audit cannot be written nothing is stored and no event is written", async () => {
    const h = start({
      audit: (db) => {
        const sink = new SqliteAuditSink(db);
        return {
          write: async (record) => {
            if (record.action.endsWith("access_mode.update") && record.decision === undefined) {
              throw new Error("disk full");
            }
            await sink.write(record);
          },
        };
      },
    });
    h.addSession("se_a");
    expect(await codeOf(h.modes.putGlobal(LOCAL_PRINCIPAL, { mode: "yolo" }))).toBe(
      "audit.write-failed",
    );
    expect(await codeOf(h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: "yolo" }))).toBe(
      "audit.write-failed",
    );
    expect(h.modes.resolve("se_a")).toBe("ask");
    expect(h.settings.get(DEFAULT_WORKSPACE_ID, ACCESS_MODE_KEY)).toBeUndefined();
    expect(h.sessions.getSession(SCOPE, "se_a")?.accessMode).toBeNull();
    expect(await modeEvents(h, "se_a")).toEqual([]);
  });
});

describe("changing a session's override", () => {
  test("audits it and writes one session.access_mode event", async () => {
    const h = start();
    h.addSession("se_a");
    h.addSession("se_b");
    const view = await h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: "yolo" });
    expect(view).toEqual({ sessionId: "se_a", override: "yolo", global: "ask", mode: "yolo" });
    expect(await h.modes.getSession(LOCAL_PRINCIPAL, "se_a")).toEqual(view);
    const rows = auditRows(h.db, "session.access_mode.update");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource_type: "session",
      resource_id: "se_a",
      detail: { override: "yolo", mode: "yolo", previous_override: null, previous: "ask" },
    });
    expect(await modeEvents(h, "se_a")).toEqual([
      {
        mode: "yolo",
        previous: "ask",
        override: "yolo",
        global: "ask",
        changed: "session",
        by: { kind: LOCAL_PRINCIPAL.kind, id: LOCAL_PRINCIPAL.id },
      },
    ]);
    expect(await modeEvents(h, "se_b")).toEqual([]);
    expect(h.modes.resolve("se_b")).toBe("ask");
  });

  test("a foreign principal is refused before the session is looked up or the body read", async () => {
    const h = start();
    h.addSession("se_a");
    for (const id of ["se_a", "se_unknown"]) {
      const { spy, body } = spyBody({ mode: "yolo" });
      expect(await codeOf(h.modes.putSession(FOREIGN, id, body))).toBe("authz.denied");
      expect(await codeOf(h.modes.getSession(FOREIGN, id))).toBe("authz.denied");
      expect(spy.read).toBe(false);
    }
    expect(h.modes.resolve("se_a")).toBe("ask");
    expect(auditRows(h.db, "session.access_mode.update")).toEqual([]);
    expect(await modeEvents(h, "se_a")).toEqual([]);
  });

  test("an unknown session is not found, and its body is never read", async () => {
    const h = start();
    const { spy, body } = spyBody({ mode: "yolo" });
    expect(await codeOf(h.modes.putSession(LOCAL_PRINCIPAL, "se_none", body))).toBe(
      "session.not-found",
    );
    expect(await codeOf(h.modes.getSession(LOCAL_PRINCIPAL, "se_none"))).toBe("session.not-found");
    expect(spy.read).toBe(false);
  });

  test("a bad body is refused and nothing changes", async () => {
    const h = start();
    h.addSession("se_a");
    for (const body of [{ mode: "Yolo" }, {}, { mode: "ask", x: 1 }, [], 3]) {
      expect(await codeOf(h.modes.putSession(LOCAL_PRINCIPAL, "se_a", body))).toBe(
        "request.invalid",
      );
    }
    expect(h.sessions.getSession(SCOPE, "se_a")?.accessMode).toBeNull();
    expect(await modeEvents(h, "se_a")).toEqual([]);
  });
});

describe("gaps from the #158 verification", () => {
  test("clearing an override while the global default is yolo records mode yolo", async () => {
    const h = start();
    h.addSession("se_a");
    await h.modes.putGlobal(LOCAL_PRINCIPAL, { mode: "yolo" });
    await h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: "ask" });
    const view = await h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: null });
    expect(view).toEqual({ sessionId: "se_a", override: null, global: "yolo", mode: "yolo" });
    const rows = auditRows(h.db, "session.access_mode.update");
    expect(rows.at(-1)?.detail).toEqual({
      override: null,
      mode: "yolo",
      previous_override: "ask",
      previous: "ask",
    });
    expect((await modeEvents(h, "se_a")).at(-1)).toMatchObject({
      mode: "yolo",
      previous: "ask",
      override: null,
      global: "yolo",
      changed: "session",
    });
    expect(h.modes.resolve("se_a")).toBe("yolo");
  });

  test("an event append that throws leaves the override and the default unchanged", async () => {
    const h = start({
      events: (inner) => ({
        append: async (scope, sessionId, event) => {
          if (event.type === "session.access_mode") throw new Error("disk full");
          return inner.append(scope, sessionId, event);
        },
        read: (...args) => inner.read(...args),
        lastSeq: (...args) => inner.lastSeq(...args),
      }),
    });
    h.addSession("se_a");
    await expect(h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: "yolo" })).rejects.toThrow(
      "disk full",
    );
    await expect(h.modes.putGlobal(LOCAL_PRINCIPAL, { mode: "yolo" })).rejects.toThrow("disk full");
    expect(h.sessions.getSession(SCOPE, "se_a")?.accessMode).toBeNull();
    expect(h.settings.get(DEFAULT_WORKSPACE_ID, ACCESS_MODE_KEY)).toBeUndefined();
    expect(h.modes.resolve("se_a")).toBe("ask");
  });

  test("a global change and an override at once: each event matches the state it left", async () => {
    const h = start();
    h.addSession("se_a");
    h.addSession("se_b");
    await Promise.all([
      h.modes.putGlobal(LOCAL_PRINCIPAL, { mode: "yolo" }),
      h.modes.putSession(LOCAL_PRINCIPAL, "se_a", { mode: "ask" }),
      h.modes.putGlobal(LOCAL_PRINCIPAL, { mode: "ask" }),
      h.modes.putSession(LOCAL_PRINCIPAL, "se_b", { mode: "yolo" }),
    ]);
    for (const id of ["se_a", "se_b"]) {
      const events = (await modeEvents(h, id)) as Array<{ mode: string; previous: string }>;
      // Serialized: every event starts where the one before it ended, and the last is the state.
      for (let i = 1; i < events.length; i++) {
        expect(events[i]?.previous).toBe(events[i - 1]?.mode as string);
      }
      expect(events.at(-1)?.mode).toBe(h.modes.resolve(id));
    }
    expect(h.modes.resolve("se_a")).toBe("ask");
    expect(h.modes.resolve("se_b")).toBe("yolo");
  });

  test("reading a session's mode authorizes session.read on that session", async () => {
    const seen: Array<{ action: string; type: string; id: string }> = [];
    const h = start({
      authorizer: () => ({
        authorize: async (_principal, action, resource) => {
          seen.push({ action, type: resource.type, id: resource.id });
          return { allowed: true, policy: "test" };
        },
      }),
    });
    h.addSession("se_a");
    await h.modes.getSession(LOCAL_PRINCIPAL, "se_a");
    expect(seen).toEqual([{ action: "session.read", type: "session", id: "se_a" }]);
  });
});

describe("the hub", () => {
  test("serves the access mode routes behind the request and login guards", async () => {
    const hub = startHub({ port: 0, dbPath: join(dir, "served.db"), log: () => {} });
    try {
      const cookie = `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}`;
      const headers = { cookie, "content-type": "application/json" };
      const global = new URL("/v1/settings/access-mode", hub.url);
      expect((await fetch(global)).status).toBe(401);
      expect(
        (
          await fetch(global, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: '{"mode":"yolo"}',
          })
        ).status,
      ).toBe(401);
      expect(await (await fetch(global, { headers })).json()).toEqual({
        ok: true,
        mode: "ask",
        source: "default",
        updatedAt: null,
      });

      const created = await fetch(new URL("/v1/sessions", hub.url), {
        method: "POST",
        headers,
        body: "{}",
      });
      const sessionId = ((await created.json()) as { session: { id: string } }).session.id;
      const own = new URL(`/v1/sessions/${sessionId}/access-mode`, hub.url);

      // A page on another origin, and a non-JSON body, never reach the service.
      for (const url of [global, own]) {
        const foreign = await fetch(url, {
          method: "PUT",
          headers: { ...headers, origin: "https://evil.example" },
          body: '{"mode":"yolo"}',
        });
        expect(foreign.status).toBe(403);
        const form = await fetch(url, {
          method: "PUT",
          headers: { cookie, "content-type": "text/plain" },
          body: '{"mode":"yolo"}',
        });
        expect(form.status).toBe(415);
      }
      expect(hub.accessModes.resolve(sessionId)).toBe("ask");

      const put = await fetch(global, { method: "PUT", headers, body: '{"mode":"yolo"}' });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ ok: true, mode: "yolo", source: "settings" });
      expect(await (await fetch(own, { headers })).json()).toEqual({
        ok: true,
        sessionId,
        override: null,
        global: "yolo",
        mode: "yolo",
      });
      const set = await fetch(own, { method: "PUT", headers, body: '{"mode":"ask"}' });
      expect(await set.json()).toMatchObject({ override: "ask", mode: "ask" });
      expect(hub.accessModes.resolve(sessionId)).toBe("ask");
      const bad = await fetch(own, { method: "PUT", headers, body: '{"mode":"on"}' });
      expect(bad.status).toBe(400);
      const missing = await fetch(new URL("/v1/sessions/se_nope/access-mode", hub.url), {
        method: "PUT",
        headers,
        body: '{"mode":"ask"}',
      });
      expect(missing.status).toBe(404);
      // The changes are in the session's event log.
      const page = await hub.events.read(SCOPE, sessionId, 0, 100);
      expect(page.events.filter((e) => e.type === "session.access_mode")).toHaveLength(2);
    } finally {
      await hub.stop();
    }
  });
});
