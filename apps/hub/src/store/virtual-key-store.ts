/**
 * The `session_virtual_key` table of migration 10 (decision 0047): a
 * session's Bifrost virtual key id and the allowlist and budget last sent.
 * Never the key's value.
 */

import type { Database } from "bun:sqlite";
import type { EpochMs, SessionId, WorkspaceId } from "@hearth/core";

export interface VirtualKeyRow {
  readonly sessionId: SessionId;
  readonly vkId: string;
  readonly provider: string;
  readonly model: string;
  readonly budgetUsd: number;
  readonly active: boolean;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

interface Raw {
  session_id: string;
  vk_id: string;
  provider: string;
  model: string;
  budget_usd: number;
  active: number;
  created_at: number;
  updated_at: number;
}

function rowOf(raw: Raw): VirtualKeyRow {
  return {
    sessionId: raw.session_id,
    vkId: raw.vk_id,
    provider: raw.provider,
    model: raw.model,
    budgetUsd: raw.budget_usd,
    active: raw.active === 1,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class SqliteVirtualKeyStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(workspaceId: WorkspaceId, sessionId: SessionId): VirtualKeyRow | undefined {
    const raw = this.#db
      .query<Raw, [string, string]>(
        "SELECT * FROM session_virtual_key WHERE workspace_id = ? AND session_id = ?",
      )
      .get(workspaceId, sessionId);
    return raw === null ? undefined : rowOf(raw);
  }

  list(workspaceId: WorkspaceId): VirtualKeyRow[] {
    return this.#db
      .query<Raw, [string]>(
        "SELECT * FROM session_virtual_key WHERE workspace_id = ? ORDER BY created_at",
      )
      .all(workspaceId)
      .map(rowOf);
  }

  /** Insert or replace the session's row. */
  put(workspaceId: WorkspaceId, row: VirtualKeyRow): void {
    this.#db.run(
      `INSERT INTO session_virtual_key
         (workspace_id, session_id, vk_id, provider, model, budget_usd, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, session_id) DO UPDATE SET vk_id = excluded.vk_id,
         provider = excluded.provider, model = excluded.model, budget_usd = excluded.budget_usd,
         active = excluded.active, updated_at = excluded.updated_at`,
      [
        workspaceId,
        row.sessionId,
        row.vkId,
        row.provider,
        row.model,
        row.budgetUsd,
        row.active ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  remove(workspaceId: WorkspaceId, sessionId: SessionId): void {
    this.#db.run("DELETE FROM session_virtual_key WHERE workspace_id = ? AND session_id = ?", [
      workspaceId,
      sessionId,
    ]);
  }
}
