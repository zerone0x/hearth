/**
 * Model settings (decision 0038, PRD §6.10): the model, its provider and the
 * vault entry of its key, chosen on the Settings page instead of `.env` lines
 * and a key file.
 *
 * - **Env wins.** While `HEARTH_MODEL` is set the environment decides and the
 *   page is read-only (`settings.env-locked`): existing installs run as before.
 * - **Keys are vault references.** A saved key is `vault:<name>` of a global
 *   `model-key` entry, never a value, and never an `env:` or `file:` reference
 *   a browser could point at any hub file.
 * - **Audited, then applied.** Each change writes `settings.model.update`
 *   (old and new choice, key fingerprint) before it is stored, is logged, and
 *   swaps the runners' model for the next turn (`SessionRunners.setModel`).
 * - **First-start import.** With the vault open and no saved choice, a key
 *   the environment names (`file:/run/secrets/model_key`) is copied into the
 *   vault as `model-key-<provider>` and saved as the choice
 *   (`settings.model.import`), so an upgrade needs no manual step.
 */

import {
  type AuditRecord,
  type AuditSink,
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  displayRef,
  type EpochMs,
  HearthError,
  type JsonValue,
  type Principal,
  parseSecretRef,
  parseVaultRefBody,
  type SecretStore,
  SYSTEM_PRINCIPAL,
  VAULT_NAME,
  withAudit,
} from "@hearth/core";
import { bodyOf, type RequestBody } from "../request-body";
import type { ModelChoice } from "../runner";
import type { SqliteSettingStore, SqliteVaultStore } from "../store";
import type { HubVault } from "../vault";

/** What `GET /v1/settings/model` answers. A key is a reference with its fingerprint, never a value. */
export interface ModelSettingsView {
  /** `env`: `HEARTH_MODEL` is set and wins; `settings`: saved here; `none`: no model. */
  readonly source: "env" | "settings" | "none";
  readonly provider: string | null;
  readonly model: string | null;
  readonly keyRef: string | null;
  /** The keyed fingerprint of a `vault:` key; null for others or a deleted entry. */
  readonly keyFingerprint: string | null;
  readonly updatedAt: EpochMs | null;
}

export interface ModelSettingsOptions {
  readonly settings: SqliteSettingStore;
  readonly vaultStore: SqliteVaultStore;
  readonly vault: HubVault;
  readonly authorizer: Authorizer;
  readonly audit: AuditSink;
  /** The choice from `HEARTH_MODEL*`; set, it wins over the saved one. */
  readonly env?: ModelChoice;
  /** Resolves an `env:` / `file:` key for the first-start import. */
  readonly importSecrets?: SecretStore;
  /** Applies a choice to the runners (`SessionRunners.setModel`). */
  readonly apply?: (choice: ModelChoice | undefined) => void;
  /** Whether pi knows a model (`SessionRunners.knowsModel`); unset, any id is taken. */
  readonly knowsModel?: (provider: string, model: string) => Promise<boolean>;
  readonly log?: (line: string) => void;
  readonly now?: () => EpochMs;
}

const KEY = "model";
/** pi provider and model ids: no spaces or control characters. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;

function fail(code: string, message: string): HearthError {
  return new HearthError(message, { owner: "user", disposition: "give-up", code });
}

function invalid(message: string): HearthError {
  return fail("request.invalid", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStored(json: string): ModelChoice | undefined {
  const value = JSON.parse(json) as unknown;
  if (!isRecord(value)) return undefined;
  const { provider, model, keyRef } = value;
  if (typeof provider !== "string" || typeof model !== "string") return undefined;
  return { provider, model, ...(typeof keyRef === "string" ? { apiKeyRef: keyRef } : {}) };
}

function storedJson(choice: ModelChoice): string {
  return JSON.stringify({
    provider: choice.provider,
    model: choice.model,
    keyRef: choice.apiKeyRef ?? null,
  });
}

/** `model-key-<provider>`, or undefined when the provider id cannot make a vault name. */
export function importName(provider: string): string | undefined {
  const name = `model-key-${provider.toLowerCase()}`;
  return VAULT_NAME.test(name) ? name : undefined;
}

export class ModelSettings {
  readonly #o: ModelSettingsOptions;
  readonly #workspaceId = DEFAULT_WORKSPACE_ID;
  readonly #now: () => EpochMs;
  /** Serializes writes: two saves never interleave their audit and their store. */
  #lock: Promise<unknown> = Promise.resolve();

  constructor(options: ModelSettingsOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** The choice in force: the environment's, else the saved one. */
  get effective(): ModelChoice | undefined {
    return this.#o.env ?? this.#saved()?.choice;
  }

  /**
   * At hub start, after the vault opened: import an env key on the first
   * start, then apply the saved choice when the environment sets none.
   */
  async start(): Promise<void> {
    try {
      await this.#import();
    } catch (error) {
      this.#log(`settings: the model key was not imported: ${errorText(error)}`);
    }
    if (this.#o.env !== undefined) return;
    const saved = this.#saved()?.choice;
    if (saved !== undefined) {
      this.#o.apply?.(saved);
      this.#log(`settings: model ${saved.provider}/${saved.model} (saved on the Settings page)`);
    }
  }

  async get(principal: Principal): Promise<ModelSettingsView> {
    await this.#authorize(principal, "settings.read");
    const saved = this.#saved();
    const choice = this.#o.env ?? saved?.choice;
    return {
      source: this.#o.env !== undefined ? "env" : saved === undefined ? "none" : "settings",
      provider: choice?.provider ?? null,
      model: choice?.model ?? null,
      keyRef: choice?.apiKeyRef ?? null,
      keyFingerprint: this.#fingerprint(choice?.apiKeyRef),
      updatedAt: this.#o.env === undefined ? (saved?.updatedAt ?? null) : null,
    };
  }

  /**
   * The vault entry `name` was rotated or deleted: when it is the key in
   * force, the runners resolve it again for the next turn.
   */
  keyChanged(name: string): void {
    const choice = this.effective;
    if (choice?.apiKeyRef !== `vault:${name}`) return;
    this.#o.apply?.(choice);
    this.#log(`settings: the model key vault:${name} changed; new turns resolve it again`);
  }

  /** Save `{provider, model, keyRef}` and switch the runners to it for the next turn. */
  async put(
    principal: Principal,
    body: unknown | RequestBody<unknown>,
  ): Promise<ModelSettingsView> {
    await this.#authorize(principal, "settings.model.update");
    // Read only now, after `authorize` (#32).
    const input = await bodyOf(body);
    if (!isRecord(input)) throw invalid("expected {provider, model, keyRef}");
    for (const key of Object.keys(input)) {
      if (!["provider", "model", "keyRef"].includes(key)) {
        throw invalid(`unknown field ${JSON.stringify(key)}`);
      }
    }
    const { provider, model, keyRef } = input;
    if (typeof provider !== "string" || !ID.test(provider)) {
      throw invalid("provider must be a pi provider id");
    }
    if (typeof model !== "string" || !ID.test(model)) throw invalid("model must be a pi model id");
    if (keyRef !== null && keyRef !== undefined && typeof keyRef !== "string") {
      throw invalid("keyRef must be a vault: reference or null");
    }
    if (this.#o.env !== undefined) {
      throw fail(
        "settings.env-locked",
        "the model is set by HEARTH_MODEL in deploy/.env; remove the HEARTH_MODEL* lines to manage it here",
      );
    }
    const fingerprint = typeof keyRef === "string" ? this.#checkKeyRef(keyRef) : null;
    if (this.#o.knowsModel !== undefined && !(await this.#o.knowsModel(provider, model))) {
      throw fail("settings.unknown-model", `model ${provider}/${model} is not known to pi`);
    }
    const choice: ModelChoice = {
      provider,
      model,
      ...(typeof keyRef === "string" ? { apiKeyRef: keyRef } : {}),
    };
    await this.#serial(async () => {
      const previous = this.#saved()?.choice;
      await withAudit(
        this.#o.audit,
        this.#record(principal, "settings.model.update", {
          provider,
          model,
          key_ref: choice.apiKeyRef ?? null,
          key_fingerprint: fingerprint,
          previous:
            previous === undefined
              ? null
              : {
                  provider: previous.provider,
                  model: previous.model,
                  key_ref: previous.apiKeyRef ?? null,
                },
        }),
        () => this.#o.settings.put(this.#workspaceId, KEY, storedJson(choice), this.#now()),
      );
      this.#o.apply?.(choice);
      this.#log(
        `settings: model set to ${provider}/${model}, key ${choice.apiKeyRef ?? "none"}${fingerprint === null ? "" : ` (${fingerprint})`}; new turns use it`,
      );
    });
    return this.get(principal);
  }

  /** A saved key is `vault:<name>` of a global `model-key` entry. Returns its fingerprint. */
  #checkKeyRef(keyRef: string): string {
    let name: string | undefined;
    try {
      const parsed = parseSecretRef(keyRef);
      const body = parsed.scheme === "vault" ? parseVaultRefBody(parsed.body) : undefined;
      if (body !== undefined && body.field === undefined) name = body.name;
    } catch {
      name = undefined;
    }
    if (name === undefined) throw invalid("keyRef must be vault:<name> of a model key");
    const row = this.#o.vaultStore.byName(this.#workspaceId, name);
    if (row === undefined) throw fail("secret.not-found", `no secret named ${name}`);
    if (row.kind !== "model-key" || row.scopeSessionId !== null) {
      throw invalid(`${name} is not a global model key`);
    }
    return row.fingerprint;
  }

  #fingerprint(keyRef: string | undefined): string | null {
    if (keyRef === undefined || !keyRef.startsWith("vault:")) return null;
    try {
      const body = parseVaultRefBody(parseSecretRef(keyRef).body);
      if (body === undefined) return null;
      return this.#o.vaultStore.byName(this.#workspaceId, body.name)?.fingerprint ?? null;
    } catch {
      return null;
    }
  }

  async #import(): Promise<void> {
    const env = this.#o.env;
    const ref = env?.apiKeyRef;
    if (env === undefined || ref === undefined || ref.startsWith("vault:")) return;
    if (this.#o.importSecrets === undefined || this.#saved() !== undefined) return;
    if (this.#o.vault.currentStatus.state !== "enabled") return;
    const name = importName(env.provider);
    if (name === undefined) {
      this.#log(`settings: provider ${env.provider} makes no vault name; the key was not imported`);
      return;
    }
    if (this.#o.vaultStore.byName(this.#workspaceId, name) !== undefined) {
      this.#log(`settings: a secret named ${name} exists; the model key was not imported`);
      return;
    }
    // A pasted value where a reference belongs shows only as a fingerprint.
    const from = displayRef(ref);
    const value = (await this.#o.importSecrets.resolve(ref)).reveal();
    const created = await this.#o.vault.create(SYSTEM_PRINCIPAL, {
      name,
      kind: "model-key",
      meta: { provider: env.provider, label: `imported from ${from}`.slice(0, 200) },
      fields: { value },
    });
    const choice: ModelChoice = { ...env, apiKeyRef: `vault:${name}` };
    await this.#serial(() =>
      withAudit(
        this.#o.audit,
        this.#record(SYSTEM_PRINCIPAL, "settings.model.import", {
          provider: env.provider,
          model: env.model,
          key_ref: `vault:${name}`,
          key_fingerprint: created.fingerprint,
          from,
        }),
        () =>
          this.#o.settings.insertIfAbsent(this.#workspaceId, KEY, storedJson(choice), this.#now()),
      ),
    );
    this.#log(
      `settings: imported the model key from ${from} into vault:${name} (${created.fingerprint}); HEARTH_MODEL still wins until it is removed from deploy/.env`,
    );
  }

  #saved(): { choice: ModelChoice | undefined; updatedAt: EpochMs } | undefined {
    const row = this.#o.settings.get(this.#workspaceId, KEY);
    if (row === undefined) return undefined;
    return { choice: parseStored(row.valueJson), updatedAt: row.updatedAt };
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(work, work);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  #record(principal: Principal, action: string, detail: JsonValue): AuditRecord {
    return {
      workspaceId: principal.workspaceId,
      principalId: principal.id,
      principalKind: principal.kind,
      action,
      resource: { workspaceId: this.#workspaceId, type: "setting", id: KEY },
      at: this.#now(),
      detail,
    };
  }

  async #authorize(principal: Principal, action: `${string}.${string}`): Promise<void> {
    const decision = await this.#o.authorizer.authorize(principal, action, {
      workspaceId: this.#workspaceId,
      type: "setting",
      id: KEY,
    });
    if (!decision.allowed) throw fail("authz.denied", `${action} denied: ${decision.reason}`);
  }

  #log(line: string): void {
    (this.#o.log ?? console.error)(line);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
