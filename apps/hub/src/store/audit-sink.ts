/**
 * The SQLite implementation of E10 `AuditSink` (PRD §7, §10). It plugs into
 * `withAudit` and `AllowAllAuthorizer` from `@hearth/core`.
 */

import type { Database } from "bun:sqlite";
import { type AuditRecord, type AuditSink, HearthError } from "@hearth/core";

/**
 * Append-only audit log in the `audit` table.
 *
 * `write` is one autocommit INSERT: when it returns, the row is committed and,
 * with `synchronous = FULL` (see `openDatabase`), on disk. Any failure rejects,
 * so `withAudit` does not run the action. Triggers in the schema reject UPDATE,
 * DELETE and REPLACE on `audit`.
 */
export class SqliteAuditSink implements AuditSink {
  readonly #insert: (record: AuditRecord) => void;

  constructor(db: Database) {
    const insert = db.query<
      never,
      [
        string,
        number,
        string,
        string,
        string,
        string,
        string,
        string | null,
        number | null,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO audit (workspace_id, at, principal_id, principal_kind, action,
         resource_workspace_id, resource_type, resource_id, allowed, policy, reason, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#insert = (record) => {
      const { decision, resource } = record;
      const detail = record.detail === undefined ? null : JSON.stringify(record.detail);
      insert.run(
        record.workspaceId,
        record.at,
        record.principalId,
        record.principalKind,
        record.action,
        resource.workspaceId,
        resource.type,
        resource.id ?? null,
        decision === undefined ? null : decision.allowed ? 1 : 0,
        decision?.policy ?? null,
        decision !== undefined && !decision.allowed ? decision.reason : null,
        detail ?? null,
      );
    };
  }

  async write(record: AuditRecord): Promise<void> {
    try {
      this.#insert(record);
    } catch (cause) {
      throw new HearthError(`Could not write the audit record for ${record.action}`, {
        owner: "hub",
        disposition: "retry",
        code: "audit.write-failed",
        cause,
      });
    }
  }
}
