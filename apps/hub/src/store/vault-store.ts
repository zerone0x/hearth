/**
 * The SQLite `VaultEntryBackend` (decision 0031): the `vault_key` and `secret`
 * tables of migration 6. It stores ciphertexts and metadata only; the crypto is
 * in `@hearth/core` (`vault.ts`) and the key handling in `apps/hub/src/vault`.
 */

import type { Database } from "bun:sqlite";
import {
  type EpochMs,
  HearthError,
  type SealedEntry,
  type VaultEntryBackend,
  type VaultEntryRecord,
  type VaultKeyRecord,
  type VaultKind,
  type WorkspaceId,
} from "@hearth/core";

interface SecretRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  scope_session_id: string | null;
  policy_json: string;
  meta_json: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  version: number;
  fingerprint: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

const COLUMNS = `id, workspace_id, name, kind, scope_session_id, policy_json, meta_json, iv,
  ciphertext, version, fingerprint, created_at, updated_at, last_used_at`;

function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function toRecord(row: SecretRow): VaultEntryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind as VaultKind,
    scopeSessionId: row.scope_session_id,
    policyJson: row.policy_json,
    metaJson: row.meta_json,
    iv: bytes(row.iv),
    ciphertext: bytes(row.ciphertext),
    version: row.version,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function constraint(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** One past use of a secret, from the `audit` table. */
export interface SecretUseRow {
  readonly at: EpochMs;
  readonly detail: unknown;
}

export interface SqliteVaultStoreOptions {
  /**
   * Called inside the rotation transactions after the key row is written and
   * before the entries are. Tests throw from it to prove a crash in the middle
   * leaves the store as it was.
   */
  readonly midRotation?: () => void;
}

export class SqliteVaultStore implements VaultEntryBackend {
  readonly #db: Database;
  readonly #midRotation: () => void;

  constructor(db: Database, options: SqliteVaultStoreOptions = {}) {
    this.#db = db;
    this.#midRotation = options.midRotation ?? (() => {});
  }

  keyRecord(): VaultKeyRecord | undefined {
    const row = this.#db
      .query<
        {
          wrapped_dek: Uint8Array;
          kek_check: string;
          provider: string;
          created_at: number;
          rotated_at: number | null;
        },
        []
      >(
        "SELECT wrapped_dek, kek_check, provider, created_at, rotated_at FROM vault_key WHERE id = 1",
      )
      .get();
    if (row === null) return undefined;
    return {
      wrappedDek: bytes(row.wrapped_dek),
      kekCheck: row.kek_check,
      provider: row.provider,
      createdAt: row.created_at,
      rotatedAt: row.rotated_at,
    };
  }

  insertKeyRecord(record: VaultKeyRecord): boolean {
    return (
      this.#db.run(
        `INSERT INTO vault_key (id, wrapped_dek, kek_check, provider, created_at, rotated_at)
         VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        [record.wrappedDek, record.kekCheck, record.provider, record.createdAt, record.rotatedAt],
      ).changes === 1
    );
  }

  list(workspaceId: WorkspaceId): VaultEntryRecord[] {
    return this.#db
      .query<SecretRow, [string]>(
        `SELECT ${COLUMNS} FROM secret WHERE workspace_id = ? ORDER BY name`,
      )
      .all(workspaceId)
      .map(toRecord);
  }

  byName(workspaceId: WorkspaceId, name: string): VaultEntryRecord | undefined {
    const row = this.#db
      .query<SecretRow, [string, string]>(
        `SELECT ${COLUMNS} FROM secret WHERE workspace_id = ? AND name = ?`,
      )
      .get(workspaceId, name);
    return row === null ? undefined : toRecord(row);
  }

  byId(workspaceId: WorkspaceId, id: string): VaultEntryRecord | undefined {
    const row = this.#db
      .query<SecretRow, [string, string]>(
        `SELECT ${COLUMNS} FROM secret WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, id);
    return row === null ? undefined : toRecord(row);
  }

  insert(entry: VaultEntryRecord): void {
    try {
      this.#db.run(
        `INSERT INTO secret (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.workspaceId,
          entry.name,
          entry.kind,
          entry.scopeSessionId,
          entry.policyJson,
          entry.metaJson,
          entry.iv,
          entry.ciphertext,
          entry.version,
          entry.fingerprint,
          entry.createdAt,
          entry.updatedAt,
          entry.lastUsedAt,
        ],
      );
    } catch (cause) {
      const code = constraint(cause);
      if (code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new HearthError(`a secret named ${entry.name} already exists`, {
          owner: "user",
          disposition: "give-up",
          code: "secret.name-taken",
        });
      }
      if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        throw new HearthError("scope names a session that does not exist", {
          owner: "user",
          disposition: "give-up",
          code: "request.invalid",
        });
      }
      throw cause;
    }
  }

  replaceValue(
    workspaceId: WorkspaceId,
    id: string,
    fromVersion: number,
    next: Pick<
      VaultEntryRecord,
      "iv" | "ciphertext" | "fingerprint" | "version" | "updatedAt" | "policyJson"
    >,
  ): boolean {
    return (
      this.#db.run(
        `UPDATE secret SET iv = ?, ciphertext = ?, fingerprint = ?, version = ?, updated_at = ?,
         policy_json = ?
         WHERE workspace_id = ? AND id = ? AND version = ?`,
        [
          next.iv,
          next.ciphertext,
          next.fingerprint,
          next.version,
          next.updatedAt,
          next.policyJson,
          workspaceId,
          id,
          fromVersion,
        ],
      ).changes === 1
    );
  }

  remove(workspaceId: WorkspaceId, id: string): boolean {
    return (
      this.#db.run("DELETE FROM secret WHERE workspace_id = ? AND id = ?", [workspaceId, id])
        .changes === 1
    );
  }

  touch(workspaceId: WorkspaceId, id: string, at: EpochMs): void {
    this.#db.run("UPDATE secret SET last_used_at = ? WHERE workspace_id = ? AND id = ?", [
      at,
      workspaceId,
      id,
    ]);
  }

  rewrap(
    key: Pick<VaultKeyRecord, "wrappedDek" | "kekCheck" | "rotatedAt">,
    fingerprints: ReadonlyMap<string, string>,
  ): void {
    this.#db.transaction(() => {
      this.#db.run(
        "UPDATE vault_key SET wrapped_dek = ?, kek_check = ?, rotated_at = ? WHERE id = 1",
        [key.wrappedDek, key.kekCheck, key.rotatedAt],
      );
      this.#midRotation();
      for (const [id, fingerprint] of fingerprints) {
        this.#db.run("UPDATE secret SET fingerprint = ? WHERE id = ?", [fingerprint, id]);
      }
    })();
  }

  reencrypt(
    key: Pick<VaultKeyRecord, "wrappedDek" | "rotatedAt">,
    entries: ReadonlyMap<string, SealedEntry>,
  ): void {
    this.#db.transaction(() => {
      this.#db.run("UPDATE vault_key SET wrapped_dek = ?, rotated_at = ? WHERE id = 1", [
        key.wrappedDek,
        key.rotatedAt,
      ]);
      this.#midRotation();
      for (const [id, sealed] of entries) {
        this.#db.run("UPDATE secret SET iv = ?, ciphertext = ? WHERE id = ?", [
          sealed.iv,
          sealed.ciphertext,
          id,
        ]);
      }
    })();
  }

  /** The `secret.use` audit rows of one secret, newest first. */
  uses(workspaceId: WorkspaceId, id: string, before: EpochMs, limit: number): SecretUseRow[] {
    return this.#db
      .query<{ at: number; detail_json: string | null }, [string, string, number, number]>(
        `SELECT at, detail_json FROM audit
         WHERE resource_type = 'secret' AND resource_workspace_id = ? AND resource_id = ?
           AND action = 'secret.use' AND at < ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(workspaceId, id, before, limit)
      .map((row) => ({
        at: row.at,
        detail: row.detail_json === null ? null : JSON.parse(row.detail_json),
      }));
  }
}
