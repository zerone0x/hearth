/**
 * The `setting` table of migration 8 (decision 0038): one JSON value per key
 * and workspace. The model settings (`apps/hub/src/settings`) are its only
 * user; values are references and choices, never a secret.
 */

import type { Database } from "bun:sqlite";
import type { EpochMs, WorkspaceId } from "@hearth/core";

export interface SettingRow {
  readonly valueJson: string;
  readonly updatedAt: EpochMs;
}

export class SqliteSettingStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(workspaceId: WorkspaceId, key: string): SettingRow | undefined {
    const row = this.#db
      .query<{ value_json: string; updated_at: number }, [string, string]>(
        "SELECT value_json, updated_at FROM setting WHERE workspace_id = ? AND key = ?",
      )
      .get(workspaceId, key);
    return row === null ? undefined : { valueJson: row.value_json, updatedAt: row.updated_at };
  }

  /** Insert or replace the value of `key`. */
  put(workspaceId: WorkspaceId, key: string, valueJson: string, at: EpochMs): void {
    this.#db.run(
      `INSERT INTO setting (workspace_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, key) DO UPDATE SET value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      [workspaceId, key, valueJson, at],
    );
  }

  /**
   * Insert `key` only when it has no value yet. Returns false when a value
   * was already there (another start imported first).
   */
  insertIfAbsent(workspaceId: WorkspaceId, key: string, valueJson: string, at: EpochMs): boolean {
    const result = this.#db.run(
      `INSERT INTO setting (workspace_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, key) DO NOTHING`,
      [workspaceId, key, valueJson, at],
    );
    return result.changes === 1;
  }
}
