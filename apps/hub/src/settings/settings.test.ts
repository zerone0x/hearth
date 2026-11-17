/**
 * Model settings (decision 0038) over a real SQLite file and vault: env wins,
 * keys are global `vault:` model keys, every change is audited before it is
 * stored and applied, and the first start imports the env's key.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AllowAllAuthorizer,
  type AuditSink,
  createDefaultSecretStore,
  DEFAULT_WORKSPACE_ID,
  type HearthError,
  LOCAL_PRINCIPAL,
  type Principal,
} from "@hearth/core";
import { Hono } from "hono";
import { type HubEnv, SESSION_COOKIE } from "../auth";
import type { ModelChoice } from "../runner";
import { startHub } from "../server";
import { openDatabase, SqliteAuditSink, SqliteSettingStore, SqliteVaultStore } from "../store";
import { HubVault } from "../vault";
import { importName, ModelSettings, mountSettingsRoutes } from ".";

const VAULT_KEY = Buffer.alloc(32, 0xc3).toString("base64");
/** Distinctive values: the redaction registry is process-wide. */
const MODEL_KEY = "sk-settings-test-model-7e21ab";
const ENV_KEY = "sk-settings-test-imported-5d90c4";

let dir: string;
let path: string;
let dbs: Database[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-settings-"));
  path = join(dir, "hub.db");
  dbs = [];
});
afterEach(() => {
  for (const db of dbs) db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly db: Database;
  readonly vault: HubVault;
  readonly settings: ModelSettings;
  readonly applied: (ModelChoice | undefined)[];
  readonly logs: string[];
}

interface Start {
  readonly env?: ModelChoice;
  readonly vaultKey?: boolean;
  readonly audit?: (db: Database) => AuditSink;
  readonly knows?: (provider: string, model: string) => boolean;
}

async function start(options: Start = {}): Promise<Harness> {
  const db = openDatabase(path);
  dbs.push(db);
  const audit = options.audit?.(db) ?? new SqliteAuditSink(db);
  const authorizer = new AllowAllAuthorizer({ audit });
  const logs: string[] = [];
  const vaultStore = new SqliteVaultStore(db);
  const keySecrets = createDefaultSecretStore({
    env: { VAULT_KEY, ENV_MODEL_KEY: ENV_KEY },
  });
  const vault = new HubVault({
    store: vaultStore,
    authorizer,
    audit,
    keySecrets,
    ...(options.vaultKey === false ? {} : { keyRef: "env:VAULT_KEY" }),
    log: (line) => logs.push(line),
    register: () => {},
  });
  await vault.open();
  const applied: (ModelChoice | undefined)[] = [];
  const settings = new ModelSettings({
    settings: new SqliteSettingStore(db),
    vaultStore,
    vault,
    authorizer,
    audit,
    ...(options.env === undefined ? {} : { env: options.env }),
    importSecrets: keySecrets,
    apply: (choice) => applied.push(choice),
    knowsModel: async (provider, model) => options.knows?.(provider, model) ?? true,
    log: (line) => logs.push(line),
  });
  await settings.start();
  return { db, vault, settings, applied, logs };
}

function auditRows(db: Database, action: string) {
  return db
    .query<{ detail_json: string | null; principal_kind: string; resource_type: string }, [string]>(
      // The record of the action, not the authorizer's decision of the same name.
      "SELECT detail_json, principal_kind, resource_type FROM audit WHERE action = ? AND allowed IS NULL ORDER BY id",
    )
    .all(action);
}

function settingRows(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM setting").get()?.n ?? 0;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as HearthError).code ?? "";
}

async function addModelKey(h: Harness, name = "anthropic-key", value = MODEL_KEY) {
  return h.vault.create(LOCAL_PRINCIPAL, { name, kind: "model-key", fields: { value } });
}

describe("saving the model", () => {
  test("a choice is audited, stored, applied and logged, with the key's fingerprint only", async () => {
    const h = await start();
    const { fingerprint } = await addModelKey(h);
    expect(await h.settings.get(LOCAL_PRINCIPAL)).toMatchObject({
      source: "none",
      provider: null,
      keyRef: null,
    });
    const view = await h.settings.put(LOCAL_PRINCIPAL, {
      provider: "anthropic",
      model: "claude-x",
      keyRef: "vault:anthropic-key",
    });
    expect(view).toMatchObject({
      source: "settings",
      provider: "anthropic",
      model: "claude-x",
      keyRef: "vault:anthropic-key",
      keyFingerprint: fingerprint,
    });
    expect(h.applied).toEqual([
      { provider: "anthropic", model: "claude-x", apiKeyRef: "vault:anthropic-key" },
    ]);
    const rows = auditRows(h.db, "settings.model.update");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_type).toBe("setting");
    expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toEqual({
      provider: "anthropic",
      model: "claude-x",
      key_ref: "vault:anthropic-key",
      key_fingerprint: fingerprint,
      previous: null,
    });
    expect(h.logs.join("\n")).toContain(
      `settings: model set to anthropic/claude-x, key vault:anthropic-key (${fingerprint})`,
    );
    // No value anywhere: not in the audit, the logs or the answer.
    const audit = JSON.stringify(h.db.query("SELECT * FROM audit").all());
    expect(audit).not.toContain(MODEL_KEY);
    expect(h.logs.join("\n")).not.toContain(MODEL_KEY);
    expect(JSON.stringify(view)).not.toContain(MODEL_KEY);

    // A second save records the previous choice; no key is allowed too.
    await h.settings.put(LOCAL_PRINCIPAL, { provider: "local", model: "llama", keyRef: null });
    const second = JSON.parse(auditRows(h.db, "settings.model.update")[1]?.detail_json ?? "{}");
    expect(second.previous).toEqual({
      provider: "anthropic",
      model: "claude-x",
      key_ref: "vault:anthropic-key",
    });
    expect(h.applied.at(-1)).toEqual({ provider: "local", model: "llama" });
  });

  test("the saved choice is applied at the next start", async () => {
    const h = await start();
    await addModelKey(h);
    await h.settings.put(LOCAL_PRINCIPAL, {
      provider: "anthropic",
      model: "claude-x",
      keyRef: "vault:anthropic-key",
    });
    const again = await start();
    expect(again.applied).toEqual([
      { provider: "anthropic", model: "claude-x", apiKeyRef: "vault:anthropic-key" },
    ]);
    expect(again.settings.effective).toEqual(again.applied[0]);
  });

  test("only a global model key in the vault is a key; nothing is stored otherwise", async () => {
    const h = await start();
    await addModelKey(h);
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "site",
      kind: "login",
      policy: { origins: ["https://example.com"] },
      fields: { username: "u", password: "settings-test-pw-1" },
    });
    h.db.run(
      `INSERT INTO session (id, workspace_id, title, state, last_activity_at, created_at)
       VALUES ('se_x', ?, 't', 'idle', 0, 0)`,
      [DEFAULT_WORKSPACE_ID],
    );
    await h.vault.create(LOCAL_PRINCIPAL, {
      name: "scoped",
      kind: "model-key",
      scope: { sessionId: "se_x" },
      fields: { value: "settings-test-scoped-2" },
    });
    const put = (keyRef: unknown) =>
      codeOf(h.settings.put(LOCAL_PRINCIPAL, { provider: "anthropic", model: "m", keyRef }));
    expect(await put("env:ANTHROPIC_API_KEY")).toBe("request.invalid");
    expect(await put("file:/run/secrets/vault_key")).toBe("request.invalid");
    expect(await put("vault:anthropic-key#value")).toBe("request.invalid");
    expect(await put("vault:site")).toBe("request.invalid");
    expect(await put("vault:scoped")).toBe("request.invalid");
    expect(await put("vault:missing")).toBe("secret.not-found");
    expect(await put(42)).toBe("request.invalid");
    expect(
      await codeOf(h.settings.put(LOCAL_PRINCIPAL, { provider: "a b", model: "m", keyRef: null })),
    ).toBe("request.invalid");
    expect(
      await codeOf(h.settings.put(LOCAL_PRINCIPAL, { provider: "a", model: "", keyRef: null })),
    ).toBe("request.invalid");
    expect(
      await codeOf(
        h.settings.put(LOCAL_PRINCIPAL, { provider: "a", model: "m", keyRef: null, x: 1 }),
      ),
    ).toBe("request.invalid");
    expect(settingRows(h.db)).toBe(0);
    expect(auditRows(h.db, "settings.model.update")).toHaveLength(0);
    expect(h.applied).toEqual([]);
  });

  test("a model pi does not know is refused", async () => {
    const h = await start({ knows: (_p, model) => model === "known" });
    const code = await codeOf(
      h.settings.put(LOCAL_PRINCIPAL, { provider: "faux", model: "unknown", keyRef: null }),
    );
    expect(code).toBe("settings.unknown-model");
    expect(settingRows(h.db)).toBe(0);
    await h.settings.put(LOCAL_PRINCIPAL, { provider: "faux", model: "known", keyRef: null });
    expect(settingRows(h.db)).toBe(1);
  });

  test("when the audit cannot be written nothing is stored or applied", async () => {
    let failing = false;
    const h = await start({
      audit: (db) => {
        const real = new SqliteAuditSink(db);
        return {
          write: async (record) => {
            if (failing && record.decision === undefined) throw new Error("disk full");
            await real.write(record);
          },
        };
      },
    });
    failing = true;
    const code = await codeOf(
      h.settings.put(LOCAL_PRINCIPAL, { provider: "faux", model: "m", keyRef: null }),
    );
    expect(code).toBe("audit.write-failed");
    expect(settingRows(h.db)).toBe(0);
    expect(h.applied).toEqual([]);
  });

  test("while HEARTH_MODEL is set the env wins and saving is refused", async () => {
    const env = { provider: "faux", model: "env-model", apiKeyRef: "vault:anthropic-key" };
    const h = await start({ env });
    expect(h.applied).toEqual([]);
    expect(await h.settings.get(LOCAL_PRINCIPAL)).toMatchObject({
      source: "env",
      provider: "faux",
      model: "env-model",
      updatedAt: null,
    });
    const code = await codeOf(
      h.settings.put(LOCAL_PRINCIPAL, { provider: "faux", model: "m", keyRef: null }),
    );
    expect(code).toBe("settings.env-locked");
    expect(settingRows(h.db)).toBe(0);
    expect(auditRows(h.db, "settings.model.update")).toHaveLength(0);
    expect(h.settings.effective).toEqual(env);
  });

  test("a foreign principal is refused before its body is read", async () => {
    const h = await start();
    const foreign = Object.freeze({
      id: "pr_foreign",
      workspaceId: "ws_other",
      kind: "user",
      displayName: "foreign",
    }) as Principal;
    let read = false;
    const body = {
      read: async () => {
        read = true;
        return { provider: "faux", model: "m", keyRef: null };
      },
    };
    const app = new Hono<HubEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", foreign);
      await next();
    });
    mountSettingsRoutes(app, h.settings);
    const res = await app.request("/v1/settings/model", {
      method: "PUT",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(await codeOf(h.settings.get(foreign))).toBe("authz.denied");
    const { RequestBody } = await import("../request-body");
    expect(await codeOf(h.settings.put(foreign, new RequestBody(() => body.read())))).toBe(
      "authz.denied",
    );
    expect(read).toBe(false);
    expect(settingRows(h.db)).toBe(0);
  });
});

describe("first-start import", () => {
  const env = { provider: "anthropic", model: "claude-x", apiKeyRef: "env:ENV_MODEL_KEY" };

  test("the env's key goes into the vault and becomes the saved choice; env still wins", async () => {
    const h = await start({ env });
    const row = new SqliteVaultStore(h.db).byName(DEFAULT_WORKSPACE_ID, "model-key-anthropic");
    expect(row?.kind).toBe("model-key");
    expect(row?.scopeSessionId).toBeNull();
    // The imported entry holds the env's value.
    const resolver = createDefaultSecretStore({
      resolvers: [new (await import("@hearth/core")).VaultSecretResolver(h.vault)],
    });
    expect((await resolver.resolve("vault:model-key-anthropic")).reveal()).toBe(ENV_KEY);
    const imports = auditRows(h.db, "settings.model.import");
    expect(imports).toHaveLength(1);
    expect(imports[0]?.principal_kind).toBe("system");
    expect(JSON.parse(imports[0]?.detail_json ?? "{}")).toEqual({
      provider: "anthropic",
      model: "claude-x",
      key_ref: "vault:model-key-anthropic",
      key_fingerprint: row?.fingerprint,
      from: "env:ENV_MODEL_KEY",
    });
    expect(h.logs.join("\n")).toContain(
      `settings: imported the model key from env:ENV_MODEL_KEY into vault:model-key-anthropic (${row?.fingerprint})`,
    );
    expect(h.logs.join("\n")).not.toContain(ENV_KEY);
    expect(JSON.stringify(h.db.query("SELECT * FROM audit").all())).not.toContain(ENV_KEY);
    // Env wins: nothing applied, the page shows the env.
    expect(h.applied).toEqual([]);
    expect((await h.settings.get(LOCAL_PRINCIPAL)).source).toBe("env");

    // The next start imports nothing more.
    const again = await start({ env });
    expect(auditRows(again.db, "settings.model.import")).toHaveLength(1);
    expect(auditRows(again.db, "secret.create")).toHaveLength(1);

    // Once HEARTH_MODEL is gone, the imported choice is used.
    const unlocked = await start();
    expect(unlocked.applied).toEqual([
      { provider: "anthropic", model: "claude-x", apiKeyRef: "vault:model-key-anthropic" },
    ]);
  });

  test("no import without a vault, from a vault: ref, or over a taken name", async () => {
    const disabled = await start({ env, vaultKey: false });
    expect(auditRows(disabled.db, "settings.model.import")).toHaveLength(0);
    expect(settingRows(disabled.db)).toBe(0);
    for (const db of dbs) db.close();
    dbs = [];
    rmSync(path, { force: true });

    const fromVault = await start({ env: { ...env, apiKeyRef: "vault:anthropic-key" } });
    expect(settingRows(fromVault.db)).toBe(0);

    await addModelKey(fromVault, "model-key-anthropic", "settings-test-other-3");
    const taken = await start({ env });
    expect(settingRows(taken.db)).toBe(0);
    expect(auditRows(taken.db, "settings.model.import")).toHaveLength(0);
    expect(taken.logs.join("\n")).toContain("a secret named model-key-anthropic exists");
  });

  test("import names follow the vault's name rule", () => {
    expect(importName("anthropic")).toBe("model-key-anthropic");
    expect(importName("OpenAI")).toBe("model-key-openai");
    expect(importName("has space")).toBeUndefined();
  });
});

describe("the hub", () => {
  test("serves the settings routes behind the login and switches the runners' model", async () => {
    const faux = fauxProvider({ provider: "faux" });
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const hub = startHub({
      port: 0,
      dbPath: join(dir, "served.db"),
      vault: {
        keyRef: "env:VAULT_KEY",
        keySecrets: createDefaultSecretStore({ env: { VAULT_KEY } }),
      },
      runner: { config: {}, modelRuntime: runtime },
      log: () => {},
    });
    try {
      await hub.settingsReady;
      const url = new URL("/v1/settings/model", hub.url);
      expect((await fetch(url)).status).toBe(401);
      const headers = {
        cookie: `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}`,
        "content-type": "application/json",
      };
      expect(await (await fetch(url, { headers })).json()).toMatchObject({
        ok: true,
        source: "none",
      });
      const { fingerprint } = await hub.vault.create(LOCAL_PRINCIPAL, {
        name: "faux-key",
        kind: "model-key",
        fields: { value: MODEL_KEY },
      });
      const unknown = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ provider: "faux", model: "nope", keyRef: "vault:faux-key" }),
      });
      expect(unknown.status).toBe(400);
      const model = faux.getModel().id;
      const put = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ provider: "faux", model, keyRef: "vault:faux-key" }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        source: "settings",
        model,
        keyFingerprint: fingerprint,
      });
      expect(hub.runners?.model).toEqual({ provider: "faux", model, apiKeyRef: "vault:faux-key" });
    } finally {
      await hub.stop();
    }
  });

  test("with HEARTH_MODEL set the route answers 409", async () => {
    const hub = startHub({
      port: 0,
      dbPath: join(dir, "env.db"),
      runner: { config: { provider: "faux", model: "m" } },
      log: () => {},
    });
    try {
      await hub.settingsReady;
      const res = await fetch(new URL("/v1/settings/model", hub.url), {
        method: "PUT",
        headers: {
          cookie: `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "faux", model: "m", keyRef: null }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "settings.env-locked",
      );
    } finally {
      await hub.stop();
    }
  });
});
