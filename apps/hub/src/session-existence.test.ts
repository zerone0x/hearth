/**
 * A principal the policy refuses cannot tell whether a session id exists (#90):
 * an unknown id and another workspace's existing id (live or archived) get the
 * same status and body on every session route, under the allow-all policy (the
 * stranger is refused for its workspace) and under a policy that denies all.
 * The manager's own operations are covered in `session/manager.test.ts`. Real
 * attempts on existing sessions keep their `allowed = 0` audit rows.
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
    init: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
  ) => {
    const text = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    return fetch(new URL(path, hub.url), {
      method: init.method ?? (text === undefined ? "GET" : "POST"),
      headers: {
        cookie,
        ...(text === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(text === undefined ? {} : { body: text }),
    });
  };

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

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/v1/sessions/%"],
  ["POST", "/v1/sessions/%/archive", {}],
  ["POST", "/v1/sessions/%/messages", { text: "hi" }],
  ["POST", "/v1/sessions/%/interrupt", {}],
  ["POST", "/v1/sessions/%/runner", {}],
  ["GET", "/v1/sessions/%/runner"],
  ["GET", "/v1/sessions/%/events"],
  ["GET", "/v1/sessions/%/desktop", undefined],
];

/** Another id of the same shape as `id`, that no session has. */
const unknownLike = (id: string) => `se_${id.slice(3).split("").reverse().join("")}`;

async function answer(f: Fixture, method: string, template: string, body: unknown, sid: string) {
  const path = template.replace("%", sid);
  const desktop = path.endsWith("/desktop");
  const res = await f.request(path, {
    method,
    ...(desktop ? { headers: { upgrade: "websocket", connection: "Upgrade" } } : {}),
    ...(body === undefined ? {} : { body }),
  });
  return `${res.status} ${(await res.text()).replaceAll(sid, "<id>")}`;
}

for (const policy of ["allow-all", "deny-all"] as const) {
  describe(`unknown id vs another workspace's id, ${policy} policy`, () => {
    test("every session route answers the same", async () => {
      const f = fixture();
      const live = await f.createSession();
      const archived = await f.createSession();
      expect((await f.request(`/v1/sessions/${archived}/archive`, { body: {} })).status).toBe(200);
      f.signedIn.principal = STRANGER;
      if (policy === "deny-all") {
        f.hub.authorizer.authorize = async () => ({
          allowed: false,
          policy: "test",
          reason: "denied by policy",
        });
      }
      const unknown = unknownLike(live);
      expect(unknown).not.toBe(live);
      for (const [method, template, body] of ROUTES) {
        const expected = await answer(f, method, template, body, unknown);
        expect(expected).toStartWith("403 ");
        for (const sid of [live, archived]) {
          expect(`${method} ${template} ${await answer(f, method, template, body, sid)}`).toBe(
            `${method} ${template} ${expected}`,
          );
        }
      }
    });
  });
}

test("a refused attempt on an existing session keeps its allowed = 0 audit row", async () => {
  const f = fixture();
  const id = await f.createSession();
  f.signedIn.principal = STRANGER;
  const before = f.auditRows().length;
  expect((await f.request(`/v1/sessions/${id}/archive`, { body: {} })).status).toBe(403);
  const rows = f.auditRows().slice(before);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    principal_id: STRANGER.id,
    action: "session.archive",
    resource_workspace_id: DEFAULT_WORKSPACE_ID,
    allowed: 0,
  });
  // The session was not touched.
  f.signedIn.principal = OTHER;
  const res = await f.request(`/v1/sessions/${id}`);
  expect(((await res.json()) as { session: { state: string } }).session.state).toBe("idle");
});

/** Every route with a body, and the action it authorizes (`%` is a session id). */
const BODY_ROUTES: [string, string][] = [
  ["/v1/sessions", "session.create"],
  ["/v1/sessions/%/messages", "session.message"],
  ["/v1/sessions/%/runner", "session.configure"],
  ["/v1/sessions/%/labels", "session.label"],
];

describe("a body is read only after authorize (#32)", () => {
  test("a body that is not JSON is authorized and audited, then answers 400", async () => {
    const f = fixture();
    const id = await f.createSession();
    for (const [template, action] of BODY_ROUTES) {
      const before = f.auditRows().length;
      const res = await f.request(template.replace("%", id), { raw: "{not json" });
      const code = ((await res.json()) as { error: { code: string } }).error.code;
      expect({ template, status: res.status, code }).toEqual({
        template,
        status: 400,
        code: "request.invalid",
      });
      const rows = f.auditRows().slice(before);
      expect({ template, audited: rows.some((r) => r.action === action) }).toEqual({
        template,
        audited: true,
      });
    }
  });

  test("a refused caller gets the same answer whatever the body", async () => {
    const f = fixture();
    const live = await f.createSession();
    f.signedIn.principal = STRANGER;
    const unknown = unknownLike(live);
    for (const [template] of BODY_ROUTES.slice(1)) {
      const answers = new Set<string>();
      for (const sid of [live, unknown]) {
        for (const raw of ["{not json", "{}", '{"text":"hi"}']) {
          const res = await f.request(template.replace("%", sid), { raw });
          answers.add(`${res.status} ${(await res.text()).replaceAll(sid, "<id>")}`);
        }
      }
      expect({ template, answers: [...answers] }).toEqual({
        template,
        answers: [expect.stringMatching(/^403 /)],
      });
    }
  });
});
