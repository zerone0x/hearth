/**
 * The `approval` table of migration 11 (#155, decision 0048): the hub-side
 * record of each tool call the access gate held for the owner. A row leaves
 * `pending` once: `finish` is a conditional UPDATE, so two deciders (a
 * click and the timeout) cannot both win.
 */

import type { Database } from "bun:sqlite";
import type { EpochMs, SessionId, WorkspaceScope } from "@hearth/core";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "interrupted";

export interface ApprovalRow {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly toolCallId: string;
  readonly tool: string;
  readonly summary: string;
  readonly rule: string;
  readonly mode: "yolo" | "ask";
  readonly status: ApprovalStatus;
  readonly requestedAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly decidedAt: EpochMs | null;
  readonly decidedBy: string | null;
  readonly reason: string | null;
}

interface Raw {
  id: string;
  session_id: string;
  tool_call_id: string;
  tool: string;
  summary: string;
  rule: string;
  mode: "yolo" | "ask";
  status: ApprovalStatus;
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
  reason: string | null;
}

function rowOf(raw: Raw): ApprovalRow {
  return {
    id: raw.id,
    sessionId: raw.session_id,
    toolCallId: raw.tool_call_id,
    tool: raw.tool,
    summary: raw.summary,
    rule: raw.rule,
    mode: raw.mode,
    status: raw.status,
    requestedAt: raw.requested_at,
    expiresAt: raw.expires_at,
    decidedAt: raw.decided_at,
    decidedBy: raw.decided_by,
    reason: raw.reason,
  };
}

export interface ApprovalFinish {
  readonly status: Exclude<ApprovalStatus, "pending">;
  readonly at: EpochMs;
  readonly by: string | null;
  readonly reason: string;
}

export class SqliteApprovalStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insert(
    scope: WorkspaceScope,
    row: Omit<ApprovalRow, "status" | "decidedAt" | "decidedBy" | "reason">,
  ): void {
    this.#db.run(
      `INSERT INTO approval (id, workspace_id, session_id, tool_call_id, tool, summary, rule, mode,
         status, requested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        row.id,
        scope.workspaceId,
        row.sessionId,
        row.toolCallId,
        row.tool,
        row.summary,
        row.rule,
        row.mode,
        row.requestedAt,
        row.expiresAt,
      ],
    );
  }

  /** The approval `id` of `sessionId`; another session's id reads as unknown. */
  get(scope: WorkspaceScope, sessionId: SessionId, id: string): ApprovalRow | undefined {
    const raw = this.#db
      .query<Raw, [string, string, string]>(
        "SELECT * FROM approval WHERE workspace_id = ? AND session_id = ? AND id = ?",
      )
      .get(scope.workspaceId, sessionId, id);
    return raw === null ? undefined : rowOf(raw);
  }

  /** Every pending approval, oldest first. */
  pending(scope: WorkspaceScope): ApprovalRow[] {
    return this.#db
      .query<Raw, [string]>(
        "SELECT * FROM approval WHERE workspace_id = ? AND status = 'pending' ORDER BY requested_at, id",
      )
      .all(scope.workspaceId)
      .map(rowOf);
  }

  /** Move a pending approval to its end state. False when it had already left `pending`. */
  finish(scope: WorkspaceScope, id: string, end: ApprovalFinish): boolean {
    const result = this.#db.run(
      `UPDATE approval SET status = ?, decided_at = ?, decided_by = ?, reason = ?
       WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
      [end.status, end.at, end.by, end.reason, scope.workspaceId, id],
    );
    return result.changes === 1;
  }
}
