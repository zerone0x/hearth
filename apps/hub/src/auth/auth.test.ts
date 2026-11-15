/**
 * The minimal local login (PRD §10, §11.1 item 6; decision 0014), driven
 * through the real app, request guard (0010) and SQLite store.
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type JsonValue, LOCAL_PRINCIPAL, type Principal } from "@hearth/core";
import { type AppOptions, createApp } from "../app";
import type { BoxConnections } from "../box/connections";
import { openDatabase, SqliteLoginStore } from "../store";
import {
  ARGON2ID_PARAMS,
  AuthService,
  type AuthServiceOptions,
  argon2idKdf,
  LOGIN_RATE_LIMIT,
  OPEN_ROUTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_RAW_MAX_LENGTH,
  type PasswordKdf,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  secretsEqual,
} from ".";

const PASSWORD = "correct horse battery staple";
const START = 1_700_000_000_000;

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/** argon2id with tiny parameters, recording the input of every `hash` and `verify` call. */
function cheapKdf() {
  const inner = argon2idKdf({ memoryCost: 256, timeCost: 1 });
  const kdf = {
    hashes: [] as string[],
    verifies: [] as string[],
    hash: (password: string) => {
      kdf.hashes.push(password);
      return inner.hash(password);
    },
    verify: (password: string, hash: string) => {
      kdf.verifies.push(password);
      return inner.verify(password, hash);
    },
  };
  return kdf;
}

interface Harness {
  readonly db: Database;
  readonly auth: AuthService;
  readonly kdf: ReturnType<typeof cheapKdf>;
  readonly app: ReturnType<typeof createApp>;
  /** Principals `echo` was called with: a command that ran. */
  readonly commands: Principal[];
  clock: number;
  sessions(): number;
}

function harness(
  options: { app?: AppOptions; auth?: Partial<AuthServiceOptions>; password?: boolean } = {},
): Harness {
  const db = openDatabase(":memory:");
  dbs.push(db);
  const kdf = cheapKdf();
  const commands: Principal[] = [];
  const boxes = {
    echo: async (principal: Principal, _boxId: string, params: JsonValue) => {
      commands.push(principal);
      return params;
    },
  } as unknown as BoxConnections;
  const h: Harness = {
    db,
    kdf,
    commands,
    clock: START,
    auth: undefined as unknown as AuthService,
    app: undefined as unknown as ReturnType<typeof createApp>,
    sessions: () =>
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM login_session").get()?.n ?? -1,
  };
  const auth = new AuthService({
    store: new SqliteLoginStore(db),
    kdf,
    now: () => h.clock,
    ...options.auth,
  });
  Object.assign(h, { auth, app: createApp({ boxes, auth }, options.app) });
  return h;
}

/** A harness whose owner password is already `PASSWORD`. */
async function withPassword(
  options: Parameters<typeof harness>[0] = {},
): Promise<Harness & { cookie: string }> {
  const h = harness(options);
  const res = await setup(h, h.auth.setupToken() ?? "", PASSWORD);
  expect(res.status).toBe(201);
  return Object.assign(h, { cookie: cookieOf(res) });
}

async function post(
  h: Harness,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return h.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function setup(h: Harness, setupToken: string, password: string, headers = {}) {
  return post(h, "/v1/auth/setup", { setupToken, password }, headers);
}

function login(h: Harness, password: string, headers: Record<string, string> = {}) {
  return post(h, "/v1/auth/login", { password }, headers);
}

function echo(h: Harness, headers: Record<string, string> = {}) {
  return post(h, "/v1/boxes/box_1/echo", { x: 1 }, headers);
}

/** `name=value` of the session cookie a response sets. */
function cookieOf(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const pair = header.split(";")[0] ?? "";
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

function attributes(res: Response): string[] {
  return (res.headers.get("set-cookie") ?? "").split(";").map((part) => part.trim());
}

describe("every route except /healthz and the login needs a session", () => {
  const unauthenticated: (Record<string, string> | undefined)[] = [
    undefined,
    { cookie: `${SESSION_COOKIE}=` },
    { cookie: `${SESSION_COOKIE}=hls_not-a-session` },
    { cookie: `${SESSION_COOKIE}=garbage` },
    { cookie: "other=hls_x" },
  ];

  test("401 auth.required for a command, known or unknown routes, and logout", async () => {
    const h = await withPassword();
    const requests: [string, string][] = [
      ["POST", "/v1/boxes/box_1/echo"],
      ["POST", "/v1/sessions"],
      ["GET", "/v1/sessions"],
      ["POST", "/v1/auth/logout"],
      ["GET", "/"],
      ["GET", "/v1/box/socket"],
    ];
    for (const headers of unauthenticated) {
      for (const [method, path] of requests) {
        const res = await h.app.request(path, {
          method,
          headers: { "content-type": "application/json", ...headers },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect({ method, path, headers, status: res.status }).toEqual({
          method,
          path,
          headers,
          status: 401,
        });
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "auth.required" } });
      }
    }
    expect(h.commands).toHaveLength(0);
  });

  test("the open routes are exactly /healthz, status, setup and login", async () => {
    expect([...OPEN_ROUTES].sort()).toEqual(
      ["GET /healthz", "GET /v1/auth/status", "POST /v1/auth/login", "POST /v1/auth/setup"].sort(),
    );
    const h = harness();
    expect((await h.app.request("/healthz")).status).toBe(200);
    expect(await (await h.app.request("/v1/auth/status")).json()).toEqual({
      setupRequired: true,
      authenticated: false,
    });
    // An open path with another method is not open.
    expect((await h.app.request("/v1/auth/login")).status).toBe(401);
  });

  test("a signed-in request runs the command as the session's principal", async () => {
    const h = await withPassword();
    const res = await echo(h, { cookie: h.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { x: 1 } });
    expect(h.commands).toEqual([AuthService.OWNER]);
    expect(h.commands[0]).toBe(LOCAL_PRINCIPAL);
    expect(
      await (await h.app.request("/v1/auth/status", { headers: { cookie: h.cookie } })).json(),
    ).toEqual({ setupRequired: false, authenticated: true });
  });

  test("the handler passes the guard's principal to authorize, not a fixed one", async () => {
    // In v1 every login yields the owner, so a handler that hard-coded
    // LOCAL_PRINCIPAL would look right; a guard that returns another
    // principal tells the two apart.
    const other = {
      ...LOCAL_PRINCIPAL,
      id: "usr_other",
      displayName: "other",
    } as unknown as Principal;
    const h = await withPassword();
    const auth = Object.create(h.auth) as AuthService;
    auth.authenticate = (token) => (h.auth.authenticate(token) === undefined ? undefined : other);
    const boxes = {
      echo: async (principal: Principal, _boxId: string, params: JsonValue) => {
        h.commands.push(principal);
        return params;
      },
    } as unknown as BoxConnections;
    const app = createApp({ boxes, auth });
    const res = await app.request("/v1/boxes/box_1/echo", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: h.cookie },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(200);
    expect(h.commands).toEqual([other]);
  });
});

describe("first-run setup", () => {
  test("needs the setup token and a long enough password, and happens once", async () => {
    const h = harness();
    const token = h.auth.setupToken();
    expect(token).toMatch(/^hst_[A-Za-z0-9_-]{43}$/);
    expect(h.auth.setupToken()).toBe(token);

    // Before setup there is nothing to log in to.
    const early = await login(h, PASSWORD);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: { code: "auth.setup-required" } });

    const wrongToken = await setup(h, `${token}x`, PASSWORD);
    expect(wrongToken.status).toBe(403);
    expect(await wrongToken.json()).toMatchObject({ error: { code: "auth.setup-token-invalid" } });
    const weak = await setup(h, token ?? "", "short");
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({ error: { code: "auth.password-too-weak" } });
    expect(h.auth.setupRequired()).toBe(true);
    expect(h.sessions()).toBe(0);

    const ok = await setup(h, token ?? "", PASSWORD);
    expect(ok.status).toBe(201);
    expect(h.auth.setupRequired()).toBe(false);
    expect(h.auth.setupToken()).toBeUndefined();
    expect((await echo(h, { cookie: cookieOf(ok) })).status).toBe(200);

    const again = await setup(h, token ?? "", "another long password");
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "auth.already-set-up" } });
    expect((await login(h, "another long password")).status).toBe(401);
    expect((await login(h, PASSWORD)).status).toBe(200);
  });

  test("two setups at once: exactly one wins, and its password is the one stored", async () => {
    for (let round = 0; round < 5; round++) {
      const h = harness();
      const token = h.auth.setupToken() ?? "";
      const passwords = ["first long password", "second long password"] as const;
      const responses = await Promise.all(passwords.map((pw) => setup(h, token, pw)));
      const statuses = responses.map((res) => res.status);
      expect([...statuses].sort()).toEqual([201, 409]);
      // Both got past the checks before either stored: the insert decided.
      expect(h.kdf.hashes).toHaveLength(2);
      const winner = statuses[0] === 201 ? passwords[0] : passwords[1];
      const loser = winner === passwords[0] ? passwords[1] : passwords[0];
      const loserRes = responses[statuses[0] === 201 ? 1 : 0];
      expect(await loserRes?.json()).toMatchObject({ error: { code: "auth.already-set-up" } });
      expect(loserRes?.headers.get("set-cookie")).toBeNull();
      expect(h.sessions()).toBe(1);
      const rows = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM owner_password").get();
      expect(rows?.n).toBe(1);
      expect((await login(h, winner)).status).toBe(200);
      expect((await login(h, loser)).status).toBe(401);
    }
  });

  test("the password is stored as argon2id with the named parameters, never in clear", async () => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    const auth = new AuthService({ store: new SqliteLoginStore(db) });
    const outcome = await auth.setup(auth.setupToken() ?? "", PASSWORD);
    expect(outcome.kind).toBe("ok");
    const row = db
      .query<{ password_hash: string }, []>("SELECT password_hash FROM owner_password")
      .get();
    expect(row?.password_hash).toStartWith(
      `$argon2id$v=19$m=${ARGON2ID_PARAMS.memoryCost},t=${ARGON2ID_PARAMS.timeCost},p=1$`,
    );
    expect(ARGON2ID_PARAMS).toEqual({ memoryCost: 19_456, timeCost: 2 });
    expect(row?.password_hash).not.toContain(PASSWORD);
    expect((await auth.login(PASSWORD)).kind).toBe("ok");
    expect((await auth.login(`${PASSWORD}!`)).kind).toBe("rejected");
  });
});

describe("login", () => {
  test("a wrong password gets 401 and no cookie or session", async () => {
    const h = await withPassword();
    const before = h.sessions();
    for (const wrong of ["", "x", PASSWORD.toUpperCase(), `${PASSWORD} `, PASSWORD.slice(0, -1)]) {
      const res = await login(h, wrong);
      expect({ wrong, status: res.status }).toEqual({ wrong, status: 401 });
      expect(await res.json()).toMatchObject({ error: { code: "auth.invalid-credentials" } });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(h.sessions()).toBe(before);
  });

  test("a malformed body is 400 and costs no KDF work", async () => {
    const h = await withPassword();
    for (const body of [{}, { password: 1 }, null, "pw", [PASSWORD]]) {
      expect((await post(h, "/v1/auth/login", body)).status).toBe(400);
    }
    expect(h.kdf.verifies).toHaveLength(0);
  });

  test("a session expires after its TTL and its row is removed", async () => {
    const h = await withPassword();
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60_000);
    h.clock += SESSION_TTL_MS - 1;
    expect((await echo(h, { cookie: h.cookie })).status).toBe(200);
    h.clock += 1;
    const res = await echo(h, { cookie: h.cookie });
    expect(res.status).toBe(401);
    expect(h.sessions()).toBe(0);
    // Not revived when the clock goes back: the row is gone.
    h.clock = START;
    expect((await echo(h, { cookie: h.cookie })).status).toBe(401);
    expect(h.commands).toHaveLength(1);
  });

  test("expired sessions are swept when a new one is issued", async () => {
    const h = await withPassword();
    h.clock += SESSION_TTL_MS;
    expect((await login(h, PASSWORD)).status).toBe(200);
    expect(h.sessions()).toBe(1);
  });

  test("session fixation: login always issues a new id and ends the one the browser sent", async () => {
    const h = await withPassword();
    // A cookie the browser already holds (planted or from an earlier login).
    const old = h.cookie;
    const res = await login(h, PASSWORD, { cookie: old });
    expect(res.status).toBe(200);
    const fresh = cookieOf(res);
    expect(fresh).not.toBe(old);
    expect((await echo(h, { cookie: old })).status).toBe(401);
    expect((await echo(h, { cookie: fresh })).status).toBe(200);
    expect(h.sessions()).toBe(1);

    // An id the attacker made up is never adopted either.
    const planted = `${SESSION_COOKIE}=hls_planted-by-attacker`;
    const second = cookieOf(await login(h, PASSWORD, { cookie: planted }));
    expect(second).not.toBe(planted);
    expect((await echo(h, { cookie: planted })).status).toBe(401);
  });

  test("session ids are stored only as SHA-256 hashes", async () => {
    const h = await withPassword();
    const token = h.cookie.split("=")[1] ?? "";
    expect(token).toMatch(/^hls_[A-Za-z0-9_-]{43}$/);
    // Computed here, not with the production helper, so a broken hash cannot agree with itself.
    const expected = createHash("sha256").update(token).digest("hex");
    const rows = h.db.query<{ id_hash: string }, []>("SELECT id_hash FROM login_session").all();
    expect(rows).toEqual([{ id_hash: expected }]);
    expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    // No column of any table holds the raw id, or its random part.
    const tables = h.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    expect(tables.map((t) => t.name)).toContain("login_session");
    for (const { name } of tables) {
      const dump = JSON.stringify(h.db.query(`SELECT * FROM "${name}"`).all());
      expect({ name, leaks: dump.includes(token.slice(4)) }).toEqual({ name, leaks: false });
    }
  });

  test("a session whose row names another principal or workspace is refused", async () => {
    const h = await withPassword();
    h.db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", [
      "ws_someone_else",
      "other",
      START,
    ]);
    const forged = [
      { principal: "pr_someone_else", workspace: LOCAL_PRINCIPAL.workspaceId },
      { principal: LOCAL_PRINCIPAL.id, workspace: "ws_someone_else" },
    ];
    for (const [i, row] of forged.entries()) {
      const token = `hls_forged-${i}-${"a".repeat(32)}`;
      h.db.run(
        `INSERT INTO login_session (id_hash, workspace_id, principal_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          createHash("sha256").update(token).digest("hex"),
          row.workspace,
          row.principal,
          START,
          START + SESSION_TTL_MS,
        ],
      );
      const res = await echo(h, { cookie: `${SESSION_COOKIE}=${token}` });
      expect({ row, status: res.status }).toEqual({ row, status: 401 });
    }
    expect(h.commands).toHaveLength(0);
  });

  test("a password over the length cap is refused without running the KDF", async () => {
    const h = await withPassword();
    const verifies = h.kdf.verifies.length;
    for (const extra of [1, 1000, 1_000_000]) {
      const res = await login(h, "a".repeat(PASSWORD_MAX_LENGTH + extra));
      expect({ extra, status: res.status }).toEqual({ extra, status: 401 });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(h.kdf.verifies).toHaveLength(verifies);
    // At the cap the KDF still runs: the bound is "over", not "at".
    expect((await login(h, "a".repeat(PASSWORD_MAX_LENGTH))).status).toBe(401);
    expect(h.kdf.verifies).toHaveLength(verifies + 1);

    const fresh = harness();
    const token = fresh.auth.setupToken() ?? "";
    const long = await setup(fresh, token, "a".repeat(PASSWORD_MAX_LENGTH + 1));
    expect(long.status).toBe(400);
    expect(fresh.kdf.hashes).toHaveLength(0);
    expect(fresh.auth.setupRequired()).toBe(true);
  });

  test("a password is compared in NFC, so composed and decomposed input both log in", async () => {
    const composed = "caf\u00e9 cr\u00e8me br\u00fbl\u00e9e";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    expect(decomposed.normalize("NFC")).toBe(composed);

    // Set in NFC, typed in NFD.
    const a = harness();
    expect((await setup(a, a.auth.setupToken() ?? "", composed)).status).toBe(201);
    expect((await login(a, decomposed)).status).toBe(200);
    expect((await login(a, composed)).status).toBe(200);
    expect(a.kdf.hashes).toEqual([composed]);
    expect(a.kdf.verifies).toEqual([composed, composed]);

    // Set in NFD, typed in NFC.
    const b = harness();
    expect((await setup(b, b.auth.setupToken() ?? "", decomposed)).status).toBe(201);
    expect(b.kdf.hashes).toEqual([composed]);
    expect((await login(b, composed)).status).toBe(200);
    expect((await login(b, decomposed)).status).toBe(200);
    // A different password is still wrong after normalization.
    expect((await login(b, composed.replace("\u00e9", "e"))).status).toBe(401);
  });

  test("NFC, not NFKC: a ligature and fullwidth letters reach the KDF as typed", async () => {
    // U+FB01 "ﬁ" and fullwidth "ｐａｓｓ": NFKC would fold them to ASCII "fi" and "pass".
    const typed = "\ufb01ne \uff50\uff41\uff53\uff53 phrase";
    const folded = "fine pass phrase";
    expect(typed.normalize("NFC")).toBe(typed);
    expect(typed.normalize("NFKC")).toBe(folded);

    const h = harness();
    expect((await setup(h, h.auth.setupToken() ?? "", typed)).status).toBe(201);
    expect(h.kdf.hashes).toEqual([typed]);
    expect((await login(h, folded)).status).toBe(401);
    expect((await login(h, "\ufb01ne pass phrase")).status).toBe(401);
    expect((await login(h, typed)).status).toBe(200);
    expect(h.kdf.verifies).toEqual([folded, "\ufb01ne pass phrase", typed]);
  });

  test("the length cap applies to the NFC form: a long password typed in NFD still logs in", async () => {
    const composed = "\u00e9".repeat(700);
    const decomposed = composed.normalize("NFD");
    expect(decomposed.length).toBe(1400);
    expect(decomposed.length).toBeGreaterThan(PASSWORD_MAX_LENGTH);

    const h = harness();
    expect((await setup(h, h.auth.setupToken() ?? "", composed)).status).toBe(201);
    expect((await login(h, decomposed)).status).toBe(200);
    expect(h.kdf.verifies).toEqual([composed]);

    // Set in NFD too: the 1400 units count as 700.
    const b = harness();
    expect((await setup(b, b.auth.setupToken() ?? "", decomposed)).status).toBe(201);
    expect(b.kdf.hashes).toEqual([composed]);
  });

  test("input over the raw cap is refused before NFC and the KDF; at the cap it is normalized", async () => {
    // Record the length of every string normalized while a request runs.
    const original = String.prototype.normalize;
    const normalized: number[] = [];
    String.prototype.normalize = function (this: string, form?: string) {
      normalized.push(this.length);
      return original.call(this, form);
    };
    try {
      const h = await withPassword();
      const verifies = h.kdf.verifies.length;
      normalized.length = 0;
      for (const extra of [1, 100_000]) {
        const res = await login(h, "a".repeat(PASSWORD_RAW_MAX_LENGTH + extra));
        expect({ extra, status: res.status }).toEqual({ extra, status: 401 });
      }
      expect(h.kdf.verifies).toHaveLength(verifies);
      expect(normalized.filter((n) => n > PASSWORD_RAW_MAX_LENGTH)).toEqual([]);

      // Exactly at the raw cap: 1024 × U+1F8F typed decomposed (4 units each)
      // is 1024 units in NFC, so it reaches the KDF.
      const atCap = "\u1f8f".repeat(PASSWORD_MAX_LENGTH).normalize("NFD");
      expect(atCap.length).toBe(PASSWORD_RAW_MAX_LENGTH);
      expect((await login(h, atCap)).status).toBe(401);
      expect(h.kdf.verifies.slice(verifies)).toEqual(["\u1f8f".repeat(PASSWORD_MAX_LENGTH)]);

      const fresh = harness();
      normalized.length = 0;
      const res = await setup(
        fresh,
        fresh.auth.setupToken() ?? "",
        "a".repeat(PASSWORD_RAW_MAX_LENGTH + 1),
      );
      expect(res.status).toBe(400);
      expect(fresh.kdf.hashes).toHaveLength(0);
      expect(normalized.filter((n) => n > PASSWORD_RAW_MAX_LENGTH)).toEqual([]);
      expect(fresh.auth.setupRequired()).toBe(true);
    } finally {
      String.prototype.normalize = original;
    }
  });

  test("NFC can grow input (U+FB2C is three units in NFC); the KDF still gets at most the cap", async () => {
    const typed = "\ufb2c".repeat(PASSWORD_MAX_LENGTH);
    expect(typed.length).toBe(PASSWORD_MAX_LENGTH);
    expect(typed.normalize("NFC").length).toBe(3 * PASSWORD_MAX_LENGTH);

    const h = await withPassword();
    const verifies = h.kdf.verifies.length;
    expect((await login(h, typed)).status).toBe(401);
    expect(h.kdf.verifies).toHaveLength(verifies);

    const fresh = harness();
    const res = await setup(fresh, fresh.auth.setupToken() ?? "", typed);
    expect(res.status).toBe(400);
    expect(fresh.kdf.hashes).toHaveLength(0);

    // 341 units that grow to exactly the cap are accepted; one more unit is refused.
    const fits = `${"\ufb2c".repeat(341)}a`;
    expect(fits.normalize("NFC").length).toBe(PASSWORD_MAX_LENGTH);
    const g = harness();
    expect((await setup(g, g.auth.setupToken() ?? "", fits)).status).toBe(201);
    expect(g.kdf.hashes.map((p) => p.length)).toEqual([PASSWORD_MAX_LENGTH]);
    expect((await login(g, `${fits}b`)).status).toBe(401);
    expect((await login(g, fits)).status).toBe(200);
    expect(g.kdf.verifies.map((p) => p.length)).toEqual([PASSWORD_MAX_LENGTH]);
    for (const p of [...g.kdf.hashes, ...g.kdf.verifies, ...h.kdf.verifies, ...fresh.kdf.hashes]) {
      expect(p.length).toBeLessThanOrEqual(PASSWORD_MAX_LENGTH);
    }
  });
});

describe("logout", () => {
  test("ends the session on the server, not only in the browser", async () => {
    const h = await withPassword();
    const other = cookieOf(await login(h, PASSWORD));
    const res = await post(h, "/v1/auth/logout", {}, { cookie: h.cookie });
    expect(res.status).toBe(204);
    expect(attributes(res)).toEqual([
      `${SESSION_COOKIE}=`,
      "Path=/",
      "Max-Age=0",
      "HttpOnly",
      "SameSite=Strict",
    ]);
    // Replaying the old cookie value does not work.
    expect((await echo(h, { cookie: h.cookie })).status).toBe(401);
    expect((await post(h, "/v1/auth/logout", {}, { cookie: h.cookie })).status).toBe(401);
    // Other sessions are untouched.
    expect((await echo(h, { cookie: other })).status).toBe(200);
    expect(h.sessions()).toBe(1);
  });
});

describe("cookie flags", () => {
  test("HttpOnly, SameSite=Strict, Path=/, Max-Age of the TTL; not Secure over plain HTTP", async () => {
    const h = harness();
    const res = await setup(h, h.auth.setupToken() ?? "", PASSWORD);
    const [pair, ...flags] = attributes(res);
    expect(pair).toMatch(new RegExp(`^${SESSION_COOKIE}=hls_`));
    expect(flags).toEqual([
      "Path=/",
      `Max-Age=${SESSION_TTL_MS / 1000}`,
      "HttpOnly",
      "SameSite=Strict",
    ]);
    const relogin = await login(h, PASSWORD);
    expect(attributes(relogin).slice(1)).toEqual(flags);
  });

  test("Secure when the request is HTTPS", async () => {
    const h = await withPassword();
    const res = await h.app.request("https://localhost/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    expect(attributes(res)).toContain("Secure");
    expect(attributes(res)).toContain("HttpOnly");
    expect(attributes(res)).toContain("SameSite=Strict");
  });

  test("Secure behind a TLS proxy (HEARTH_PUBLIC_ORIGIN is https), on login and logout", async () => {
    const h = await withPassword({ app: { publicOrigin: "https://hearth.example" } });
    const res = await login(h, PASSWORD, {
      host: "hearth.example",
      origin: "https://hearth.example",
    });
    expect(res.status).toBe(200);
    expect(attributes(res)).toContain("Secure");
    const out = await post(h, "/v1/auth/logout", {}, { cookie: cookieOf(res) });
    expect(attributes(out)).toContain("Secure");

    const plain = await withPassword({ app: { publicOrigin: "http://hearth.lan" } });
    expect(attributes(await login(plain, PASSWORD))).not.toContain("Secure");
  });
});

describe("cross-origin requests (decision 0010 guard, before the login)", () => {
  const foreign: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "http://localhost:3000" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { host: "attacker.example" },
  ];

  test("cannot log in, set up, log out or run a command, even with a valid cookie", async () => {
    const h = await withPassword();
    const verifies = h.kdf.verifies.length;
    const sessions = h.sessions();
    for (const headers of foreign) {
      const status = headers["host"] === undefined ? 403 : 421;
      expect((await login(h, PASSWORD, headers)).status).toBe(status);
      expect((await echo(h, { ...headers, cookie: h.cookie })).status).toBe(status);
      expect((await post(h, "/v1/auth/logout", {}, { ...headers, cookie: h.cookie })).status).toBe(
        status,
      );
    }
    // A CSRF form post: text/plain, no preflight.
    const form = await h.app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain", cookie: h.cookie },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(form.status).toBe(415);
    expect(h.kdf.verifies).toHaveLength(verifies);
    expect(h.sessions()).toBe(sessions);
    expect(h.commands).toHaveLength(0);
    // The session survived the cross-origin logout attempts.
    expect((await echo(h, { cookie: h.cookie })).status).toBe(200);
  });

  test("a cross-origin page cannot claim a fresh install", async () => {
    const h = harness();
    const token = h.auth.setupToken() ?? "";
    for (const headers of foreign) {
      expect((await setup(h, token, PASSWORD, headers)).status).toBeGreaterThanOrEqual(403);
    }
    expect(h.auth.setupRequired()).toBe(true);
  });

  test("the request guard answers first: a foreign caller learns nothing about the login", async () => {
    const h = await withPassword();
    for (const headers of foreign) {
      const status = headers["host"] === undefined ? 403 : 421;
      // Without a cookie too: 403/421 from the 0010 guard, never 401.
      expect((await echo(h, headers)).status).toBe(status);
      expect((await post(h, "/v1/sessions", {}, headers)).status).toBe(status);
    }
  });
});

describe("prototype exit criterion (PRD §11.1): no session and no command without login", () => {
  test("unauthenticated or cross-origin requests create no session and run nothing", async () => {
    const h = await withPassword();
    const sessions = h.sessions();
    const attempts: Promise<Response>[] = [
      echo(h),
      echo(h, { origin: "https://evil.example" }),
      echo(h, { origin: "https://evil.example", cookie: h.cookie }),
      echo(h, { "sec-fetch-site": "cross-site", cookie: h.cookie }),
      post(h, "/v1/sessions", { title: "x" }),
      post(h, "/v1/sessions", { title: "x" }, { origin: "https://evil.example", cookie: h.cookie }),
      // Starting a box has no HTTP route yet (`hub.startBox` is in-process);
      // a future one under /v1/boxes sits behind the same two guards.
      post(h, "/v1/boxes", { image: "x" }),
      post(h, "/v1/boxes/box_1/start", {}, { origin: "https://evil.example", cookie: h.cookie }),
      login(h, PASSWORD, { origin: "https://evil.example" }),
      login(h, "wrong password!"),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(h.commands).toHaveLength(0);
    expect(h.sessions()).toBe(sessions);
  });
});

describe("rate limit", () => {
  test(`${LOGIN_RATE_LIMIT.maxAttempts} failures per ${LOGIN_RATE_LIMIT.windowMs / 60_000} min, then 429 even for the right password`, async () => {
    expect(LOGIN_RATE_LIMIT).toEqual({ maxAttempts: 10, windowMs: 15 * 60_000 });
    const h = await withPassword();
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      expect((await login(h, `wrong ${i}`)).status).toBe(401);
    }
    const verifies = h.kdf.verifies.length;
    const limited = await login(h, PASSWORD);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "auth.rate-limited" } });
    expect(limited.headers.get("retry-after")).toBe(String(LOGIN_RATE_LIMIT.windowMs / 1000));
    expect(limited.headers.get("set-cookie")).toBeNull();
    // Refused before the KDF runs.
    expect(h.kdf.verifies).toHaveLength(verifies);

    h.clock += LOGIN_RATE_LIMIT.windowMs - 1;
    expect((await login(h, PASSWORD)).status).toBe(429);
    h.clock += 1;
    expect((await login(h, PASSWORD)).status).toBe(200);
  });

  test("the window slides: the oldest failure leaving frees one attempt", async () => {
    const h = await withPassword({ auth: { rateLimit: { maxAttempts: 3, windowMs: 1_000 } } });
    expect((await login(h, "wrong a")).status).toBe(401);
    h.clock += 500;
    expect((await login(h, "wrong b")).status).toBe(401);
    expect((await login(h, "wrong c")).status).toBe(401);
    expect((await login(h, PASSWORD)).status).toBe(429);
    h.clock += 500;
    expect((await login(h, "wrong d")).status).toBe(401);
    expect((await login(h, PASSWORD)).status).toBe(429);
    h.clock += 500;
    expect((await login(h, PASSWORD)).status).toBe(200);
  });

  test("a success clears the count", async () => {
    const h = await withPassword({ auth: { rateLimit: { maxAttempts: 3, windowMs: 60_000 } } });
    expect((await login(h, "wrong a")).status).toBe(401);
    expect((await login(h, "wrong b")).status).toBe(401);
    expect((await login(h, PASSWORD)).status).toBe(200);
    expect((await login(h, "wrong c")).status).toBe(401);
    expect((await login(h, "wrong d")).status).toBe(401);
    expect((await login(h, PASSWORD)).status).toBe(200);
  });

  test("a parallel burst cannot get more guesses to the KDF than the limit", async () => {
    const h = await withPassword();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => login(h, `burst guess ${i}`)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(LOGIN_RATE_LIMIT.maxAttempts);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30 - LOGIN_RATE_LIMIT.maxAttempts);
    expect(h.kdf.verifies).toHaveLength(LOGIN_RATE_LIMIT.maxAttempts);
  });

  test("setup-token guesses share the limit", async () => {
    const h = harness({ auth: { rateLimit: { maxAttempts: 2, windowMs: 60_000 } } });
    const token = h.auth.setupToken() ?? "";
    expect((await setup(h, "hst_guess1", PASSWORD)).status).toBe(403);
    expect((await setup(h, "hst_guess2", PASSWORD)).status).toBe(403);
    expect((await setup(h, token, PASSWORD)).status).toBe(429);
    expect(h.auth.setupRequired()).toBe(true);
  });
});

describe("timing-safe comparison", () => {
  test("secretsEqual compares fixed-size digests: any length, no early exit, no throw", () => {
    const secret = "hst_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    expect(secretsEqual(secret, secret)).toBe(true);
    expect(secretsEqual(secret, `${secret.slice(0, -1)}H`)).toBe(false);
    expect(secretsEqual(secret, `x${secret.slice(1)}`)).toBe(false);
    // Different lengths: crypto.timingSafeEqual alone would throw here.
    expect(secretsEqual(secret, secret.slice(0, 10))).toBe(false);
    expect(secretsEqual(secret, "")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
  });

  test("secretsEqual takes as long for a first-byte miss as for a last-byte miss", () => {
    // Large inputs make a short-circuiting comparison (`===`, a byte loop that
    // stops early) differ by orders of magnitude; hashing both sides first
    // costs the same either way. Medians and a wide margin keep load out.
    const size = 1 << 20;
    const secret = `${"s".repeat(size)}`;
    const firstMiss = `x${"s".repeat(size - 1)}`;
    const lastMiss = `${"s".repeat(size - 1)}x`;
    const time = (b: string) => {
      const t = Bun.nanoseconds();
      secretsEqual(secret, b);
      return Bun.nanoseconds() - t;
    };
    // Interleaved, so a burst of load hits both sides alike.
    const first: number[] = [];
    const last: number[] = [];
    for (let i = 0; i < 41; i++) {
      first.push(time(firstMiss));
      last.push(time(lastMiss));
    }
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[20] ?? 0;
    const ratio = median(last) / median(first);
    // A short-circuiting compare gives a ratio in the hundreds.
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  });

  test("every admitted wrong password goes through the KDF's own comparison", async () => {
    const h = await withPassword();
    const wrongs = [
      "a",
      PASSWORD.slice(0, 1),
      PASSWORD.slice(0, -1),
      `${PASSWORD}x`,
      "z".repeat(64),
    ];
    for (const wrong of wrongs) expect((await login(h, wrong)).status).toBe(401);
    expect(h.kdf.verifies).toEqual(wrongs);
  });

  test("Bun's argon2id verify gives the same answer for near and far misses", async () => {
    const kdf: PasswordKdf = argon2idKdf({ memoryCost: 256, timeCost: 1 });
    const hash = await kdf.hash(PASSWORD);
    expect(await kdf.verify(PASSWORD, hash)).toBe(true);
    expect(await kdf.verify(PASSWORD.slice(0, -1), hash)).toBe(false);
    expect(await kdf.verify("", hash)).toBe(false);
  });
});
