/**
 * The SQLite implementation of `LoginStore` (decision 0014): the owner
 * password hash and login sessions, stored by the SHA-256 of their id.
 */

import type { Database } from "bun:sqlite";
import type { EpochMs, PrincipalId, WorkspaceId } from "@hearth/core";
import type { LoginSessionRecord, LoginStore } from "../auth/store";

interface SessionRow {
  id_hash: string;
  workspace_id: string;
  principal_id: string;
  created_at: number;
  expires_at: number;
}

export class SqliteLoginStore implements LoginStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  passwordHash(principalId: PrincipalId): string | undefined {
    const row = this.#db
      .query<{ password_hash: string }, [string]>(
        "SELECT password_hash FROM owner_password WHERE principal_id = ?",
      )
      .get(principalId);
    return row?.password_hash;
  }

  setInitialPassword(
    workspaceId: WorkspaceId,
    principalId: PrincipalId,
    hash: string,
    at: EpochMs,
  ): boolean {
    const result = this.#db.run(
      `INSERT INTO owner_password (principal_id, workspace_id, password_hash, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT (principal_id) DO NOTHING`,
      [principalId, workspaceId, hash, at],
    );
    return result.changes === 1;
  }

  createSession(session: LoginSessionRecord): void {
    this.#db.run(
      `INSERT INTO login_session (id_hash, workspace_id, principal_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        session.idHash,
        session.workspaceId,
        session.principalId,
        session.createdAt,
        session.expiresAt,
      ],
    );
  }

  findSession(idHash: string): LoginSessionRecord | undefined {
    const row = this.#db
      .query<SessionRow, [string]>(
        `SELECT id_hash, workspace_id, principal_id, created_at, expires_at
         FROM login_session WHERE id_hash = ?`,
      )
      .get(idHash);
    if (row === null) return undefined;
    return {
      idHash: row.id_hash,
      workspaceId: row.workspace_id,
      principalId: row.principal_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  deleteSession(idHash: string): void {
    this.#db.run("DELETE FROM login_session WHERE id_hash = ?", [idHash]);
  }

  deleteExpiredSessions(now: EpochMs): number {
    return this.#db.run("DELETE FROM login_session WHERE expires_at <= ?", [now]).changes;
  }
}
