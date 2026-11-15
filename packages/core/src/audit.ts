/**
 * E10 Audit (PRD §7, §10). Every `authorize` decision and every admin action is
 * recorded. The record is written before the action; if it cannot be written,
 * the action does not happen.
 */

import type { Decision, Resource } from "./authorize";
import { HearthError } from "./failure";
import type { PrincipalKind } from "./identity";
import type { EpochMs, JsonValue, PrincipalId, WorkspaceId } from "./ids";

export interface AuditRecord {
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  readonly principalKind: PrincipalKind;
  /** The action being audited, in the same vocabulary as `authorize`. */
  readonly action: string;
  readonly resource: Resource;
  /** The authorization outcome, or `undefined` for an admin action audited directly. */
  readonly decision?: Decision;
  readonly at: EpochMs;
  /** Extra context. Must never contain secret values: use references or fingerprints. */
  readonly detail?: JsonValue;
}

/**
 * Durable, append-only destination for audit records.
 *
 * Called by the `Authorizer` for every decision, and through `withAudit` before
 * any audited action. Guarantees:
 * - `write` resolves only after the record is durable (committed), and rejects
 *   if it is not. Callers treat a rejection as "the action must not happen".
 * - Records are never updated or deleted. Implementations enforce this in the
 *   storage layer itself (for SQLite: triggers), not only by convention.
 */
export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

/**
 * Write-before-act: writes `record`, then runs `action`. If the write fails,
 * `action` is not run and the call rejects with a `hub`-owned `HearthError`
 * (code `audit.write-failed`) that carries the sink's error as `cause`.
 */
export async function withAudit<T>(
  sink: AuditSink,
  record: AuditRecord,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    await sink.write(record);
  } catch (cause) {
    throw new HearthError(`Audit write failed for ${record.action}; the action was not run`, {
      owner: "hub",
      disposition: "retry",
      code: "audit.write-failed",
      cause,
    });
  }
  return await action();
}

/** An in-memory `AuditSink` for tests and for wiring before persistence exists. */
export class MemoryAuditSink implements AuditSink {
  readonly #records: AuditRecord[] = [];

  async write(record: AuditRecord): Promise<void> {
    this.#records.push(Object.freeze({ ...record }));
  }

  /** A copy of everything written so far, oldest first. */
  get records(): readonly AuditRecord[] {
    return [...this.#records];
  }
}
