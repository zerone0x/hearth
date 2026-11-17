/**
 * The hub vault (decision 0031) over a real SQLite file: key handling, the
 * disabled state, AAD tamper checks on stored rows, scope and kind, master-key
 * and data-key rotation, audit of every use, and redaction.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AllowAllAuthorizer,
  type AuditRecord,
  type AuditSink,
  createDefaultSecretStore,
  LOCAL_PRINCIPAL,
  type Principal,
  type SecretError,
  type SecretStore,
  VaultSecretResolver,
} from "@hearth/core";
import { Hono } from "hono";
import { type HubEnv, SESSION_COOKIE } from "../auth";
import { lineFields, lineLevel } from "../obs/hub-log";
import { knownSecrets, redactHub, registerSecret } from "../obs/redaction";
import { observabilityFromEnv } from "../obs/setup";
import { Telemetry } from "../obs/telemetry";
import { RequestBody } from "../request-body";
import { redactSecrets, SessionRunners } from "../runner";
import { LiveToolOutput } from "../runner/live-output";
import { startHub } from "../server";
import {
  openDatabase,
  SqliteAuditSink,
  SqliteBlobStore,
  SqliteEventStore,
  SqliteVaultStore,
} from "../store";
import { dumpTrajectory, UnredactedDumpError } from "../trajectory-cli";
import { HubVault, mountVaultRoutes, type VaultStatus } from ".";

const KEY_A = Buffer.alloc(32, 0xa1).toString("base64");
const KEY_B = Buffer.alloc(32, 0xb2).toString("base64");

/** Distinctive values: the redaction registry is process-wide. */
const MODEL_KEY = "sk-vault-test-model-4f1c9e";
const MODEL_KEY_2 = "sk-vault-test-model-rotated-8d2a";
const LOGIN = { username: "vault-test-user-31", password: "vault-test-pw-6b0e7a" };
const TOKEN = "ghp_vaultTestToken9c3d";

let dir: string;
let path: string;
let dbs: Database[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-vault-"));
  path = join(dir, "hub.db");
  dbs = [];
});
afterEach(() => {
  for (const db of dbs) db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly vault: HubVault;
  readonly db: Database;
  readonly secrets: SecretStore;
  readonly registered: string[];
  readonly logs: string[];
  readonly status: VaultStatus;
}

interface Start {
  readonly env?: Record<string, string>;
  readonly keyRef?: string | undefined;
  readonly nextKeyRef?: string;
  readonly audit?: (db: Database) => AuditSink;
  readonly midRotation?: () => void;
}

/** A hub start: a new connection, store and vault on the same database file. */
async function start(options: Start = {}): Promise<Harness> {
  const db = openDatabase(path);
  dbs.push(db);
  const env = { PLAIN: "plain-env-value", ...options.env };
  const audit = options.audit?.(db) ?? new SqliteAuditSink(db);
  const registered: string[] = [];
  const logs: string[] = [];
  const vault = new HubVault({
    store: new SqliteVaultStore(db, {
      ...(options.midRotation === undefined ? {} : { midRotation: options.midRotation }),
    }),
    authorizer: new AllowAllAuthorizer({ audit }),
    audit,
    keySecrets: createDefaultSecretStore({ env }),
    ...("keyRef" in options
      ? options.keyRef === undefined
        ? {}
        : { keyRef: options.keyRef }
      : { keyRef: "env:VAULT_KEY" }),
    ...(options.nextKeyRef === undefined ? {} : { nextKeyRef: options.nextKeyRef }),
    log: (line) => logs.push(line),
    register: (value) => registered.push(value),
  });
  const secrets = createDefaultSecretStore({
    env,
    resolvers: [new VaultSecretResolver(vault)],
  });
  const status = await vault.open();
  return { vault, db, secrets, registered, logs, status };
}

async function addModelKey(h: Harness, name = "model", value = MODEL_KEY) {
  return h.vault.create(LOCAL_PRINCIPAL, {
    name,
    kind: "model-key",
    meta: { provider: "anthropic" },
    fields: { value },
  });
}

async function errorOf(promise: Promise<unknown>): Promise<SecretError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as SecretError;
}

function auditRows(db: Database, action: string) {
  return db
    .query<
      { resource_id: string | null; detail_json: string | null; principal_kind: string },
      [string]
    >("SELECT resource_id, detail_json, principal_kind FROM audit WHERE action = ? ORDER BY id")
    .all(action);
}

function kekCheck(db: Database): string {
  return db.query<{ k: string }, []>("SELECT kek_check AS k FROM vault_key").get()?.k ?? "";
}

function fingerprintOf(db: Database, name: string): string {
  return (
    db
      .query<{ f: string }, [string]>("SELECT fingerprint AS f FROM secret WHERE name = ?")
      .get(name)?.f ?? ""
  );
}

function addSession(db: Database, id: string) {
  db.run(
    `INSERT INTO session (id, workspace_id, title, state, last_activity_at, created_at)
     VALUES (?, 'ws_default', 't', 'idle', 0, 0)`,
    [id],
  );
}

describe("vault key", () => {
  test("a first start with a valid key creates one wrapped data key and resolves vault: refs", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    expect(h.status).toMatchObject({ state: "enabled", key: "current" });
    expect(h.db.query("SELECT count(*) AS n FROM vault_key").get()).toEqual({ n: 1 });
    expect(auditRows(h.db, "vault.key.create")).toHaveLength(1);
    expect(h.logs).toContain("vault: created the data key");
    expect(h.logs.join("\n")).toContain("vault: enabled (kek_check ");
    await addModelKey(h);
    expect((await h.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
    expect((await h.secrets.resolve("vault:model#value")).reveal()).toBe(MODEL_KEY);
    // The key text itself joins the redaction set.
    expect(h.registered).toContain(KEY_A);
    // A second start finds the data key: nothing is created or audited again.
    const again = await start({ env: { VAULT_KEY: KEY_A } });
    expect(auditRows(again.db, "vault.key.create")).toHaveLength(1);
    expect(again.logs).not.toContain("vault: created the data key");
  });

  const disabled: [string, Start, string][] = [
    ["no key reference", { keyRef: undefined }, "key-missing"],
    ["a key file that does not exist", { keyRef: "file:/nonexistent/vault_key" }, "key-missing"],
    ["an unset env key", { keyRef: "env:VAULT_KEY" }, "key-missing"],
    [
      "a key of 16 bytes",
      { env: { VAULT_KEY: Buffer.alloc(16, 1).toString("base64") } },
      "key-invalid",
    ],
    [
      "a key that is not base64",
      { env: { VAULT_KEY: "correct horse battery staple" } },
      "key-invalid",
    ],
    ["a vault: key reference", { keyRef: "vault:loop" }, "key-invalid"],
  ];
  for (const [what, options, reason] of disabled) {
    test(`${what}: the vault is disabled (${reason}) and env:/file: keep working`, async () => {
      const keyFile = join(dir, "model_key");
      writeFileSync(keyFile, "file-model-key\n");
      const h = await start(options);
      expect(h.status).toMatchObject({ state: "disabled", reason });
      expect(await h.vault.status(LOCAL_PRINCIPAL)).toEqual(h.status);
      expect(h.vault.currentStatus).toEqual(h.status);
      expect(h.logs.join("\n")).toContain(`vault: disabled (${reason}): `);
      expect((await h.secrets.resolve("env:PLAIN")).reveal()).toBe("plain-env-value");
      expect((await h.secrets.resolve(`file:${keyFile}`)).reveal()).toBe("file-model-key");
      const error = await errorOf(h.secrets.resolve("vault:model"));
      expect(error.code).toBe("vault.disabled");
      const create = await errorOf(addModelKey(h));
      expect((create as unknown as { code: string }).code).toBe("vault.disabled");
      // Nothing is generated into the database without a key.
      expect(h.db.query("SELECT count(*) AS n FROM vault_key").get()).toEqual({ n: 0 });
    });
  }

  test("a wrong key: key-mismatch with both kek_checks, nothing rewritten; the right key recovers", async () => {
    const first = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(first);
    const before = first.db
      .query<{ w: Uint8Array; k: string }, []>(
        "SELECT wrapped_dek AS w, kek_check AS k FROM vault_key",
      )
      .get();
    const wrong = await start({ env: { VAULT_KEY: KEY_B } });
    expect(wrong.status).toMatchObject({ state: "disabled", reason: "key-mismatch" });
    const status = wrong.status as Extract<VaultStatus, { state: "disabled" }>;
    expect(status.expectedKekCheck).toBe(kekCheck(wrong.db).slice(0, 12));
    expect(status.foundKekCheck).toMatch(/^[0-9a-f]{12}$/);
    expect(status.foundKekCheck).not.toBe(status.expectedKekCheck);
    expect((await errorOf(wrong.secrets.resolve("vault:model"))).code).toBe("vault.disabled");
    expect((await wrong.secrets.resolve("env:PLAIN")).reveal()).toBe("plain-env-value");
    const after = wrong.db
      .query<{ w: Uint8Array; k: string }, []>(
        "SELECT wrapped_dek AS w, kek_check AS k FROM vault_key",
      )
      .get();
    expect(after).toEqual(before);
    const right = await start({ env: { VAULT_KEY: KEY_A } });
    expect(right.status).toMatchObject({ state: "enabled" });
    expect((await right.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
  });

  test("a key that goes missing after the data key exists: key-missing, not corrupt", async () => {
    await start({ env: { VAULT_KEY: KEY_A } });
    const gone = await start({ keyRef: "file:/nonexistent/vault_key" });
    expect(gone.status).toMatchObject({ state: "disabled", reason: "key-missing" });
    const bad = await start({ env: { VAULT_KEY: "short" } });
    expect(bad.status).toMatchObject({ state: "disabled", reason: "key-invalid" });
  });

  test("a damaged wrapped data key under a matching key: store-corrupt", async () => {
    const first = await start({ env: { VAULT_KEY: KEY_A } });
    first.db.run("UPDATE vault_key SET wrapped_dek = zeroblob(40)");
    const again = await start({ env: { VAULT_KEY: KEY_A } });
    expect(again.status).toMatchObject({ state: "disabled", reason: "store-corrupt" });
  });
});

describe("stored rows are bound by the AAD", () => {
  test("swapping two rows' ciphertexts: both fail with vault.entry-corrupt, audited", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(h, "one", MODEL_KEY);
    await addModelKey(h, "two", MODEL_KEY_2);
    const rows = h.db
      .query<{ name: string; iv: Uint8Array; ciphertext: Uint8Array }, []>(
        "SELECT name, iv, ciphertext FROM secret ORDER BY name",
      )
      .all();
    const [one, two] = rows;
    if (one === undefined || two === undefined) throw new Error("two rows expected");
    const put = h.db.query("UPDATE secret SET iv = ?, ciphertext = ? WHERE name = ?");
    put.run(two.iv, two.ciphertext, one.name);
    put.run(one.iv, one.ciphertext, two.name);
    for (const name of ["one", "two"]) {
      const error = await errorOf(h.secrets.resolve(`vault:${name}`));
      expect(error.code).toBe("vault.entry-corrupt");
      expect(error.message).not.toContain(MODEL_KEY);
      expect(error.message).not.toContain(MODEL_KEY_2);
    }
    const refused = auditRows(h.db, "secret.use-refused").map((r) =>
      JSON.parse(r.detail_json ?? "{}"),
    );
    expect(refused.map((d) => d.code)).toEqual(["vault.entry-corrupt", "vault.entry-corrupt"]);
    expect(auditRows(h.db, "secret.use")).toHaveLength(0);
  });

  test("an origin added to a login's policy in SQL: the use fails", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "login",
      policy: { origins: ["https://github.com"] },
      fields: LOGIN,
    });
    const use = () =>
      h.vault.use("vault:github#password", {
        sessionId: "ses_1",
        tool: "browser_fill",
        origin: "https://github.com",
        kinds: ["login"],
      });
    expect((await use()).value.reveal()).toBe(LOGIN.password);
    h.db.run(
      `UPDATE secret SET policy_json = '{"allow_any_field":false,"origins":["https://evil.example","https://github.com"]}'`,
    );
    expect((await errorOf(use())).code).toBe("vault.entry-corrupt");
  });

  test("allow_any_field turned on in SQL: the use fails", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "login",
      policy: { origins: ["https://github.com"] },
      fields: LOGIN,
    });
    h.db.run(
      `UPDATE secret SET policy_json = '{"allow_any_field":true,"origins":["https://github.com"]}'`,
    );
    const error = await errorOf(
      h.vault.use("vault:github", { sessionId: "ses_1", tool: "browser_fill", kinds: ["login"] }),
    );
    expect(error.code).toBe("vault.entry-corrupt");
  });

  test("a session-scoped entry made global in SQL: the use fails", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "scoped",
      kind: "model-key",
      scope: { sessionId: "ses_1" },
      fields: { value: MODEL_KEY },
    });
    h.db.run("UPDATE secret SET scope_session_id = NULL");
    expect((await errorOf(h.secrets.resolve("vault:scoped"))).code).toBe("vault.entry-corrupt");
  });

  test("a version rolled back in SQL: the use fails", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const { id } = await addModelKey(h);
    await h.vault.rotate(LOCAL_PRINCIPAL, id, { fields: { value: MODEL_KEY_2 } });
    h.db.run("UPDATE secret SET version = 1");
    expect((await errorOf(h.secrets.resolve("vault:model"))).code).toBe("vault.entry-corrupt");
  });
});

test("vault log lines: component vault, warn when disabled or mid-rotation", () => {
  expect(lineFields("vault: enabled (kek_check 0123456789ab)")).toEqual({ component: "vault" });
  expect(lineLevel("vault: enabled (kek_check 0123456789ab)")).toBe("info");
  expect(lineLevel("vault: disabled (key-missing): x")).toBe("warn");
  expect(lineLevel("vault: running on vault_key.next, the rotation is committed")).toBe("warn");
  expect(lineLevel("vault: key rotation failed, still on the current key: x")).toBe("error");
  expect(
    lineLevel("vault: the key file /k is readable by others (mode 644); run chmod 600 on it"),
  ).toBe("warn");
});

test("a key file others can read is used, with a warning at every start", async () => {
  const keyFile = join(dir, "vault_key");
  writeFileSync(keyFile, `${KEY_A}\n`);
  for (const mode of [0o644, 0o640, 0o604]) {
    chmodSync(keyFile, mode);
    const shared = await start({ keyRef: `file:${keyFile}` });
    expect(shared.status).toMatchObject({ state: "enabled" });
    expect(shared.logs).toContain(
      `vault: the key file ${keyFile} is readable by others (mode ${mode.toString(8)}); run chmod 600 on it`,
    );
    expect(shared.logs.join("\n")).not.toContain(KEY_A);
  }
  chmodSync(keyFile, 0o600);
  const tight = await start({ keyRef: `file:${keyFile}` });
  expect(tight.status).toMatchObject({ state: "enabled" });
  expect(tight.logs.join("\n")).not.toContain("readable by others");
  // An env: key is not a file, even when a file of that name is at hand.
  const cwd = process.cwd();
  writeFileSync(join(dir, "VAULT_KEY"), "x");
  chmodSync(join(dir, "VAULT_KEY"), 0o644);
  process.chdir(dir);
  try {
    const env = await start({ env: { VAULT_KEY: KEY_A } });
    expect(env.logs.join("\n")).not.toContain("readable by others");
  } finally {
    process.chdir(cwd);
  }
});

describe("input checks", () => {
  const bad: [string, unknown][] = [
    ["a body that is not an object", ["x"]],
    ["a null body", null],
    ["meta that is an array", { name: "a", kind: "token", meta: [], fields: { value: "v" } }],
    [
      "a scope whose session is not a string",
      { name: "a", kind: "token", scope: { sessionId: 5 }, fields: { value: "v" } },
    ],
    [
      "a scope that is an array",
      { name: "a", kind: "token", scope: ["ses_1"], fields: { value: "v" } },
    ],
    ["an unknown field", { name: "a", kind: "token", fields: { value: "v" }, extra: 1 }],
    ["a bad name", { name: "A b", kind: "token", fields: { value: "v" } }],
    ["a bad kind", { name: "a", kind: "password", fields: { value: "v" } }],
    ["meta that is not an object", { name: "a", kind: "token", meta: "x", fields: { value: "v" } }],
    [
      "an unknown meta field",
      { name: "a", kind: "token", meta: { note: "x" }, fields: { value: "v" } },
    ],
    [
      "a meta value that is not a string",
      { name: "a", kind: "token", meta: { label: 1 }, fields: { value: "v" } },
    ],
    [
      "a meta value of 201 characters",
      { name: "a", kind: "token", meta: { label: "x".repeat(201) }, fields: { value: "v" } },
    ],
    [
      "a scope that is a string",
      { name: "a", kind: "token", scope: "ses_1", fields: { value: "v" } },
    ],
    [
      "a scope with an empty session",
      { name: "a", kind: "token", scope: { sessionId: "" }, fields: { value: "v" } },
    ],
    [
      "a scope with another key",
      { name: "a", kind: "token", scope: { sessionId: "ses_1", x: 1 }, fields: { value: "v" } },
    ],
    [
      "a scope with |",
      { name: "a", kind: "token", scope: { sessionId: "ses|1" }, fields: { value: "v" } },
    ],
    [
      "a missing field",
      {
        name: "a",
        kind: "login",
        policy: { origins: ["https://a.example"] },
        fields: { username: "u" },
      },
    ],
    ["a blank value", { name: "a", kind: "token", fields: { value: "  " } }],
  ];
  for (const [what, body] of bad) {
    test(`create refuses ${what} with request.invalid, writing nothing`, async () => {
      const h = await start({ env: { VAULT_KEY: KEY_A } });
      addSession(h.db, "ses_1");
      const error = await h.vault.create(LOCAL_PRINCIPAL, body).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "request.invalid" });
      expect(await h.vault.list(LOCAL_PRINCIPAL)).toEqual([]);
    });
  }

  test("meta of exactly 200 characters is kept, keys sorted; rotate takes only fields", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const label = "x".repeat(200);
    const { id } = await h.vault.create(LOCAL_PRINCIPAL, {
      name: "a",
      kind: "model-key",
      meta: { provider: "anthropic", label },
      fields: { value: MODEL_KEY },
    });
    const [view] = await h.vault.list(LOCAL_PRINCIPAL);
    expect(view?.meta).toEqual({ label, provider: "anthropic" });
    expect(h.db.query("SELECT meta_json AS m FROM secret").get()).toEqual({
      m: JSON.stringify({ label, provider: "anthropic" }),
    });
    for (const body of [{ fields: { value: "v2" }, name: "b" }, "x", { fields: { other: "v" } }]) {
      expect(
        await h.vault.rotate(LOCAL_PRINCIPAL, id, body).catch((e: unknown) => e),
      ).toMatchObject({
        code: "request.invalid",
      });
    }
    expect(
      (await errorOf(h.vault.rotate(LOCAL_PRINCIPAL, "sec_none", { fields: { value: "v" } }))).code,
    ).toBe("secret.not-found");
  });

  test("status opens the vault on first call and every API call is authorized (audited)", async () => {
    const db = openDatabase(path);
    dbs.push(db);
    const audit = new SqliteAuditSink(db);
    const vault = new HubVault({
      store: new SqliteVaultStore(db),
      authorizer: new AllowAllAuthorizer({ audit }),
      audit,
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      keyRef: "env:VAULT_KEY",
      log: () => {},
      register: () => {},
    });
    expect(vault.currentStatus).toEqual({ state: "starting" });
    expect(await vault.status(LOCAL_PRINCIPAL)).toMatchObject({ state: "enabled" });
    expect(vault.currentStatus).toMatchObject({ state: "enabled" });
    await vault.list(LOCAL_PRINCIPAL);
    await vault.uses(LOCAL_PRINCIPAL, "sec_x");
    for (const action of ["vault.status", "secret.list", "secret.uses"]) {
      expect(auditRows(db, action)).toHaveLength(1);
    }
    // A use before anyone opened the vault waits for the open, it does not fail.
    const fresh = new HubVault({
      store: new SqliteVaultStore(db),
      authorizer: new AllowAllAuthorizer({ audit }),
      audit,
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      keyRef: "env:VAULT_KEY",
      log: () => {},
      register: () => {},
    });
    await expect(fresh.readForHub("none", undefined, "vault:none")).rejects.toMatchObject({
      code: "secret.not-found",
    });
  });

  test("a store that throws at open: the vault is disabled (store-corrupt), not the hub", async () => {
    const db = openDatabase(path);
    dbs.push(db);
    const audit = new SqliteAuditSink(db);
    const store = new SqliteVaultStore(db);
    store.keyRecord = () => {
      throw new Error("database disk image is malformed");
    };
    const logs: string[] = [];
    const vault = new HubVault({
      store,
      authorizer: new AllowAllAuthorizer({ audit }),
      audit,
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      keyRef: "env:VAULT_KEY",
      log: (l) => logs.push(l),
    });
    expect(await vault.open()).toMatchObject({ state: "disabled", reason: "store-corrupt" });
    expect(logs.join("\n")).toContain("vault: could not open: database disk image is malformed");
  });
});

describe("writes", () => {
  test("a taken name is refused before anything is audited or stored", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(h);
    const error = await h.vault
      .create(LOCAL_PRINCIPAL, { name: "model", kind: "token", fields: { value: TOKEN } })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "secret.name-taken" });
    const detailed = auditRows(h.db, "secret.create").filter((r) => r.detail_json !== null);
    expect(detailed).toHaveLength(1);
  });

  test("a rotated value joins the redaction set; a row changed meanwhile is a conflict", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const { id } = await addModelKey(h);
    h.registered.length = 0;
    await h.vault.rotate(LOCAL_PRINCIPAL, id, { fields: { value: MODEL_KEY_2 } });
    expect(h.registered).toEqual([MODEL_KEY_2]);
    const store = new SqliteVaultStore(h.db);
    store.replaceValue = () => false;
    const raced = new HubVault({
      store,
      authorizer: new AllowAllAuthorizer({ audit: new SqliteAuditSink(h.db) }),
      audit: new SqliteAuditSink(h.db),
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      keyRef: "env:VAULT_KEY",
      log: () => {},
      register: () => {},
    });
    const error = await raced
      .rotate(LOCAL_PRINCIPAL, id, { fields: { value: "another-value-1f" } })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "secret.conflict" });
  });

  test("the store replaces a value only from the version it read", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const { id } = await addModelKey(h);
    const store = new SqliteVaultStore(h.db);
    const before = store.byId("ws_default", id);
    const next = {
      iv: new Uint8Array(12),
      ciphertext: new Uint8Array(32),
      fingerprint: "hmac:000000000000",
      version: 2,
      updatedAt: 5,
      policyJson: "{}",
    };
    for (const stale of [0, 2, 7]) {
      expect(store.replaceValue("ws_default", id, stale, next)).toBe(false);
    }
    expect(store.replaceValue("ws_other", id, 1, next)).toBe(false);
    expect(store.byId("ws_default", id)).toEqual(before);
    expect(store.replaceValue("ws_default", id, 1, next)).toBe(true);
    expect(store.byId("ws_default", id)?.version).toBe(2);
  });
});

describe("scope and kind", () => {
  test("a scoped entry is usable only in its session, never through the hub's store", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    addSession(h.db, "ses_2");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "scoped",
      kind: "token",
      scope: { sessionId: "ses_1" },
      policy: { use: "box-env" },
      fields: { value: TOKEN },
    });
    const ctx = (sessionId: string) => ({
      sessionId,
      tool: "bash",
      env: "API_TOKEN",
      kinds: ["token"] as const,
    });
    expect(
      (await h.vault.use("vault:scoped", { ...ctx("ses_1"), kinds: ["token"] })).value.reveal(),
    ).toBe(TOKEN);
    expect(
      (await errorOf(h.vault.use("vault:scoped", { ...ctx("ses_2"), kinds: ["token"] }))).code,
    ).toBe("vault.scope-mismatch");
    // A box-env token is never the hub's; a scoped hub token is not either.
    expect((await errorOf(h.secrets.resolve("vault:scoped"))).code).toBe("vault.kind-mismatch");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "scoped-hub",
      kind: "token",
      scope: { sessionId: "ses_1" },
      fields: { value: TOKEN },
    });
    expect((await errorOf(h.secrets.resolve("vault:scoped-hub"))).code).toBe(
      "vault.scope-mismatch",
    );
  });

  test("a scope naming no session is refused; a taken name is refused by the store too", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const error = await h.vault
      .create(LOCAL_PRINCIPAL, {
        name: "scoped",
        kind: "token",
        scope: { sessionId: "ses_missing" },
        fields: { value: TOKEN },
      })
      .catch((e: unknown) => e as { code: string });
    expect(error).toMatchObject({ code: "request.invalid" });
    await addModelKey(h);
    const [row] = new SqliteVaultStore(h.db).list("ws_default");
    if (row === undefined) throw new Error("one row expected");
    expect(() => new SqliteVaultStore(h.db).insert({ ...row, id: "sec_other" })).toThrow(
      expect.objectContaining({ code: "secret.name-taken" }),
    );
    // Any other constraint is rethrown as it is, never swallowed.
    expect(() =>
      new SqliteVaultStore(h.db).insert({
        ...row,
        id: "sec_third",
        name: "third",
        iv: new Uint8Array(11),
      }),
    ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }));
    expect(new SqliteVaultStore(h.db).byId("ws_default", "sec_third")).toBeUndefined();
  });

  test("a login and a box-env token are not handed to the hub's store", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "login",
      policy: { origins: ["https://github.com"] },
      fields: LOGIN,
    });
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "gh",
      kind: "token",
      policy: { use: "box-env" },
      fields: { value: TOKEN },
    });
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "hubtok",
      kind: "token",
      fields: { value: TOKEN },
    });
    expect((await errorOf(h.secrets.resolve("vault:github#password"))).code).toBe(
      "vault.kind-mismatch",
    );
    expect((await errorOf(h.secrets.resolve("vault:gh"))).code).toBe("vault.kind-mismatch");
    expect((await h.secrets.resolve("vault:hubtok")).reveal()).toBe(TOKEN);
    expect((await errorOf(h.secrets.resolve("vault:hubtok#password"))).code).toBe(
      "vault.field-unknown",
    );
    expect((await errorOf(h.secrets.resolve("vault:nope"))).code).toBe("secret.not-found");
    for (const ref of ["env:VAULT_KEY", "vault:Bad Name", "vault:hubtok#"]) {
      const error = await errorOf(
        h.vault.use(ref, { sessionId: "s", tool: "t", kinds: ["token"] }),
      );
      expect(error.code).toBe("secret.malformed-ref");
    }
  });
});

describe("tool uses: origin, policy and fields", () => {
  test("a login is handed out only on one of its origins; the use returns the authenticated policy", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "login",
      policy: { origins: ["https://github.com", "https://gist.github.com:8443"] },
      fields: LOGIN,
    });
    const use = (origin?: string, ref = "vault:github#password") =>
      h.vault.use(ref, {
        sessionId: "ses_1",
        tool: "browser_fill",
        ...(origin === undefined ? {} : { origin }),
        kinds: ["login"],
      });
    for (const origin of [
      undefined,
      "",
      "not a url",
      "https://evil.example",
      "https://github.com.evil.example",
      "https://evil.example/https://github.com",
      "http://github.com",
      "https://github.com:444",
      "https://gist.github.com",
      "wss://github.com",
      "blob:https://github.com/0b1c",
    ]) {
      const error = await errorOf(use(origin));
      expect(`${origin}: ${error.code}`).toBe(`${origin}: vault.origin-mismatch`);
      expect(error.message).not.toContain(LOGIN.password);
    }
    expect(auditRows(h.db, "secret.use")).toHaveLength(0);
    const refused = auditRows(h.db, "secret.use-refused");
    expect(refused).toHaveLength(11);
    expect(JSON.parse(refused[3]?.detail_json ?? "{}")).toMatchObject({
      code: "vault.origin-mismatch",
      origin: "https://evil.example",
    });
    // The page's origin, however it is spelled, and only then the value.
    for (const origin of [
      "https://github.com",
      "HTTPS://GitHub.com",
      "https://github.com:443",
      "https://github.com/login?next=/",
      "https://gist.github.com:8443",
    ]) {
      const used = await use(origin);
      expect(used.value.reveal()).toBe(LOGIN.password);
    }
    expect(auditRows(h.db, "secret.use")).toHaveLength(5);
    const used = await use("https://github.com", "vault:github#username");
    expect(used.value.reveal()).toBe(LOGIN.username);
    expect({ ...used, value: undefined }).toEqual({
      value: undefined,
      name: "github",
      kind: "login",
      field: "username",
      policy: {
        allow_any_field: false,
        origins: ["https://gist.github.com:8443", "https://github.com"],
      },
    });
    // A token has no origin to check; its policy comes back for the caller.
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "deploy",
      kind: "token",
      policy: { use: "box-env", hosts: ["API.example.com"] },
      fields: { value: TOKEN },
    });
    const token = await h.vault.use("vault:deploy", {
      sessionId: "ses_1",
      tool: "bash",
      env: "DEPLOY_TOKEN",
      kinds: ["token"],
    });
    expect(token.value.reveal()).toBe(TOKEN);
    expect(token.policy).toEqual({ hosts: ["api.example.com"], use: "box-env" });
    expect(token.field).toBe("value");
  });

  test("a field name that is not one of the kind's fields is refused, even an Object member", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    await addModelKey(h);
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "login",
      policy: { origins: ["https://github.com"] },
      fields: LOGIN,
    });
    for (const field of ["constructor", "tostring", "valueof", "hasownproperty", "value_x"]) {
      expect((await errorOf(h.secrets.resolve(`vault:model#${field}`))).code).toBe(
        "vault.field-unknown",
      );
    }
    for (const field of ["constructor", "value", "password_x"]) {
      const error = await errorOf(
        h.vault.use(`vault:github#${field}`, {
          sessionId: "ses_1",
          tool: "browser_fill",
          origin: "https://github.com",
          kinds: ["login"],
        }),
      );
      expect(`${field}: ${error.code}`).toBe(`${field}: vault.field-unknown`);
    }
    expect(auditRows(h.db, "secret.use")).toHaveLength(0);
  });
});

describe("box-env uses (decision 0041)", () => {
  const BOX_TOKEN = "ghp_boxEnvToken7d21aa";
  const bash = (sessionId: string, env = "GH_TOKEN") => ({
    sessionId,
    tool: "bash",
    toolCallId: "call_env",
    env,
    kinds: ["token"] as const,
  });

  test("an opted-in token is audited with its variable before it is handed out and registered", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    const { id } = await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "token",
      policy: { use: "box-env" },
      fields: { value: BOX_TOKEN },
    });
    h.registered.length = 0;
    const used = await h.vault.use("vault:github", bash("ses_1"));
    expect(used.value.reveal()).toBe(BOX_TOKEN);
    expect(h.registered).toEqual([BOX_TOKEN]);
    const rows = auditRows(h.db, "secret.use");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(id);
    expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toMatchObject({
      name: "github",
      kind: "token",
      consumer: "tool",
      session_id: "ses_1",
      tool: "bash",
      tool_call_id: "call_env",
      env: "GH_TOKEN",
    });
    expect(rows[0]?.detail_json).not.toContain(BOX_TOKEN);
  });

  test("anything but an opted-in token in scope is refused before decrypt: no secret.use, nothing registered", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    addSession(h.db, "ses_2");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "hub-token",
      kind: "token",
      fields: { value: TOKEN },
    });
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "site",
      kind: "login",
      policy: { origins: ["https://github.com"] },
      fields: LOGIN,
    });
    await addModelKey(h);
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "other-session",
      kind: "token",
      scope: { sessionId: "ses_2" },
      policy: { use: "box-env" },
      fields: { value: BOX_TOKEN },
    });
    // Ciphertexts that no longer open: a refusal that decrypted first would
    // say vault.entry-corrupt instead.
    h.db.run("UPDATE secret SET ciphertext = randomblob(length(ciphertext))");
    h.registered.length = 0;
    const cases: Array<[string, string]> = [
      ["vault:hub-token", "vault.kind-mismatch"],
      ["vault:site", "vault.kind-mismatch"],
      ["vault:site#password", "vault.kind-mismatch"],
      ["vault:model", "vault.kind-mismatch"],
      ["vault:other-session", "vault.scope-mismatch"],
      ["vault:missing", "secret.not-found"],
    ];
    for (const [ref, code] of cases) {
      const error = await errorOf(h.vault.use(ref, bash("ses_1")));
      expect(`${ref}: ${error.code}`).toBe(`${ref}: ${code}`);
    }
    expect(auditRows(h.db, "secret.use")).toHaveLength(0);
    expect(auditRows(h.db, "secret.use-refused")).toHaveLength(5);
    expect(h.registered).toEqual([]);
  });

  test("the opt-in is authenticated: a hub token edited to box-env in SQL does not open", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    await h.vault.create(LOCAL_PRINCIPAL, { name: "t", kind: "token", fields: { value: TOKEN } });
    h.db.run(`UPDATE secret SET policy_json = '{"hosts":[],"use":"box-env"}'`);
    expect((await errorOf(h.vault.use("vault:t", bash("ses_1")))).code).toBe("vault.entry-corrupt");
    expect(auditRows(h.db, "secret.use")).toHaveLength(0);
  });

  test("a tool gets a token only for a box command: without a variable even an opted-in one is refused", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "token",
      policy: { use: "box-env" },
      fields: { value: BOX_TOKEN },
    });
    const error = await errorOf(
      h.vault.use("vault:github", { sessionId: "ses_1", tool: "other", kinds: ["token"] }),
    );
    expect(error.code).toBe("vault.kind-mismatch");
    expect(auditRows(h.db, "secret.use")).toHaveLength(0);
  });

  test("rotate can switch a token's use; the new policy is bound and audited; other kinds have no use", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    const { id } = await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "token",
      policy: { hosts: ["api.github.com"] },
      fields: { value: TOKEN },
    });
    expect((await errorOf(h.vault.use("vault:github", bash("ses_1")))).code).toBe(
      "vault.kind-mismatch",
    );
    await h.vault.rotate(LOCAL_PRINCIPAL, id, { fields: { value: BOX_TOKEN }, use: "box-env" });
    expect((await h.vault.use("vault:github", bash("ses_1"))).value.reveal()).toBe(BOX_TOKEN);
    const listed = (await h.vault.list(LOCAL_PRINCIPAL)).find((s) => s.id === id);
    expect(listed?.policy).toEqual({ hosts: ["api.github.com"], use: "box-env" });
    // The authorizer's row and the rotation's own, which names the new policy.
    const rotated = auditRows(h.db, "secret.rotate").map((r) => JSON.parse(r.detail_json ?? "{}"));
    expect(rotated.find((d) => d.version === 2)?.policy).toEqual({
      hosts: ["api.github.com"],
      use: "box-env",
    });
    // Without `use` the policy stays; back to hub, the box gets it no more.
    await h.vault.rotate(LOCAL_PRINCIPAL, id, { fields: { value: BOX_TOKEN } });
    expect((await h.vault.use("vault:github", bash("ses_1"))).value.reveal()).toBe(BOX_TOKEN);
    await h.vault.rotate(LOCAL_PRINCIPAL, id, { fields: { value: TOKEN }, use: "hub" });
    expect((await errorOf(h.vault.use("vault:github", bash("ses_1")))).code).toBe(
      "vault.kind-mismatch",
    );
    expect(await h.secrets.resolve("vault:github").then((v) => v.reveal())).toBe(TOKEN);
    const model = await addModelKey(h);
    const bad = await h.vault
      .rotate(LOCAL_PRINCIPAL, model.id, { fields: { value: MODEL_KEY }, use: "box-env" })
      .then(() => ({ code: "accepted" }))
      .catch((e: unknown) => e as { code: string });
    expect(bad.code).toBe("request.invalid");
    const badUse = await h.vault
      .rotate(LOCAL_PRINCIPAL, id, { fields: { value: TOKEN }, use: "everywhere" })
      .then(() => ({ code: "accepted" }))
      .catch((e: unknown) => e as { code: string });
    expect(badUse.code).toBe("request.invalid");
  });
});

describe("uses are audited first", () => {
  test("every resolve writes one secret.use row, with no value, and sets last_used_at", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const { id, fingerprint } = await addModelKey(h);
    for (let i = 0; i < 3; i++) await h.secrets.resolve("vault:model");
    const rows = auditRows(h.db, "secret.use");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.resource_id).toBe(id);
      expect(row.principal_kind).toBe("system");
      expect(row.detail_json).not.toContain(MODEL_KEY);
      expect(JSON.parse(row.detail_json ?? "{}")).toMatchObject({
        name: "model",
        field: "value",
        fingerprint,
        version: 1,
        consumer: "hub",
      });
    }
    const listed = await h.vault.list(LOCAL_PRINCIPAL);
    expect(listed[0]?.lastUsedAt).toBeNumber();
    expect(await h.vault.uses(LOCAL_PRINCIPAL, id)).toHaveLength(3);
  });

  test("a tool use records session, tool call and origin", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    addSession(h.db, "ses_1");
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "github",
      kind: "login",
      policy: { origins: ["https://github.com"] },
      fields: LOGIN,
    });
    await h.vault.use("vault:github#username", {
      sessionId: "ses_1",
      tool: "browser_fill",
      toolCallId: "call_1",
      origin: "https://github.com",
      kinds: ["login"],
    });
    const [row] = auditRows(h.db, "secret.use");
    expect(JSON.parse(row?.detail_json ?? "{}")).toMatchObject({
      field: "username",
      session_id: "ses_1",
      tool: "browser_fill",
      tool_call_id: "call_1",
      origin: "https://github.com",
      consumer: "tool",
    });
  });

  test("when the use cannot be audited, the value is not returned", async () => {
    const h = await start({
      env: { VAULT_KEY: KEY_A },
      audit: (db) => {
        const real = new SqliteAuditSink(db);
        return {
          write: (record: AuditRecord) =>
            record.action === "secret.use"
              ? Promise.reject(new Error("disk full"))
              : real.write(record),
        };
      },
    });
    await addModelKey(h);
    h.registered.length = 0;
    const error = await errorOf(h.secrets.resolve("vault:model"));
    expect(error.code).toBe("vault.audit-failed");
    expect(error.message).not.toContain(MODEL_KEY);
    expect(h.registered).not.toContain(MODEL_KEY);
    const listed = await h.vault.list(LOCAL_PRINCIPAL);
    expect(listed[0]?.lastUsedAt).toBeNull();
  });

  test("create, rotate and delete are audited before they act; a failed record stops them", async () => {
    let failCreate = false;
    const h = await start({
      env: { VAULT_KEY: KEY_A },
      audit: (db) => {
        const real = new SqliteAuditSink(db);
        return {
          write: (record: AuditRecord) =>
            failCreate && record.action === "secret.create" && record.detail !== undefined
              ? Promise.reject(new Error("disk full"))
              : real.write(record),
        };
      },
    });
    const { id } = await addModelKey(h);
    await h.vault.rotate(LOCAL_PRINCIPAL, id, { fields: { value: MODEL_KEY_2 } });
    await h.vault.remove(LOCAL_PRINCIPAL, id);
    for (const action of ["secret.create", "secret.rotate", "secret.delete"]) {
      const rows = auditRows(h.db, action);
      // One authorize decision and one record with the detail.
      expect(rows).toHaveLength(2);
      const detail = JSON.parse(rows[1]?.detail_json ?? "{}");
      expect(detail.name).toBe("model");
      expect(detail.fingerprint).toMatch(/^hmac:[0-9a-f]{12}$/);
      expect(rows[1]?.detail_json).not.toContain(MODEL_KEY);
      expect(rows[1]?.detail_json).not.toContain(MODEL_KEY_2);
    }
    failCreate = true;
    const error = await errorOf(addModelKey(h, "other"));
    expect((error as unknown as { code: string }).code).toBe("audit.write-failed");
    expect(await h.vault.list(LOCAL_PRINCIPAL)).toHaveLength(0);
  });
});

describe("master key rotation through vault_key.next", () => {
  test("rewrap under the next key, new fingerprints, the cutover and both wrong orders", async () => {
    const first = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(first);
    await addModelKey(first, "second", MODEL_KEY_2);
    const fpA = fingerprintOf(first.db, "model");
    const fpA2 = fingerprintOf(first.db, "second");
    const checkA = kekCheck(first.db);

    const rotating = await start({
      env: { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: KEY_B },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    const checkB = kekCheck(rotating.db);
    expect(rotating.status).toEqual({
      state: "enabled",
      key: "next",
      kekCheck: checkB.slice(0, 12),
    });
    // New entries after the rotation take their fingerprint from the next key.
    await addModelKey(rotating, "after", MODEL_KEY);
    expect(fingerprintOf(rotating.db, "after")).toBe(fingerprintOf(rotating.db, "model"));
    expect(checkB).not.toBe(checkA);
    const fpB = fingerprintOf(rotating.db, "model");
    expect(fpB).not.toBe(fpA);
    // Every entry's fingerprint is recomputed, not only the first.
    expect(fingerprintOf(rotating.db, "second")).not.toBe(fpA2);
    expect(fingerprintOf(rotating.db, "second")).toMatch(/^hmac:[0-9a-f]{12}$/);
    expect((await rotating.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
    const [rotate] = auditRows(rotating.db, "vault.key.rotate");
    expect(JSON.parse(rotate?.detail_json ?? "{}")).toEqual({
      from_kek_check: checkA.slice(0, 12),
      to_kek_check: checkB.slice(0, 12),
      entries: 2,
    });

    // Restart before the cutover: the old key no longer matches, the next one does.
    const again = await start({
      env: { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: KEY_B },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    expect(again.status).toMatchObject({ state: "enabled", key: "next" });
    expect(auditRows(again.db, "vault.key.rotate")).toHaveLength(1);
    expect(again.logs.join("\n")).toContain("move secrets/vault_key.next over secrets/vault_key");

    // The cutover: the new key is the current one, no next.
    const cut = await start({ env: { VAULT_KEY: KEY_B } });
    expect(cut.status).toMatchObject({ state: "enabled", key: "current" });
    expect((await cut.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
    expect(fingerprintOf(cut.db, "model")).toBe(fpB);

    // The old key alone no longer opens the vault.
    const old = await start({ env: { VAULT_KEY: KEY_A } });
    expect(old.status).toMatchObject({ state: "disabled", reason: "key-mismatch" });
  });

  test("a next key that does not match is not used: the current key's reason stands", async () => {
    const first = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(first);
    const checkA = kekCheck(first.db);
    const KEY_C = Buffer.alloc(32, 0xc3).toString("base64");
    const wrong = await start({
      env: { VAULT_KEY: KEY_B, VAULT_KEY_NEXT: KEY_C },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    expect(wrong.status).toMatchObject({
      state: "disabled",
      reason: "key-mismatch",
      expectedKekCheck: checkA.slice(0, 12),
    });
    const missing = await start({
      keyRef: undefined,
      env: { VAULT_KEY_NEXT: KEY_C },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    expect(missing.status).toMatchObject({ state: "disabled", reason: "key-missing" });
    expect(kekCheck(missing.db)).toBe(checkA);
    // A copy of the current key as the next one is no rotation.
    const same = await start({
      env: { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: KEY_A },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    expect(same.status).toMatchObject({ state: "enabled", key: "current" });
    expect(auditRows(same.db, "vault.key.rotate")).toHaveLength(0);
  });

  test("an entry that does not decrypt keeps its fingerprint; the rotation goes on", async () => {
    const first = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(first, "good", MODEL_KEY);
    await addModelKey(first, "bad", MODEL_KEY_2);
    first.db.run("UPDATE secret SET name = 'moved' WHERE name = 'bad'");
    const fpBad = fingerprintOf(first.db, "moved");
    const fpGood = fingerprintOf(first.db, "good");
    const rotating = await start({
      env: { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: KEY_B },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    expect(rotating.status).toMatchObject({ state: "enabled", key: "next" });
    expect(rotating.logs.join("\n")).toContain(
      "entry moved does not decrypt; its fingerprint is kept",
    );
    expect(fingerprintOf(rotating.db, "moved")).toBe(fpBad);
    expect(fingerprintOf(rotating.db, "good")).not.toBe(fpGood);
  });

  test("a crash in the middle of the rewrap leaves the old key in force; the next start finishes", async () => {
    const first = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(first);
    const checkA = kekCheck(first.db);
    const fpA = fingerprintOf(first.db, "model");

    const crashed = await start({
      env: { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: KEY_B },
      nextKeyRef: "env:VAULT_KEY_NEXT",
      midRotation: () => {
        throw new Error("simulated crash");
      },
    });
    expect(crashed.status).toMatchObject({ state: "enabled", key: "current" });
    expect(kekCheck(crashed.db)).toBe(checkA);
    expect(fingerprintOf(crashed.db, "model")).toBe(fpA);
    expect((await crashed.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
    expect(crashed.logs.join("\n")).toContain("key rotation failed");

    const retried = await start({
      env: { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: KEY_B },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    expect(retried.status).toMatchObject({ state: "enabled", key: "next" });
    expect(kekCheck(retried.db)).not.toBe(checkA);
    expect((await retried.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
  });

  test("a next key that is missing is no rotation; an invalid one is ignored with a warning", async () => {
    await start({ env: { VAULT_KEY: KEY_A } });
    const missing = await start({
      env: { VAULT_KEY: KEY_A },
      nextKeyRef: "file:/nonexistent/vault_key.next",
    });
    expect(missing.status).toMatchObject({ state: "enabled", key: "current" });
    expect(missing.logs.join("\n")).not.toContain("the next key is not used");
    const bad = await start({
      env: { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: "short" },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    expect(bad.status).toMatchObject({ state: "enabled", key: "current" });
    expect(bad.logs.join("\n")).toContain("the next key is not used");
    expect(auditRows(bad.db, "vault.key.rotate")).toHaveLength(0);
  });
});

describe("data key rotation", () => {
  test("re-encrypts every entry under a new data key; fingerprints stay", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(h, "one", MODEL_KEY);
    await addModelKey(h, "two", MODEL_KEY_2);
    const snapshot = () =>
      h.db
        .query<{ name: string; fingerprint: string; ciphertext: Uint8Array }, []>(
          "SELECT name, fingerprint, ciphertext FROM secret ORDER BY name",
        )
        .all();
    const wrapped = () =>
      Buffer.from(
        h.db.query<{ w: Uint8Array }, []>("SELECT wrapped_dek AS w FROM vault_key").get()?.w ?? [],
      ).toString("hex");
    const before = snapshot();
    const wrappedBefore = wrapped();
    expect(await h.vault.rotateDataKey(LOCAL_PRINCIPAL)).toEqual({ entries: 2 });
    const after = snapshot();
    expect(wrapped()).not.toBe(wrappedBefore);
    expect(after.map((r) => r.fingerprint)).toEqual(before.map((r) => r.fingerprint));
    for (let i = 0; i < 2; i++) {
      expect(
        Buffer.from(after[i]?.ciphertext ?? []).equals(Buffer.from(before[i]?.ciphertext ?? [])),
      ).toBe(false);
    }
    expect((await h.secrets.resolve("vault:one")).reveal()).toBe(MODEL_KEY);
    expect(auditRows(h.db, "vault.data-key.rotate")).toHaveLength(2);
    // A restart unwraps the new data key.
    const again = await start({ env: { VAULT_KEY: KEY_A } });
    expect((await again.secrets.resolve("vault:two")).reveal()).toBe(MODEL_KEY_2);
  });

  test("creates racing data key rotations are serialized: every entry still decrypts", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      work.push(h.vault.rotateDataKey(LOCAL_PRINCIPAL));
      work.push(addModelKey(h, `race-${i}`, `race-value-${i}-0e9d`));
    }
    await Promise.all(work);
    for (let i = 0; i < 6; i++) {
      expect((await h.secrets.resolve(`vault:race-${i}`)).reveal()).toBe(`race-value-${i}-0e9d`);
    }
    // A failed write does not stall the ones after it.
    await expect(addModelKey(h, "race-0")).rejects.toMatchObject({ code: "secret.name-taken" });
    expect(await addModelKey(h, "after-failure")).toMatchObject({ version: 1 });
  });

  test("a crash in the middle of a data key rotation keeps the old data key and ciphertexts", async () => {
    const h = await start({
      env: { VAULT_KEY: KEY_A },
      midRotation: () => {
        throw new Error("simulated crash");
      },
    });
    await addModelKey(h);
    await expect(h.vault.rotateDataKey(LOCAL_PRINCIPAL)).rejects.toThrow("simulated crash");
    expect((await h.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
    const again = await start({ env: { VAULT_KEY: KEY_A } });
    expect((await again.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
  });
});

describe("the API never returns a value", () => {
  test("create, list, rotate, uses, status and delete answer with fingerprints only", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const app = new Hono<HubEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", LOCAL_PRINCIPAL);
      await next();
    });
    mountVaultRoutes(app, h.vault);
    const bodies: string[] = [];
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      const text = await res.text();
      bodies.push(text);
      return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
    };
    const created = await call("POST", "/v1/secrets", {
      name: "github",
      kind: "login",
      policy: { origins: ["https://github.com"] },
      meta: { label: "GitHub" },
      fields: LOGIN,
    });
    expect(created.status).toBe(201);
    expect(created.json.fingerprint).toMatch(/^hmac:[0-9a-f]{12}$/);
    const id = created.json.id as string;
    const model = await call("POST", "/v1/secrets", {
      name: "model",
      kind: "model-key",
      fields: { value: MODEL_KEY },
    });
    expect(model.status).toBe(201);
    await h.secrets.resolve("vault:model");
    const list = await call("GET", "/v1/secrets");
    expect(list.status).toBe(200);
    expect(list.json.secrets.map((s: { name: string }) => s.name)).toEqual(["github", "model"]);
    expect(Object.keys(list.json.secrets[0]).sort()).toEqual(
      [
        "createdAt",
        "fingerprint",
        "id",
        "kind",
        "lastUsedAt",
        "meta",
        "name",
        "policy",
        "scope",
        "updatedAt",
        "version",
      ].sort(),
    );
    const rotated = await call("PUT", `/v1/secrets/${id}/value`, {
      fields: { username: LOGIN.username, password: "vault-test-pw-rotated-0c1d" },
    });
    expect(rotated.status).toBe(200);
    expect(rotated.json.version).toBe(2);
    expect(rotated.json.fingerprint).not.toBe(created.json.fingerprint);
    expect((await call("GET", `/v1/secrets/${model.json.id}/uses`)).json.uses).toHaveLength(1);
    expect((await call("GET", `/v1/secrets/${id}/uses?before=x`)).status).toBe(400);
    expect((await call("GET", "/v1/vault/status")).json).toMatchObject({
      ok: true,
      state: "enabled",
    });
    expect(
      (await call("POST", "/v1/secrets", { name: "github", kind: "token", fields: { value: "v" } }))
        .status,
    ).toBe(409);
    expect(
      (
        await call("POST", "/v1/secrets", {
          name: "Bad Name",
          kind: "token",
          fields: { value: "v" },
        })
      ).status,
    ).toBe(400);
    expect((await call("GET", "/v1/secrets/sec_nope/uses")).status).toBe(200);
    expect((await call("DELETE", "/v1/secrets/sec_nope")).status).toBe(404);
    expect((await call("DELETE", `/v1/secrets/${id}`)).status).toBe(204);
    expect((await call("GET", "/v1/secrets")).json.secrets).toHaveLength(1);
    const all = bodies.join("\n");
    for (const value of [
      LOGIN.username,
      LOGIN.password,
      "vault-test-pw-rotated-0c1d",
      MODEL_KEY,
      KEY_A,
    ]) {
      expect(all).not.toContain(value);
    }
  });

  test("refusals map to their status: denied 403, disabled 409, audit down 503", async () => {
    const app = (vault: HubVault) => {
      const a = new Hono<HubEnv>();
      a.use("*", async (c, next) => {
        c.set("principal", LOCAL_PRINCIPAL);
        await next();
      });
      mountVaultRoutes(a, vault);
      return a;
    };
    const db = openDatabase(path);
    dbs.push(db);
    const real = new SqliteAuditSink(db);
    const base = {
      store: new SqliteVaultStore(db),
      audit: real,
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      keyRef: "env:VAULT_KEY",
      log: () => {},
      register: () => {},
    };
    const denied = new HubVault({
      ...base,
      authorizer: { authorize: async () => ({ allowed: false, policy: "t", reason: "no" }) },
    });
    const json = { "content-type": "application/json" };
    const routes: [string, string][] = [
      ["GET", "/v1/vault/status"],
      ["GET", "/v1/secrets"],
      ["POST", "/v1/secrets"],
      ["PUT", "/v1/secrets/sec_x/value"],
      ["DELETE", "/v1/secrets/sec_x"],
      ["GET", "/v1/secrets/sec_x/uses"],
    ];
    for (const [method, url] of routes) {
      const res = await app(denied).request(url, {
        method,
        ...(method === "POST" || method === "PUT" ? { body: "{}", headers: json } : {}),
      });
      expect(`${method} ${url} ${res.status}`).toBe(`${method} ${url} 403`);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("authz.denied");
    }
    // An unclassified error is not answered with its message.
    const brokenStore = new SqliteVaultStore(db);
    brokenStore.list = () => {
      throw new Error("internal detail 7c1e");
    };
    const broken = new HubVault({
      ...base,
      store: brokenStore,
      authorizer: new AllowAllAuthorizer({ audit: real }),
    });
    const crashed = await app(broken).request("/v1/secrets");
    expect(crashed.status).toBe(500);
    expect(await crashed.text()).not.toContain("internal detail 7c1e");
    const disabled = new HubVault({
      ...base,
      keySecrets: createDefaultSecretStore({ env: {} }),
      authorizer: new AllowAllAuthorizer({ audit: real }),
    });
    const body = JSON.stringify({ name: "m", kind: "model-key", fields: { value: "x-value" } });
    expect(
      (await app(disabled).request("/v1/secrets", { method: "POST", body, headers: json })).status,
    ).toBe(409);
    // The data key exists, so only the create's own record fails below.
    await new HubVault({ ...base, authorizer: new AllowAllAuthorizer({ audit: real }) }).open();
    const auditDown = new HubVault({
      ...base,
      audit: {
        write: (r: AuditRecord) =>
          r.detail === undefined ? real.write(r) : Promise.reject(new Error("disk full")),
      },
      authorizer: new AllowAllAuthorizer({ audit: real }),
    });
    expect(
      (await app(auditDown).request("/v1/secrets", { method: "POST", body, headers: json })).status,
    ).toBe(503);
    // A tampered row is a hub-side 500, classified.
    const ok = new HubVault({ ...base, authorizer: new AllowAllAuthorizer({ audit: real }) });
    const made = await ok.create(LOCAL_PRINCIPAL, {
      name: "t",
      kind: "token",
      fields: { value: "v-tamper" },
    });
    db.run("UPDATE secret SET version = 7");
    const corrupt = await app(ok).request(`/v1/secrets/${made.id}/value`, {
      method: "PUT",
      body: JSON.stringify({ fields: { value: "v2" } }),
      headers: json,
    });
    expect(corrupt.status).toBe(500);
    expect(((await corrupt.json()) as { error: { code: string } }).error.code).toBe(
      "vault.entry-corrupt",
    );
  });

  test("a foreign principal gets 403 before any body is read, valid or not", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const { id } = await addModelKey(h);
    const foreign = Object.freeze({
      id: "pr_foreign",
      workspaceId: "ws_other",
      kind: "user",
      displayName: "foreign",
    }) as Principal;
    const app = new Hono<HubEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", foreign);
      await next();
    });
    mountVaultRoutes(app, h.vault);
    const json = { "content-type": "application/json" };
    // Every route that takes a body, with each kind of body a parser refuses.
    const routes: [string, string][] = [
      ["POST", "/v1/secrets"],
      ["PUT", `/v1/secrets/${id}/value`],
      ["PUT", "/v1/secrets/sec_unknown/value"],
    ];
    const bodies = ["not json {", "", "[]", '{"unknown":1}', '{"fields":{"value":7}}'];
    for (const [method, url] of routes) {
      for (const body of bodies) {
        const res = await app.request(url, { method, body, headers: json });
        const code = ((await res.json()) as { error: { code: string } }).error.code;
        expect(`${method} ${url} ${JSON.stringify(body)} ${res.status} ${code}`).toBe(
          `${method} ${url} ${JSON.stringify(body)} 403 authz.denied`,
        );
      }
    }
    // The service itself: a denied call never reads its body.
    let reads = 0;
    const spy = new RequestBody<unknown>(async () => {
      reads++;
      return {};
    });
    await expect(h.vault.create(foreign, spy)).rejects.toMatchObject({ code: "authz.denied" });
    await expect(h.vault.rotate(foreign, id, spy)).rejects.toMatchObject({ code: "authz.denied" });
    expect(reads).toBe(0);
    await expect(h.vault.rotate(LOCAL_PRINCIPAL, id, spy)).rejects.toMatchObject({
      code: "request.invalid",
    });
    expect(reads).toBe(1);
  });

  test("a row in another workspace is not found by id: 404, untouched", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    const { id } = await addModelKey(h);
    h.db.run("INSERT INTO workspace (id, name, created_at) VALUES ('ws_other', 'other', 0)");
    h.db.run(
      `INSERT INTO secret SELECT 'sec_foreign', 'ws_other', name, kind, scope_session_id,
         policy_json, meta_json, iv, ciphertext, version, fingerprint, created_at, updated_at,
         last_used_at FROM secret WHERE id = ?`,
      [id],
    );
    const store = new SqliteVaultStore(h.db);
    expect(store.byId("ws_default", "sec_foreign")).toBeUndefined();
    expect(store.byId("ws_other", "sec_foreign")?.workspaceId).toBe("ws_other");
    const app = new Hono<HubEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", LOCAL_PRINCIPAL);
      await next();
    });
    mountVaultRoutes(app, h.vault);
    const put = await app.request("/v1/secrets/sec_foreign/value", {
      method: "PUT",
      body: JSON.stringify({ fields: { value: "foreign-rotate-value-2c" } }),
      headers: { "content-type": "application/json" },
    });
    expect(put.status).toBe(404);
    const del = await app.request("/v1/secrets/sec_foreign", { method: "DELETE" });
    expect(del.status).toBe(404);
    const row = h.db
      .query<{ version: number }, []>("SELECT version FROM secret WHERE id = 'sec_foreign'")
      .get();
    expect(row?.version).toBe(1);
  });

  test("the hub serves the vault routes behind the login and resolves vault: refs", async () => {
    const hub = startHub({
      port: 0,
      dbPath: join(dir, "served.db"),
      vault: {
        keyRef: "env:VAULT_KEY",
        keySecrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      },
      log: () => {},
    });
    try {
      expect(await hub.vaultReady).toMatchObject({ state: "enabled" });
      const res = await fetch(new URL("/v1/secrets", hub.url));
      expect(res.status).toBe(401);
      const cookie = `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}`;
      const signed = await fetch(new URL("/v1/vault/status", hub.url), { headers: { cookie } });
      expect(signed.status).toBe(200);
      expect(await signed.json()).toMatchObject({ ok: true, state: "enabled" });
      await hub.vault.create(LOCAL_PRINCIPAL, {
        name: "model",
        kind: "model-key",
        fields: { value: MODEL_KEY },
      });
      expect((await hub.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
    } finally {
      await hub.stop();
    }
  });
});

describe("redaction", () => {
  test("a saved value is redacted from logs, trajectories, spans and runner events", async () => {
    const db = openDatabase(path);
    dbs.push(db);
    const audit = new SqliteAuditSink(db);
    const vault = new HubVault({
      store: new SqliteVaultStore(db),
      authorizer: new AllowAllAuthorizer({ audit }),
      audit,
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      keyRef: "env:VAULT_KEY",
      log: () => {},
    });
    await vault.open();
    const value = "vault-redaction-probe-71e0-plain";
    // No credential shape: only the registry can catch it.
    expect(redactHub(value)).toBe(value);
    await vault.create(LOCAL_PRINCIPAL, { name: "probe", kind: "token", fields: { value } });
    // The hub's sink redactor: logs, trajectory export and span attributes (decision 0021).
    expect(redactHub(`error: ${value}`)).not.toContain(value);
    const lines: string[] = [];
    observabilityFromEnv({}, (line) => lines.push(line)).logger.info(`key was ${value}`);
    expect(lines.join("\n")).not.toContain(value);
    // Span attributes and status, with the redactor setup.ts gives telemetry.
    const exported: string[] = [];
    const telemetry = new Telemetry({
      redact: redactHub,
      spanExporter: {
        export: (spans, done) => {
          exported.push(JSON.stringify(spans.map((s) => [s.attributes, s.status])));
          done({ code: 0 });
        },
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
      },
    });
    telemetry.endSpan(
      telemetry.startSpan("tool", { arg: value }),
      {},
      { type: "x", message: value },
    );
    await telemetry.shutdown();
    expect(exported.join("")).toContain("[redacted]");
    expect(exported.join("")).not.toContain(value);
    // The runner's redactor for stored events (decision 0015).
    const runners = new SessionRunners({
      config: { provider: "faux", model: "m" },
    } as unknown as ConstructorParameters<typeof SessionRunners>[0]);
    expect(runners.redact(`{"text":"${value}"}`)).not.toContain(value);
  });

  test("live bash output never stores a multi-line vault value, even split at its line breaks", async () => {
    const value = "-----BEGIN KEY-----\nMIIEpAIBAAKCAQEAvaultsecretline2\n-----END KEY-----";
    registerSecret(value);
    const runners = new SessionRunners({
      config: { provider: "faux", model: "m" },
    } as unknown as ConstructorParameters<typeof SessionRunners>[0]);
    // The hold point is the start of the vault value, not only of a model key.
    expect(runners.secretStart(`out\n${value.slice(0, 30)}`)).toBe(4);
    const stored: string[] = [];
    const live = new LiveToolOutput({
      toolCallId: "c",
      intervalMs: 5,
      redact: (t) => runners.redact(t),
      secretStart: (t) => runners.secretStart(t),
      append: async (p) => {
        stored.push(p.text);
      },
    });
    const enc = new TextEncoder();
    live.write(enc.encode("-----BEGIN KEY-----\nMIIEpAIBAAKCAQEAvaultsecretline2\n"));
    await Bun.sleep(40);
    live.write(enc.encode("-----END KEY-----\ndone\n"));
    await Bun.sleep(40);
    expect(stored.join("")).not.toContain("vaultsecretline2");
    expect(stored.join("")).not.toContain("BEGIN KEY");
  });

  test("overlapping values leave no tail on any sink, in either order of registration", async () => {
    // Every sink the hub has: log lines, span attributes and status, the
    // runner's stored events, and the trajectory export.
    const sinks = async (text: string): Promise<Record<string, string>> => {
      const lines: string[] = [];
      observabilityFromEnv({}, (line) => lines.push(line)).logger.info(`saw ${text}`);
      const exported: string[] = [];
      const telemetry = new Telemetry({
        redact: redactHub,
        spanExporter: {
          export: (spans, done) => {
            exported.push(JSON.stringify(spans.map((s) => [s.attributes, s.status])));
            done({ code: 0 });
          },
          shutdown: () => Promise.resolve(),
          forceFlush: () => Promise.resolve(),
        },
      });
      telemetry.endSpan(
        telemetry.startSpan("tool", { arg: text }),
        {},
        { type: "x", message: text },
      );
      await telemetry.shutdown();
      const runners = new SessionRunners({
        config: { provider: "faux", model: "m" },
      } as unknown as ConstructorParameters<typeof SessionRunners>[0]);
      const known = [...knownSecrets()];
      return {
        log: lines.join("\n"),
        span: exported.join(""),
        runner: runners.redact(JSON.stringify({ text })),
        "runner-forward": redactSecrets(text, known),
        "runner-reverse": redactSecrets(text, known.reverse()),
      };
    };
    for (const [i, order] of (["username-first", "password-first"] as const).entries()) {
      const username = `ovl-admin-${i}`;
      const password = `${username}-Zq9!SuffixLeak${i}`;
      const token = `zzpart${i}x`;
      const modelKey = `${token}-MODELTAILSECRET${i}`;
      // The process-wide registry keeps insertion order: register the login in
      // this round's order before the vault adds the rest at open.
      if (order === "username-first") {
        registerSecret(username);
        registerSecret(password);
      } else {
        registerSecret(password);
        registerSecret(username);
      }
      const h = await start({ env: { VAULT_KEY: KEY_A } });
      const login = {
        name: `login-${i}`,
        kind: "login",
        policy: { origins: ["https://example.com"] },
        fields: order === "username-first" ? { username, password } : { password, username },
      };
      const tokenEntry = { name: "", kind: "token", fields: { value: token } };
      const modelEntry = { name: "", kind: "model-key", fields: { value: modelKey } };
      // The vault registers at open in name order: the shorter value first in
      // round 0, the longer one first in round 1.
      const [first, second] =
        i === 0
          ? [
              { ...tokenEntry, name: `a-tok-${i}` },
              { ...modelEntry, name: `b-model-${i}` },
            ]
          : [
              { ...modelEntry, name: `a-model-${i}` },
              { ...tokenEntry, name: `b-tok-${i}` },
            ];
      for (const entry of [login, first, second]) await h.vault.create(LOCAL_PRINCIPAL, entry);
      const text = `u=${username} pw=${password} tok=${token} key=${modelKey} "q":"${password}"`;
      const sessionId = `se_overlap_${i}`;
      await new SqliteEventStore(h.db).append({ workspaceId: "ws_default" }, sessionId, {
        type: "message.user",
        payload: { text },
      });
      // The CLI opens the vault with the hub's registry: every value joins it.
      const out = await dumpTrajectory(path, sessionId, {
        secrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
        vaultKeyRef: "env:VAULT_KEY",
        warn: () => {},
      });
      const all = { trajectory: out, ...(await sinks(text)) };
      for (const [sink, value] of Object.entries(all)) {
        for (const tail of [`SuffixLeak${i}`, `MODELTAILSECRET${i}`, "Zq9!", username, token]) {
          expect(`${order} ${sink}: ${value.includes(tail) ? `leaks ${tail}` : "ok"}`).toBe(
            `${order} ${sink}: ok`,
          );
        }
      }
      expect(redactHub(text)).toBe(
        'u=[redacted] pw=[redacted] tok=[redacted] key=[redacted] "q":"[redacted]"',
      );
    }
  });

  test("at open, every stored value joins the redaction set; a corrupt row does not stop it", async () => {
    const first = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(first, "one", MODEL_KEY);
    await addModelKey(first, "two", MODEL_KEY_2);
    first.db.run("UPDATE secret SET name = 'three' WHERE name = 'two'");
    const again = await start({ env: { VAULT_KEY: KEY_A } });
    expect(again.registered).toContain(MODEL_KEY);
    expect(again.registered).not.toContain(MODEL_KEY_2);
    expect(again.logs.join("\n")).toContain("entry three does not decrypt");
  });

  test("the trajectory CLI opens the vault and redacts its values from a stored event", async () => {
    const value = "vault-trajectory-probe-5a9b-plain";
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    await h.vault.create(LOCAL_PRINCIPAL, { name: "probe", kind: "token", fields: { value } });
    await new SqliteEventStore(h.db).append({ workspaceId: "ws_default" }, "se_vault", {
      type: "message.user",
      payload: { text: `the token is ${value} ok` },
    });
    // The harness registers into a spy: the process-wide registry does not know it yet.
    expect(redactHub(value)).toBe(value);
    const out = await dumpTrajectory(path, "se_vault", {
      secrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      vaultKeyRef: "env:VAULT_KEY",
      warn: () => {},
    });
    expect(out).toContain("the token is [redacted] ok");
    expect(out).not.toContain(value);
  });

  test("the trajectory CLI refuses to dump when the vault does not open, unless told to", async () => {
    await start({ env: { VAULT_KEY: KEY_A } });
    const dump = async (
      env: Record<string, string>,
      unredactedOk = false,
      db = path,
    ): Promise<{ text?: string; error?: unknown; warnings: string[] }> => {
      const warnings: string[] = [];
      try {
        const text = await dumpTrajectory(db, "se_none", {
          secrets: createDefaultSecretStore({ env }),
          ...(env["VAULT_KEY"] === undefined ? {} : { vaultKeyRef: "env:VAULT_KEY" }),
          unredactedOk,
          warn: (m) => warnings.push(m),
        });
        return { text, warnings };
      } catch (error) {
        return { error, warnings };
      }
    };
    for (const env of [{ VAULT_KEY: KEY_B }, {}]) {
      const refused = await dump(env);
      expect(refused.error).toBeInstanceOf(UnredactedDumpError);
      expect((refused.error as Error).name).toBe("UnredactedDumpError");
      expect(String((refused.error as Error).message)).toContain("--unredacted-ok");
      expect(String((refused.error as Error).message)).not.toContain(KEY_B);
      expect(refused.warnings).toEqual([]);
    }
    const forced = await dump({ VAULT_KEY: KEY_B }, true);
    expect(forced.warnings).toEqual([
      "vault values are not redacted: the vault is disabled (key-mismatch)",
    ]);
    expect(forced.text).toBeString();
    expect(await dump({ VAULT_KEY: KEY_A })).toMatchObject({ warnings: [] });
    // A database with no vault has nothing to redact: no key needed, nothing created.
    const plain = join(dir, "plain.db");
    openDatabase(plain).close();
    const noVault = await dump({}, false, plain);
    expect(noVault).toMatchObject({ warnings: [] });
    expect(noVault.text).toBeString();
    const check = openDatabase(plain);
    expect(new SqliteVaultStore(check).keyRecord()).toBeUndefined();
    check.close();
  });

  test("a read-only vault on a database with no vault creates nothing", async () => {
    const db = openDatabase(path);
    dbs.push(db);
    const audit = new SqliteAuditSink(db);
    const status = await new HubVault({
      store: new SqliteVaultStore(db),
      authorizer: new AllowAllAuthorizer({ audit }),
      audit,
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY: KEY_A } }),
      keyRef: "env:VAULT_KEY",
      readOnly: true,
      log: () => {},
      register: () => {},
    }).open();
    expect(status).toMatchObject({ state: "disabled", reason: "key-missing" });
    expect(new SqliteVaultStore(db).keyRecord()).toBeUndefined();
    expect(auditRows(db, "vault.key.create")).toHaveLength(0);
  });

  test("the trajectory CLI exits 1 with no output when it cannot redact", async () => {
    await start({ env: { VAULT_KEY: KEY_A } });
    const cli = join(import.meta.dir, "..", "trajectory-cli.ts");
    const run = (args: string[], env: Record<string, string>) =>
      Bun.spawnSync([process.execPath, cli, "--db", path, ...args], {
        env: { PATH: process.env["PATH"] ?? "", ...env },
      });
    const refused = run(["se_none"], { HEARTH_VAULT_KEY_REF: "env:K", K: KEY_B });
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout.toString()).toBe("");
    // One line, the reason and the way out, no stack trace.
    expect(refused.stderr.toString()).toBe(`${new UnredactedDumpError("key-mismatch").message}\n`);
    const forced = run(["--unredacted-ok", "se_none"], { HEARTH_VAULT_KEY_REF: "env:K", K: KEY_B });
    expect(forced.exitCode).toBe(0);
    const ok = run(["se_none"], { HEARTH_VAULT_KEY_REF: "env:K", K: KEY_A });
    expect(ok.exitCode).toBe(0);
  });

  // The blobs are written after the dump: a refused dump writes none (#137).
  test("the trajectory CLI refuses --export-blobs with the dump: exit 1, no blob directory", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    // A screenshot of the session that an export would write.
    await new SqliteBlobStore(h.db).put(
      { workspaceId: "ws_default" },
      "se_shot",
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
    );
    const cli = join(import.meta.dir, "..", "trajectory-cli.ts");
    const run = (out: string, key: string) =>
      Bun.spawnSync([process.execPath, cli, "--db", path, "--export-blobs", out, "se_shot"], {
        env: { PATH: process.env["PATH"] ?? "", HEARTH_VAULT_KEY_REF: "env:K", K: key },
      });
    const refusedDir = join(dir, "refused-blobs");
    const refused = run(refusedDir, KEY_B);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout.toString()).toBe("");
    expect(refused.stderr.toString()).toBe(`${new UnredactedDumpError("key-mismatch").message}\n`);
    expect(existsSync(refusedDir)).toBe(false);
    // The same command with the vault's key writes the blob.
    const okDir = join(dir, "ok-blobs");
    const ok = run(okDir, KEY_A);
    expect(ok.exitCode).toBe(0);
    expect(readdirSync(okDir)).toHaveLength(1);
  });

  test("the trajectory CLI opens a vault mid-rotation through the next key, and never rotates", async () => {
    const value = "vault-trajectory-rotation-3e1d-plain";
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    await h.vault.create(LOCAL_PRINCIPAL, { name: "rot", kind: "token", fields: { value } });
    await new SqliteEventStore(h.db).append({ workspaceId: "ws_default" }, "se_rot", {
      type: "message.user",
      payload: { text: `rotating ${value} now` },
    });
    const checkA = kekCheck(h.db);
    const KEY_C = Buffer.alloc(32, 0xc3).toString("base64");
    // Read-only: a current key that matches and a different next key rotate nothing.
    const env = { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: KEY_C };
    expect(
      await dumpTrajectory(path, "se_rot", {
        secrets: createDefaultSecretStore({ env }),
        vaultKeyRef: "env:VAULT_KEY",
        vaultNextKeyRef: "env:VAULT_KEY_NEXT",
        warn: () => {},
      }),
    ).not.toContain(value);
    expect(kekCheck(h.db)).toBe(checkA);
    expect(auditRows(h.db, "vault.key.rotate")).toHaveLength(0);
    // The hub rotated to KEY_C; the cutover has not happened yet.
    await start({ env, nextKeyRef: "env:VAULT_KEY_NEXT" });
    expect(kekCheck(h.db)).not.toBe(checkA);
    const dump = (next: boolean) =>
      dumpTrajectory(path, "se_rot", {
        secrets: createDefaultSecretStore({ env }),
        vaultKeyRef: "env:VAULT_KEY",
        ...(next ? { vaultNextKeyRef: "env:VAULT_KEY_NEXT" } : {}),
        warn: () => {},
      });
    await expect(dump(false)).rejects.toBeInstanceOf(UnredactedDumpError);
    const out = await dump(true);
    expect(out).toContain("rotating [redacted] now");
    expect(out).not.toContain(value);
  });

  test("a resolved value joins the redaction set at use", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(h);
    h.registered.length = 0;
    await h.secrets.resolve("vault:model");
    expect(h.registered).toEqual([MODEL_KEY]);
  });
});
