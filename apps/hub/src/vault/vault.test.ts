/**
 * The hub vault (decision 0031) over a real SQLite file: key handling, the
 * disabled state, AAD tamper checks on stored rows, scope and kind, master-key
 * and data-key rotation, audit of every use, and redaction.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AllowAllAuthorizer,
  type AuditRecord,
  type AuditSink,
  createDefaultSecretStore,
  LOCAL_PRINCIPAL,
  type SecretError,
  type SecretStore,
  VaultSecretResolver,
} from "@hearth/core";
import { Hono } from "hono";
import { type HubEnv, SESSION_COOKIE } from "../auth";
import { lineFields, lineLevel } from "../obs/hub-log";
import { redactHub } from "../obs/redaction";
import { observabilityFromEnv } from "../obs/setup";
import { Telemetry } from "../obs/telemetry";
import { SessionRunners } from "../runner";
import { startHub } from "../server";
import { openDatabase, SqliteAuditSink, SqliteEventStore, SqliteVaultStore } from "../store";
import { dumpTrajectory } from "../trajectory-cli";
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
    await addModelKey(h);
    expect((await h.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
    expect((await h.secrets.resolve("vault:model#value")).reveal()).toBe(MODEL_KEY);
    // The key text itself joins the redaction set.
    expect(h.registered).toContain(KEY_A);
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
        kinds: ["login"],
      });
    expect((await use()).reveal()).toBe(LOGIN.password);
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
      fields: { value: TOKEN },
    });
    const ctx = (sessionId: string) => ({ sessionId, tool: "bash", kinds: ["token"] as const });
    expect(
      (await h.vault.use("vault:scoped", { ...ctx("ses_1"), kinds: ["token"] })).reveal(),
    ).toBe(TOKEN);
    expect(
      (await errorOf(h.vault.use("vault:scoped", { ...ctx("ses_2"), kinds: ["token"] }))).code,
    ).toBe("vault.scope-mismatch");
    expect((await errorOf(h.secrets.resolve("vault:scoped"))).code).toBe("vault.scope-mismatch");
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
    const fpA = fingerprintOf(first.db, "model");
    const checkA = kekCheck(first.db);

    const rotating = await start({
      env: { VAULT_KEY: KEY_A, VAULT_KEY_NEXT: KEY_B },
      nextKeyRef: "env:VAULT_KEY_NEXT",
    });
    expect(rotating.status).toMatchObject({ state: "enabled", key: "next" });
    const checkB = kekCheck(rotating.db);
    expect(checkB).not.toBe(checkA);
    const fpB = fingerprintOf(rotating.db, "model");
    expect(fpB).not.toBe(fpA);
    expect((await rotating.secrets.resolve("vault:model")).reveal()).toBe(MODEL_KEY);
    const [rotate] = auditRows(rotating.db, "vault.key.rotate");
    expect(JSON.parse(rotate?.detail_json ?? "{}")).toEqual({
      from_kek_check: checkA.slice(0, 12),
      to_kek_check: checkB.slice(0, 12),
      entries: 1,
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

  test("a resolved value joins the redaction set at use", async () => {
    const h = await start({ env: { VAULT_KEY: KEY_A } });
    await addModelKey(h);
    h.registered.length = 0;
    await h.secrets.resolve("vault:model");
    expect(h.registered).toEqual([MODEL_KEY]);
  });
});
