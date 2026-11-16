/**
 * The hub's vault (PRD §6.10, decision 0031, docs/research/vault.md).
 *
 * - **Key.** The master key is the base64 of 32 random bytes in a file the
 *   install step writes (`install:vault-key`), read through the SecretStore
 *   (`HEARTH_VAULT_KEY_REF`). Its HKDF subkeys wrap the one data key, sign
 *   `kek_check` and key the fingerprints (`MasterKeyProvider`).
 * - **Disabled, not fatal.** A missing, invalid or wrong key, or a data key that
 *   does not unwrap, leaves the vault disabled with a reason; the hub runs on,
 *   and `env:` / `file:` references keep working. On a wrong key nothing is
 *   written, so restoring the right file recovers the vault.
 * - **Rotation.** `HEARTH_VAULT_KEY_NEXT_REF`: at open, when the current key
 *   matches, the data key is rewrapped under the next key and every
 *   fingerprint recomputed in one transaction. When only the next key matches,
 *   that rewrap already committed and the vault runs on it until the cutover.
 * - **Uses.** Every value handed out is audited first (`secret.use`); if the
 *   record cannot be written the value is not returned. Each value joins the
 *   hub's redaction set (decision 0021) when it is saved, used, or found at open.
 * - **No read-back.** Nothing here returns a stored value to an API caller.
 */

import { randomUUID } from "node:crypto";
import {
  type AuditRecord,
  type AuditSink,
  type Authorizer,
  canonicalPolicy,
  checkEntryFields,
  DEFAULT_WORKSPACE_ID,
  type EntryBinding,
  type EpochMs,
  generateDataKey,
  HearthError,
  type JsonValue,
  MasterKeyProvider,
  openEntry,
  type Principal,
  parseMasterKey,
  parseSecretRef,
  parseVaultRefBody,
  type SealedEntry,
  SecretError,
  type SecretErrorCode,
  type SecretRef,
  type SecretStore,
  SecretValue,
  type SessionId,
  SYSTEM_PRINCIPAL,
  sealEntry,
  VAULT_DISPLAY_HEX,
  VAULT_FIELDS,
  VAULT_KINDS,
  VAULT_NAME,
  VaultCryptoError,
  type VaultEntryRecord,
  type VaultKeyProvider,
  type VaultKind,
  type VaultReader,
  vaultSecretError,
  withAudit,
} from "@hearth/core";
import { registerSecret } from "../obs/redaction";
import { bodyOf, type RequestBody } from "../request-body";
import type { SqliteVaultStore } from "../store";

export type VaultDisabledReason = "key-missing" | "key-invalid" | "key-mismatch" | "store-corrupt";

/** What `GET /v1/vault/status` and the Settings page show. Never a value or a key. */
export type VaultStatus =
  | { readonly state: "starting" }
  | {
      readonly state: "enabled";
      /** First 12 hex digits of the active key's `kek_check`. */
      readonly kekCheck: string;
      /** `next` while a rotation waits for its cutover. */
      readonly key: "current" | "next";
    }
  | {
      readonly state: "disabled";
      readonly reason: VaultDisabledReason;
      /** The problem and the fix, with no value. */
      readonly message: string;
      /** On `key-mismatch`: the `kek_check` the store expects and the one found. */
      readonly expectedKekCheck?: string;
      readonly foundKekCheck?: string;
    };

/** One secret as the API lists it: metadata and fingerprint, never a value. */
export interface SecretView {
  readonly id: string;
  readonly name: string;
  readonly kind: VaultKind;
  readonly scope: { readonly sessionId: SessionId } | null;
  readonly policy: JsonValue;
  readonly meta: JsonValue;
  readonly fingerprint: string;
  readonly version: number;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
  readonly lastUsedAt: EpochMs | null;
}

/** One use, from the audit table. */
export interface SecretUse {
  readonly at: EpochMs;
  readonly detail: unknown;
}

/** Context of a use by a tool (the hook `browser_fill`, #118, calls). */
export interface VaultUseContext {
  readonly sessionId: SessionId;
  readonly tool: string;
  readonly toolCallId?: string;
  /** The page origin the box reported, for a site login. */
  readonly origin?: string;
  /** Kinds this use accepts. */
  readonly kinds: readonly VaultKind[];
}

export interface HubVaultOptions {
  readonly store: SqliteVaultStore;
  readonly authorizer: Authorizer;
  readonly audit: AuditSink;
  /** Resolves the key references: `env:` / `file:` only, never `vault:`. */
  readonly keySecrets: SecretStore;
  /** `HEARTH_VAULT_KEY_REF`. Unset: the vault is disabled (`key-missing`). */
  readonly keyRef?: SecretRef;
  /** `HEARTH_VAULT_KEY_NEXT_REF`: the key to rotate to. A missing file means no rotation. */
  readonly nextKeyRef?: SecretRef;
  readonly log?: (line: string) => void;
  readonly now?: () => EpochMs;
  /** Adds a value to the sink-side redaction set. Default `registerSecret` (decision 0021). */
  readonly register?: (value: string) => void;
}

type Loaded =
  | { readonly ok: true; readonly keys: VaultKeyProvider }
  | {
      readonly ok: false;
      readonly reason: "key-missing" | "key-invalid";
      readonly detail: string;
    };

type State =
  | { readonly enabled: false; readonly status: VaultStatus }
  | {
      readonly enabled: true;
      readonly keys: VaultKeyProvider;
      dek: CryptoKey;
      readonly status: VaultStatus;
    };

const META_KEYS: readonly string[] = ["label", "provider"];
const MAX_META_CHARS = 200;
const MAX_USES = 100;

function short(check: string): string {
  return check.slice(0, VAULT_DISPLAY_HEX);
}

function fail(code: string, message: string, owner: "user" | "hub" = "user"): HearthError {
  return new HearthError(message, { owner, disposition: "give-up", code });
}

function invalid(message: string): HearthError {
  return fail("request.invalid", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const FIX: Record<VaultDisabledReason, string> = {
  "key-missing":
    "add deploy/secrets/vault_key (docs/install.md, install:vault-key) and restart the hub",
  "key-invalid": "the key file must hold the base64 of 32 random bytes (install:vault-key)",
  "key-mismatch": "restore the key file that matches this database and restart the hub",
  "store-corrupt": "the wrapped data key in the database is damaged; restore the database",
};

function bindingOf(row: EntryBinding): EntryBinding {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    kind: row.kind,
    version: row.version,
    scopeSessionId: row.scopeSessionId,
    policyJson: row.policyJson,
  };
}

function viewOf(row: VaultEntryRecord): SecretView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scope: row.scopeSessionId === null ? null : { sessionId: row.scopeSessionId },
    policy: JSON.parse(row.policyJson) as JsonValue,
    meta: JSON.parse(row.metaJson) as JsonValue,
    fingerprint: row.fingerprint,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function canonicalMeta(input: unknown): string {
  const meta = input ?? {};
  if (!isRecord(meta)) throw invalid("meta must be a JSON object");
  const out: Record<string, string> = {};
  for (const key of Object.keys(meta).sort()) {
    if (!META_KEYS.includes(key)) throw invalid(`unknown meta field ${JSON.stringify(key)}`);
    const value = meta[key];
    if (typeof value !== "string" || value.length > MAX_META_CHARS) {
      throw invalid(`meta.${key} must be a string of at most ${MAX_META_CHARS} characters`);
    }
    out[key] = value;
  }
  return JSON.stringify(out);
}

function scopeOf(input: unknown): SessionId | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input) || typeof input["sessionId"] !== "string" || input["sessionId"] === "") {
    throw invalid("scope must be null or {sessionId}");
  }
  if (Object.keys(input).length !== 1) throw invalid("scope has only sessionId");
  if (input["sessionId"].includes("|")) throw invalid("scope.sessionId is not a session id");
  return input["sessionId"];
}

export class HubVault implements VaultReader {
  readonly #o: HubVaultOptions;
  readonly #workspaceId = DEFAULT_WORKSPACE_ID;
  readonly #now: () => EpochMs;
  readonly #register: (value: string) => void;
  #state: State = { enabled: false, status: { state: "starting" } };
  #opening: Promise<VaultStatus> | undefined;
  /** Serializes writes, so a data-key rotation never races a create or a rotate. */
  #lock: Promise<unknown> = Promise.resolve();

  constructor(options: HubVaultOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#register = options.register ?? registerSecret;
  }

  /** Load the key and the data key once; later calls return the same answer. */
  open(): Promise<VaultStatus> {
    this.#opening ??= this.#open().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(`vault: could not open: ${message}`);
      return this.#disable("store-corrupt", message);
    });
    return this.#opening;
  }

  /** The state, without authorization: for the hub's own logs and startup. */
  get currentStatus(): VaultStatus {
    return this.#state.status;
  }

  // ---- API (each call authorizes first, before it reads its body) ----

  async status(principal: Principal): Promise<VaultStatus> {
    await this.#authorize(principal, "vault.status", "vault");
    await this.open();
    return this.#state.status;
  }

  async list(principal: Principal): Promise<SecretView[]> {
    await this.#authorize(principal, "secret.list", "secret");
    return this.#o.store.list(this.#workspaceId).map(viewOf);
  }

  async create(
    principal: Principal,
    body: unknown | RequestBody<unknown>,
  ): Promise<{ id: string; fingerprint: string; version: number }> {
    await this.#authorize(principal, "secret.create", "secret");
    const input = await bodyOf(body);
    if (!isRecord(input)) throw invalid("expected a JSON object");
    for (const key of Object.keys(input)) {
      if (!["name", "kind", "scope", "policy", "meta", "fields"].includes(key)) {
        throw invalid(`unknown field ${JSON.stringify(key)}`);
      }
    }
    const name = input["name"];
    if (typeof name !== "string" || !VAULT_NAME.test(name)) {
      throw invalid("name must match [a-z0-9][a-z0-9._-]{0,63}");
    }
    const kind = input["kind"];
    if (typeof kind !== "string" || !(VAULT_KINDS as readonly string[]).includes(kind)) {
      throw invalid(`kind must be one of ${VAULT_KINDS.join(", ")}`);
    }
    const vaultKind = kind as VaultKind;
    const scopeSessionId = scopeOf(input["scope"]);
    const policyJson = canonicalPolicy(vaultKind, input["policy"]);
    const metaJson = canonicalMeta(input["meta"]);
    const fields = checkEntryFields(vaultKind, input["fields"]);
    return this.#serial(async () => {
      const state = await this.#enabled();
      if (this.#o.store.byName(this.#workspaceId, name) !== undefined) {
        throw fail("secret.name-taken", `a secret named ${name} already exists`);
      }
      const binding: EntryBinding = {
        id: `sec_${randomUUID()}`,
        workspaceId: this.#workspaceId,
        name,
        kind: vaultKind,
        version: 1,
        scopeSessionId,
        policyJson,
      };
      const sealed = await sealEntry(state.dek, binding, fields);
      const fingerprint = await state.keys.fingerprint(this.#primary(vaultKind, fields));
      const at = this.#now();
      await withAudit(
        this.#o.audit,
        this.#record(principal, "secret.create", binding.id, {
          name,
          kind,
          fingerprint,
          version: 1,
          scope_session_id: scopeSessionId,
        }),
        () =>
          this.#o.store.insert({
            ...binding,
            metaJson,
            ...sealed,
            fingerprint,
            createdAt: at,
            updatedAt: at,
            lastUsedAt: null,
          }),
      );
      this.#registerFields(fields);
      return { id: binding.id, fingerprint, version: 1 };
    });
  }

  /** Replace an entry's value (rotate): new IV, version + 1, new fingerprint. */
  async rotate(
    principal: Principal,
    id: string,
    body: unknown | RequestBody<unknown>,
  ): Promise<{ fingerprint: string; version: number }> {
    await this.#authorize(principal, "secret.rotate", "secret", id);
    const input = await bodyOf(body);
    if (!isRecord(input) || Object.keys(input).some((k) => k !== "fields")) {
      throw invalid("expected {fields}");
    }
    return this.#serial(async () => {
      const state = await this.#enabled();
      const row = this.#row(id);
      const fields = checkEntryFields(row.kind, input["fields"]);
      const binding = { ...bindingOf(row), version: row.version + 1 };
      // The old ciphertext must still open: a tampered row is not rotated
      // into a valid one under a policy nobody set.
      await this.#open_(state.dek, row);
      const sealed = await sealEntry(state.dek, binding, fields);
      const fingerprint = await state.keys.fingerprint(this.#primary(row.kind, fields));
      await withAudit(
        this.#o.audit,
        this.#record(principal, "secret.rotate", id, {
          name: row.name,
          kind: row.kind,
          fingerprint,
          previous_fingerprint: row.fingerprint,
          version: binding.version,
        }),
        () => {
          const ok = this.#o.store.replaceValue(this.#workspaceId, id, row.version, {
            ...sealed,
            fingerprint,
            version: binding.version,
            updatedAt: this.#now(),
          });
          if (!ok) throw fail("secret.conflict", `secret ${row.name} changed meanwhile; retry`);
        },
      );
      this.#registerFields(fields);
      return { fingerprint, version: binding.version };
    });
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.#authorize(principal, "secret.delete", "secret", id);
    await this.#serial(async () => {
      const row = this.#row(id);
      await withAudit(
        this.#o.audit,
        this.#record(principal, "secret.delete", id, {
          name: row.name,
          kind: row.kind,
          fingerprint: row.fingerprint,
          version: row.version,
        }),
        () => this.#o.store.remove(this.#workspaceId, id),
      );
    });
  }

  /** The audited uses of a secret, newest first, before `before`. */
  async uses(principal: Principal, id: string, before?: string): Promise<SecretUse[]> {
    await this.#authorize(principal, "secret.uses", "secret", id);
    const until = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(until)) {
      throw invalid("before must be an integer (ms since the epoch)");
    }
    return this.#o.store.uses(this.#workspaceId, id, until, MAX_USES);
  }

  /**
   * Re-encrypt every entry under a new data key in one transaction. The
   * fingerprints come from the master key, so they do not change.
   */
  async rotateDataKey(principal: Principal): Promise<{ entries: number }> {
    await this.#authorize(principal, "vault.data-key.rotate", "vault");
    return this.#serial(async () => {
      const state = await this.#enabled();
      const dek = await generateDataKey();
      const rows = this.#o.store.list(this.#workspaceId);
      const entries = new Map<string, SealedEntry>();
      for (const row of rows) {
        const fields = await this.#open_(state.dek, row);
        entries.set(row.id, await sealEntry(dek, bindingOf(row), fields));
      }
      const wrappedDek = await state.keys.wrap(dek);
      await withAudit(
        this.#o.audit,
        this.#record(principal, "vault.data-key.rotate", undefined, { entries: rows.length }),
        () => this.#o.store.reencrypt({ wrappedDek, rotatedAt: this.#now() }, entries),
      );
      state.dek = dek;
      return { entries: rows.length };
    });
  }

  // ---- Uses ----

  /** `vault:` through the SecretStore: hub-side, global entries, model keys and hub tokens. */
  readForHub(name: string, field: string | undefined, ref: SecretRef): Promise<string> {
    return this.#reveal(name, field, ref, {
      consumer: "hub",
      kinds: ["model-key", "token"],
    });
  }

  /**
   * A use by a tool in a session (the hook for `browser_fill`, #118): the
   * entry must be global or scoped to that session and of an accepted kind.
   */
  async use(ref: SecretRef, context: VaultUseContext): Promise<SecretValue> {
    const parsed = parseSecretRef(ref);
    const body = parsed.scheme === "vault" ? parseVaultRefBody(parsed.body) : undefined;
    if (body === undefined) {
      throw vaultSecretError(ref, "secret.malformed-ref", "expected vault:<name>[#field]");
    }
    const value = await this.#reveal(body.name, body.field, ref, {
      consumer: "tool",
      ...context,
    });
    return new SecretValue(value);
  }

  async #reveal(
    name: string,
    field: string | undefined,
    ref: SecretRef,
    context: {
      readonly consumer: "hub" | "tool";
      readonly kinds: readonly VaultKind[];
      readonly sessionId?: SessionId;
      readonly tool?: string;
      readonly toolCallId?: string;
      readonly origin?: string;
    },
  ): Promise<string> {
    await this.open();
    const state = this.#state;
    if (!state.enabled) {
      const reason = state.status.state === "disabled" ? state.status.reason : "starting";
      throw vaultSecretError(ref, "vault.disabled", `the vault is disabled (${reason})`);
    }
    const row = this.#o.store.byName(this.#workspaceId, name);
    if (row === undefined) {
      throw vaultSecretError(ref, "secret.not-found", "no vault entry with this name");
    }
    const fieldName = field ?? VAULT_FIELDS[row.kind].primary;
    const detail = {
      name: row.name,
      field: fieldName,
      kind: row.kind,
      fingerprint: row.fingerprint,
      version: row.version,
      consumer: context.consumer,
      session_id: context.sessionId ?? null,
      tool: context.tool ?? null,
      tool_call_id: context.toolCallId ?? null,
      origin: context.origin ?? null,
    };
    const refuse = async (code: SecretErrorCode, problem: string): Promise<never> => {
      // Best effort: a refusal hands out nothing, so a failed record does not change it.
      await this.#o.audit
        .write(this.#record(SYSTEM_PRINCIPAL, "secret.use-refused", row.id, { ...detail, code }))
        .catch(() => {});
      throw vaultSecretError(ref, code, problem);
    };
    let fields: Record<string, string>;
    try {
      // Decrypt first: the scope and policy checked below are authentic only
      // once the AAD that binds them verified.
      fields = await openEntry(state.dek, bindingOf(row), row);
    } catch {
      // Any failure here (a bad tag, a bound column no AAD can hold) is a corrupt row.
      return refuse("vault.entry-corrupt", "the entry does not decrypt (edited or moved)");
    }
    if (!context.kinds.includes(row.kind)) {
      return refuse("vault.kind-mismatch", `a ${row.kind} entry cannot be used here`);
    }
    if (row.kind === "token" && context.consumer === "hub") {
      const policy = JSON.parse(row.policyJson) as { use?: string };
      if (policy.use !== "hub") {
        return refuse("vault.kind-mismatch", "this token is for box commands, not the hub");
      }
    }
    if (row.scopeSessionId !== null && row.scopeSessionId !== context.sessionId) {
      return refuse("vault.scope-mismatch", "the entry is scoped to another session");
    }
    const value = VAULT_FIELDS[row.kind].fields.includes(fieldName) ? fields[fieldName] : undefined;
    if (value === undefined) {
      return refuse("vault.field-unknown", `a ${row.kind} has no field ${fieldName}`);
    }
    // Write-before-use (PRD §6.10, §10): no record, no value.
    try {
      await this.#o.audit.write(this.#record(SYSTEM_PRINCIPAL, "secret.use", row.id, detail));
    } catch {
      throw vaultSecretError(ref, "vault.audit-failed", "the use could not be audited; not used");
    }
    this.#o.store.touch(this.#workspaceId, row.id, this.#now());
    this.#register(value);
    return value;
  }

  // ---- Opening and key rotation ----

  async #open(): Promise<VaultStatus> {
    const current = await this.#loadKey(this.#o.keyRef, "HEARTH_VAULT_KEY_REF");
    // An unset next ref, or a next file that does not exist, means no rotation.
    const loaded = await this.#loadKey(this.#o.nextKeyRef, "HEARTH_VAULT_KEY_NEXT_REF");
    const next = loaded.ok ? loaded.keys : undefined;
    if (!loaded.ok && loaded.reason === "key-invalid") {
      this.#log(`vault: the next key is not used: ${loaded.detail}`);
    }
    let record = this.#o.store.keyRecord();
    if (record === undefined) {
      if (!current.ok) return this.#disable(current.reason, current.detail);
      const dek = await generateDataKey();
      const wrappedDek = await current.keys.wrap(dek);
      await withAudit(
        this.#o.audit,
        this.#record(SYSTEM_PRINCIPAL, "vault.key.create", undefined, {
          kek_check: short(current.keys.kekCheck),
          provider: current.keys.provider,
        }),
        () =>
          this.#o.store.insertKeyRecord({
            wrappedDek,
            kekCheck: current.keys.kekCheck,
            provider: current.keys.provider,
            createdAt: this.#now(),
            rotatedAt: null,
          }),
      );
      // Another hub on the same file may have won the insert: use what is stored.
      record = this.#o.store.keyRecord();
      if (record === undefined) throw new Error("the vault key row vanished");
      this.#log("vault: created the data key");
    }
    let active: VaultKeyProvider;
    let via: "current" | "next";
    if (current.ok && current.keys.kekCheck === record.kekCheck) {
      active = current.keys;
      via = "current";
    } else if (next !== undefined && next.kekCheck === record.kekCheck) {
      active = next;
      via = "next";
      this.#log(
        "vault: running on vault_key.next, the rotation is committed: move secrets/vault_key.next over secrets/vault_key and restart",
      );
    } else if (!current.ok) {
      return this.#disable(current.reason, current.detail);
    } else {
      return this.#disable(
        "key-mismatch",
        `the vault key (kek_check ${short(current.keys.kekCheck)}) does not match this database (expects ${short(record.kekCheck)})`,
        { expected: short(record.kekCheck), found: short(current.keys.kekCheck) },
      );
    }
    let dek: CryptoKey;
    try {
      dek = await active.unwrap(record.wrappedDek);
    } catch {
      return this.#disable("store-corrupt", "the data key does not unwrap under a matching key");
    }
    if (via === "current" && next !== undefined && next.kekCheck !== active.kekCheck) {
      try {
        await this.#rotateMaster(active, next, dek);
        active = next;
        via = "next";
      } catch (error) {
        // The transaction rolled back: still on the current key; the next start retries.
        this.#log(
          `vault: key rotation failed, still on the current key: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const status: VaultStatus = { state: "enabled", kekCheck: short(active.kekCheck), key: via };
    this.#state = { enabled: true, keys: active, dek, status };
    await this.#registerStored(dek);
    this.#log(`vault: enabled (kek_check ${short(active.kekCheck)})`);
    return status;
  }

  async #rotateMaster(from: VaultKeyProvider, to: VaultKeyProvider, dek: CryptoKey) {
    const fingerprints = new Map<string, string>();
    for (const row of this.#o.store.list(this.#workspaceId)) {
      try {
        const fields = await openEntry(dek, bindingOf(row), row);
        fingerprints.set(row.id, await to.fingerprint(this.#primary(row.kind, fields)));
      } catch {
        this.#log(`vault: entry ${row.name} does not decrypt; its fingerprint is kept`);
      }
    }
    const wrappedDek = await to.wrap(dek);
    await withAudit(
      this.#o.audit,
      this.#record(SYSTEM_PRINCIPAL, "vault.key.rotate", undefined, {
        from_kek_check: short(from.kekCheck),
        to_kek_check: short(to.kekCheck),
        entries: fingerprints.size,
      }),
      () =>
        this.#o.store.rewrap(
          { wrappedDek, kekCheck: to.kekCheck, rotatedAt: this.#now() },
          fingerprints,
        ),
    );
    this.#log(
      "vault: key rotated to vault_key.next: move secrets/vault_key.next over secrets/vault_key and restart",
    );
  }

  async #loadKey(ref: SecretRef | undefined, variable: string): Promise<Loaded> {
    if (ref === undefined || ref === "") {
      return { ok: false, reason: "key-missing", detail: `${variable} is not set` };
    }
    let text: string;
    try {
      text = (await this.#o.keySecrets.resolve(ref)).reveal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "lookup failed";
      const missing = error instanceof SecretError && error.code === "secret.not-found";
      return { ok: false, reason: missing ? "key-missing" : "key-invalid", detail: message };
    }
    const bytes = parseMasterKey(text);
    if (bytes === undefined) {
      return {
        ok: false,
        reason: "key-invalid",
        detail: `${variable}: the key is not the base64 of 32 bytes`,
      };
    }
    this.#register(text.trim());
    return { ok: true, keys: await MasterKeyProvider.fromBytes(bytes) };
  }

  #disable(
    reason: VaultDisabledReason,
    detail: string,
    checks?: { expected: string; found: string },
  ): VaultStatus {
    const status: VaultStatus = {
      state: "disabled",
      reason,
      message: `${detail}; ${FIX[reason]}`,
      ...(checks === undefined
        ? {}
        : { expectedKekCheck: checks.expected, foundKekCheck: checks.found }),
    };
    this.#state = { enabled: false, status };
    this.#log(`vault: disabled (${reason}): ${status.message}`);
    return status;
  }

  /** Every stored value joins the redaction set at open (decision 0021). */
  async #registerStored(dek: CryptoKey): Promise<void> {
    for (const row of this.#o.store.list(this.#workspaceId)) {
      try {
        this.#registerFields(await openEntry(dek, bindingOf(row), row));
      } catch {
        this.#log(`vault: entry ${row.name} does not decrypt (vault.entry-corrupt)`);
      }
    }
  }

  // ---- Helpers ----

  async #open_(dek: CryptoKey, row: VaultEntryRecord): Promise<Record<string, string>> {
    try {
      return await openEntry(dek, bindingOf(row), row);
    } catch (error) {
      if (error instanceof VaultCryptoError) {
        throw fail("vault.entry-corrupt", `secret ${row.name} does not decrypt`, "hub");
      }
      throw error;
    }
  }

  async #enabled(): Promise<Extract<State, { enabled: true }>> {
    await this.open();
    const state = this.#state;
    if (!state.enabled) {
      const reason = state.status.state === "disabled" ? state.status.reason : "starting";
      throw fail("vault.disabled", `the vault is disabled (${reason})`);
    }
    return state;
  }

  #row(id: string): VaultEntryRecord {
    const row = this.#o.store.byId(this.#workspaceId, id);
    if (row === undefined) throw fail("secret.not-found", "no such secret");
    return row;
  }

  #primary(kind: VaultKind, fields: Readonly<Record<string, string>>): string {
    return fields[VAULT_FIELDS[kind].primary] ?? "";
  }

  #registerFields(fields: Readonly<Record<string, string>>): void {
    for (const value of Object.values(fields)) this.#register(value);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(work, work);
    this.#lock = run.catch(() => {});
    return run;
  }

  #record(
    principal: Principal,
    action: string,
    id: string | undefined,
    detail: JsonValue,
  ): AuditRecord {
    return {
      workspaceId: principal.workspaceId,
      principalId: principal.id,
      principalKind: principal.kind,
      action,
      resource: {
        workspaceId: this.#workspaceId,
        type: action.startsWith("vault.") ? "vault" : "secret",
        ...(id === undefined ? {} : { id }),
      },
      at: this.#now(),
      detail,
    };
  }

  async #authorize(
    principal: Principal,
    action: `${string}.${string}`,
    type: "secret" | "vault",
    id?: string,
  ) {
    const decision = await this.#o.authorizer.authorize(principal, action, {
      workspaceId: this.#workspaceId,
      type,
      ...(id === undefined ? {} : { id }),
    });
    if (!decision.allowed) throw fail("authz.denied", `${action} denied: ${decision.reason}`);
  }

  #log(line: string): void {
    (this.#o.log ?? console.error)(line);
  }
}
