/**
 * SQLite rows of the session manager (docs/DECISIONS.md, 0013): sessions,
 * their box, and in-flight orchestration (`session_operation`). The state
 * machine itself lives in `session/manager.ts`; this file only reads and
 * writes rows. State changes are also written to the event log by the manager.
 */

import type { Database } from "bun:sqlite";
import type { BoxId, EpochMs, JsonValue, SessionId, WorkspaceScope } from "@hearth/core";

export interface SessionRow {
  readonly id: SessionId;
  readonly workspaceId: string;
  readonly title: string;
  readonly state: string;
  readonly model: string | null;
  readonly repoUrl: string | null;
  readonly boxId: BoxId | null;
  readonly lastActivityAt: EpochMs;
  readonly createdAt: EpochMs;
  readonly archivedAt: EpochMs | null;
}

export interface BoxRow {
  readonly id: BoxId;
  readonly sessionId: SessionId | null;
  readonly provider: string;
  readonly state: string;
  readonly image: string;
}

export type OperationKind = "wake" | "hibernate";
export type OperationStatus = "running" | "done" | "failed" | "interrupted";

export interface OperationRow {
  readonly id: number;
  readonly sessionId: SessionId;
  readonly kind: OperationKind;
  readonly status: OperationStatus;
  readonly startedAt: EpochMs;
}

interface RawSession {
  id: string;
  workspace_id: string;
  title: string;
  state: string;
  model: string | null;
  repo_url: string | null;
  box_id: string | null;
  last_activity_at: number;
  created_at: number;
  archived_at: number | null;
}

function toSession(r: RawSession): SessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    state: r.state,
    model: r.model,
    repoUrl: r.repo_url,
    boxId: r.box_id,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

const SESSION_COLUMNS =
  "id, workspace_id, title, state, model, repo_url, box_id, last_activity_at, created_at, archived_at";

export class SqliteSessionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insertSession(
    scope: WorkspaceScope,
    row: {
      readonly id: SessionId;
      readonly title: string;
      readonly state: string;
      readonly model?: string;
      readonly repoUrl?: string;
      readonly boxId: BoxId;
      readonly now: EpochMs;
    },
  ): void {
    this.#db.run(
      `INSERT INTO session (id, workspace_id, title, state, model, repo_url, box_id, last_activity_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        scope.workspaceId,
        row.title,
        row.state,
        row.model ?? null,
        row.repoUrl ?? null,
        row.boxId,
        row.now,
        row.now,
      ],
    );
  }

  getSession(scope: WorkspaceScope, id: SessionId): SessionRow | undefined {
    const row = this.#db
      .query<RawSession, [string, string]>(
        `SELECT ${SESSION_COLUMNS} FROM session WHERE workspace_id = ? AND id = ?`,
      )
      .get(scope.workspaceId, id);
    return row === null ? undefined : toSession(row);
  }

  /** Newest activity first. */
  listSessions(scope: WorkspaceScope, states?: readonly string[]): SessionRow[] {
    const rows = this.#db
      .query<RawSession, [string]>(
        `SELECT ${SESSION_COLUMNS} FROM session WHERE workspace_id = ?
         ORDER BY last_activity_at DESC, id`,
      )
      .all(scope.workspaceId)
      .map(toSession);
    return states === undefined ? rows : rows.filter((r) => states.includes(r.state));
  }

  setSessionState(scope: WorkspaceScope, id: SessionId, state: string, now: EpochMs): void {
    this.#db.run(
      `UPDATE session SET state = ?, last_activity_at = ?,
         archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END
       WHERE workspace_id = ? AND id = ?`,
      [state, now, state, now, scope.workspaceId, id],
    );
  }

  upsertBox(
    scope: WorkspaceScope,
    box: {
      readonly id: BoxId;
      readonly sessionId: SessionId;
      readonly provider: string;
      readonly state: string;
      readonly image: string;
      readonly providerRef?: string;
      readonly volumeRef?: string;
      readonly now: EpochMs;
    },
  ): void {
    this.#db.run(
      `INSERT INTO box (id, workspace_id, session_id, provider, provider_ref, volume_ref, state, image, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state,
         provider_ref = excluded.provider_ref, volume_ref = excluded.volume_ref`,
      [
        box.id,
        scope.workspaceId,
        box.sessionId,
        box.provider,
        box.providerRef ?? null,
        box.volumeRef ?? null,
        box.state,
        box.image,
        box.now,
      ],
    );
  }

  setBoxState(scope: WorkspaceScope, id: BoxId, state: string): void {
    this.#db.run("UPDATE box SET state = ? WHERE workspace_id = ? AND id = ?", [
      state,
      scope.workspaceId,
      id,
    ]);
  }

  getBox(scope: WorkspaceScope, id: BoxId): BoxRow | undefined {
    const row = this.#db
      .query<
        { id: string; session_id: string | null; provider: string; state: string; image: string },
        [string, string]
      >(
        "SELECT id, session_id, provider, state, image FROM box WHERE workspace_id = ? AND id = ?",
      )
      .get(scope.workspaceId, id);
    return row === null
      ? undefined
      : {
          id: row.id,
          sessionId: row.session_id,
          provider: row.provider,
          state: row.state,
          image: row.image,
        };
  }

  /** Log an operation before acting on it (PRD §8.1 principle 6). Returns its id. */
  beginOperation(
    scope: WorkspaceScope,
    sessionId: SessionId,
    kind: OperationKind,
    now: EpochMs,
  ): number {
    const row = this.#db
      .query<{ id: number }, [string, string, string, number]>(
        `INSERT INTO session_operation (workspace_id, session_id, kind, status, started_at)
         VALUES (?, ?, ?, 'running', ?) RETURNING id`,
      )
      .get(scope.workspaceId, sessionId, kind, now);
    if (row === null) throw new Error("session_operation insert returned no id");
    return row.id;
  }

  finishOperation(
    id: number,
    status: Exclude<OperationStatus, "running">,
    now: EpochMs,
    detail?: JsonValue,
  ): void {
    this.#db.run(
      `UPDATE session_operation SET status = ?, finished_at = ?, detail_json = ?
       WHERE id = ? AND status = 'running'`,
      [status, now, detail === undefined ? null : JSON.stringify(detail), id],
    );
  }

  runningOperations(scope: WorkspaceScope): OperationRow[] {
    return this.#db
      .query<
        { id: number; session_id: string; kind: OperationKind; status: OperationStatus; started_at: number },
        [string]
      >(
        `SELECT id, session_id, kind, status, started_at FROM session_operation
         WHERE workspace_id = ? AND status = 'running' ORDER BY id`,
      )
      .all(scope.workspaceId)
      .map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        kind: r.kind,
        status: r.status,
        startedAt: r.started_at,
      }));
  }

  operations(scope: WorkspaceScope, sessionId: SessionId): OperationRow[] {
    return this.#db
      .query<
        { id: number; session_id: string; kind: OperationKind; status: OperationStatus; started_at: number },
        [string, string]
      >(
        `SELECT id, session_id, kind, status, started_at FROM session_operation
         WHERE workspace_id = ? AND session_id = ? ORDER BY id`,
      )
      .all(scope.workspaceId, sessionId)
      .map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        kind: r.kind,
        status: r.status,
        startedAt: r.started_at,
      }));
  }
}
