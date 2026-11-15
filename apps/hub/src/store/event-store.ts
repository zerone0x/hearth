/**
 * The SQLite implementation of E6 `EventStore` (PRD §5, §7, §8.1 principle 5).
 */

import type { Database } from "bun:sqlite";
import {
  type AppendResult,
  type EpochMs,
  type EventPage,
  type EventStore,
  HearthError,
  type JsonValue,
  type NewEvent,
  type Seq,
  type SessionId,
  type StoredEvent,
  type WorkspaceScope,
} from "@hearth/core";

/**
 * The most events one `read` returns, whatever `limit` asks for. A larger
 * request gets a full page with `hasMore: true` and continues from the cursor.
 */
export const MAX_READ_LIMIT = 1_000;

/**
 * The largest event payload `append` stores, measured as UTF-8 bytes of its
 * JSON. Events are streamed to clients and replayed on reconnect, so one
 * runaway payload must not bloat every read of the session; anything bigger
 * belongs outside the event log.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface SqliteEventStoreOptions {
  readonly now?: () => EpochMs;
}

interface EventRow {
  workspace_id: string;
  session_id: string;
  seq: number;
  ts: number;
  type: string;
  turn_id: string | null;
  payload_json: string;
  boot_id: string | null;
  delivery_id: number | null;
}

function invalid(message: string): HearthError {
  return new HearthError(message, { owner: "hub", disposition: "give-up", code: "event.invalid" });
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkScope(scope: WorkspaceScope, sessionId: SessionId): void {
  if (typeof scope.workspaceId !== "string" || scope.workspaceId === "") {
    throw invalid("The workspace scope has no workspace id");
  }
  if (typeof sessionId !== "string" || sessionId === "") {
    throw invalid("The session id is empty");
  }
}

function checkEvent(event: NewEvent): string {
  if (typeof event.type !== "string" || event.type === "") {
    throw invalid("The event type is empty");
  }
  if (event.ts !== undefined && !isNonNegativeInteger(event.ts)) {
    throw invalid(`The event time ${String(event.ts)} is not a non-negative integer`);
  }
  if (event.delivery !== undefined) {
    const { bootId, deliveryId } = event.delivery;
    if (typeof bootId !== "string" || bootId === "") {
      throw invalid("The delivery has an empty boot id");
    }
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) {
      throw invalid(`The delivery id ${String(deliveryId)} is not a positive integer`);
    }
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(event.payload, rejectNonJson);
  } catch {
    // A BigInt, a cycle, a function or symbol, or a throwing `toJSON`.
    json = undefined;
  }
  if (json === undefined) {
    throw invalid("The event payload is not JSON");
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
    throw invalid(
      `The event payload is ${bytes} bytes as JSON, over the ${MAX_EVENT_PAYLOAD_BYTES}-byte limit`,
    );
  }
  return json;
}

/**
 * `JSON.stringify` drops functions and symbols inside objects silently; a
 * payload holding one is a caller bug, so reject it instead of storing less
 * than was given.
 */
function rejectNonJson(_key: string, value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`A ${typeof value} is not JSON`);
  }
  return value;
}

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    payload: JSON.parse(row.payload_json) as JsonValue,
    ...(row.boot_id === null || row.delivery_id === null
      ? {}
      : { delivery: { bootId: row.boot_id, deliveryId: row.delivery_id } }),
  };
}

/**
 * Append-only event log in the `event` table.
 *
 * - `seq` is `max(seq) + 1` for the session, computed inside a
 *   `BEGIN IMMEDIATE` transaction. That takes SQLite's write lock before the
 *   read, so concurrent appends (also from other connections or processes)
 *   serialize and `seq` stays gap-free.
 * - Idempotency is enforced by the unique index on
 *   `(workspace_id, boot_id, delivery_id)`; the lookup before the insert
 *   returns the original `seq` instead of tripping it.
 * - A delivery key already applied to a different session is not a
 *   redelivery but a box bug; the append rejects with `event.delivery-conflict`
 *   rather than ack an event it did not store.
 * - Triggers reject UPDATE, DELETE and REPLACE on `event` (migrations 1, 2).
 */
export class SqliteEventStore implements EventStore {
  readonly #db: Database;
  readonly #now: () => EpochMs;
  readonly #append: (
    scope: WorkspaceScope,
    sessionId: SessionId,
    event: NewEvent,
    payloadJson: string,
  ) => AppendResult;

  constructor(db: Database, options: SqliteEventStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;

    const findDelivery = db.query<{ session_id: string; seq: number }, [string, string, number]>(
      "SELECT session_id, seq FROM event WHERE workspace_id = ? AND boot_id = ? AND delivery_id = ?",
    );
    const nextSeq = db.query<{ next: number }, [string, string]>(
      "SELECT coalesce(max(seq), 0) + 1 AS next FROM event WHERE workspace_id = ? AND session_id = ?",
    );
    const insert = db.query<
      never,
      [string, string, number, number, string, string | null, string, string | null, number | null]
    >(
      `INSERT INTO event (workspace_id, session_id, seq, ts, type, turn_id, payload_json, boot_id, delivery_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const append = db.transaction(
      (
        scope: WorkspaceScope,
        sessionId: SessionId,
        event: NewEvent,
        payloadJson: string,
      ): AppendResult => {
        const { workspaceId } = scope;
        const delivery = event.delivery;
        if (delivery !== undefined) {
          const existing = findDelivery.get(workspaceId, delivery.bootId, delivery.deliveryId);
          if (existing !== null) {
            if (existing.session_id !== sessionId) {
              throw new HearthError(
                `Delivery ${delivery.bootId}/${delivery.deliveryId} was already applied to another session`,
                { owner: "box", disposition: "give-up", code: "event.delivery-conflict" },
              );
            }
            return { seq: existing.seq, duplicate: true };
          }
        }
        const seq = nextSeq.get(workspaceId, sessionId)?.next ?? 1;
        insert.run(
          workspaceId,
          sessionId,
          seq,
          event.ts ?? this.#now(),
          event.type,
          event.turnId ?? null,
          payloadJson,
          delivery?.bootId ?? null,
          delivery?.deliveryId ?? null,
        );
        return { seq, duplicate: false };
      },
    );
    this.#append = (scope, sessionId, event, payloadJson) =>
      append.immediate(scope, sessionId, event, payloadJson);
  }

  async append(
    scope: WorkspaceScope,
    sessionId: SessionId,
    event: NewEvent,
  ): Promise<AppendResult> {
    checkScope(scope, sessionId);
    const payloadJson = checkEvent(event);
    try {
      return this.#append(scope, sessionId, event, payloadJson);
    } catch (cause) {
      if (cause instanceof HearthError) throw cause;
      throw new HearthError(`Could not append ${event.type} to session ${sessionId}`, {
        owner: "hub",
        disposition: "retry",
        code: "event.write-failed",
        cause,
      });
    }
  }

  async read(
    scope: WorkspaceScope,
    sessionId: SessionId,
    afterSeq: Seq,
    limit: number,
  ): Promise<EventPage> {
    checkScope(scope, sessionId);
    if (!isNonNegativeInteger(afterSeq)) {
      throw invalid(`The cursor ${String(afterSeq)} is not a non-negative integer`);
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw invalid(`The read limit ${String(limit)} is not a positive integer`);
    }
    const pageSize = Math.min(limit, MAX_READ_LIMIT);
    // One statement, so one consistent snapshot. Asking for one extra row
    // tells whether more exist without a second query.
    const rows = this.#db
      .query<EventRow, [string, string, number, number]>(
        `SELECT * FROM event WHERE workspace_id = ? AND session_id = ? AND seq > ?
         ORDER BY seq LIMIT ?`,
      )
      .all(scope.workspaceId, sessionId, afterSeq, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const events = rows.slice(0, pageSize).map(toStoredEvent);
    const last = events.at(-1);
    return { events, cursor: last === undefined ? afterSeq : last.seq, hasMore };
  }

  async lastSeq(scope: WorkspaceScope, sessionId: SessionId): Promise<Seq> {
    checkScope(scope, sessionId);
    const row = this.#db
      .query<{ last: number }, [string, string]>(
        "SELECT coalesce(max(seq), 0) AS last FROM event WHERE workspace_id = ? AND session_id = ?",
      )
      .get(scope.workspaceId, sessionId);
    return row?.last ?? 0;
  }
}
