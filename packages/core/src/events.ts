/**
 * E6 EventStore (PRD §5, §7, §8.1 principle 5): the append-only event log every
 * UI, sync and retro derives from. Interface only; the SQLite implementation
 * lives in the hub (#4).
 */

import type {
  BootId,
  DeliveryId,
  EpochMs,
  JsonValue,
  Seq,
  SessionId,
  TurnId,
  WorkspaceId,
} from "./ids";
import type { WorkspaceScope } from "./tenancy";

/**
 * Identifies one delivery from a box: the box-agent's boot id plus a delivery
 * id that is monotonic within that boot. A redelivery after reconnect carries
 * the same pair.
 */
export interface DeliveryKey {
  readonly bootId: BootId;
  readonly deliveryId: DeliveryId;
}

/** An event to append. The store assigns `seq` and stamps `workspaceId` from the scope. */
export interface NewEvent {
  /** For example `message.user`, `turn.event`, `session.state`, `approval.decided`. */
  readonly type: string;
  readonly turnId?: TurnId;
  readonly payload: JsonValue;
  /** When the event happened. Defaults to the time of the append. */
  readonly ts?: EpochMs;
  /**
   * Present for box-originated events and only for them. Makes the append
   * idempotent: see `EventStore.append`.
   */
  readonly delivery?: DeliveryKey;
}

export interface StoredEvent {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly seq: Seq;
  readonly ts: EpochMs;
  readonly type: string;
  readonly turnId?: TurnId;
  readonly payload: JsonValue;
  readonly delivery?: DeliveryKey;
}

export interface AppendResult {
  readonly seq: Seq;
  /**
   * `true` when the delivery had already been applied: nothing was written and
   * `seq` is the one assigned the first time. The caller still acks it.
   */
  readonly duplicate: boolean;
}

/** One page of a cursor read. */
export interface EventPage {
  /** In ascending `seq` order, all with `seq > afterSeq`. */
  readonly events: readonly StoredEvent[];
  /**
   * The cursor for the next read: the last returned `seq`, or the `afterSeq`
   * that was passed in when the page is empty.
   */
  readonly cursor: Seq;
  /** `true` when more events existed past this page at read time. */
  readonly hasMore: boolean;
}

/**
 * The append-only event log.
 *
 * Called by the hub only: the session manager (state changes, user messages),
 * the box connection handler (box-originated frames, then `delivery.ack`), and
 * the API's stream endpoint (cursor reads for resume after disconnect).
 */
export interface EventStore {
  /**
   * Append one event to a session's log.
   *
   * Guarantees:
   * - Per-session `seq` is assigned by the store: gap-free, strictly increasing
   *   in commit order, starting at 1, even under concurrent appends.
   * - When the promise resolves, the event is durable. The box connection
   *   handler sends `delivery.ack` only after that (ack on apply).
   * - Idempotent on `(bootId, deliveryId)` within a workspace: appending a
   *   delivery that was already applied writes nothing and returns the original
   *   `seq` with `duplicate: true`. Events without `delivery` are never deduplicated.
   * - Events are never updated or deleted.
   *
   * Rejects with a `hub`-owned `HearthError` when the write fails; nothing is
   * written in that case.
   */
  append(scope: WorkspaceScope, sessionId: SessionId, event: NewEvent): Promise<AppendResult>;

  /**
   * Read up to `limit` events with `seq > afterSeq`, oldest first. Pass `0` to
   * read from the start, then the returned `cursor` to continue.
   *
   * Guarantees: a cursor read never skips or repeats an event; a session that
   * does not exist (or belongs to another workspace) reads as empty.
   */
  read(
    scope: WorkspaceScope,
    sessionId: SessionId,
    afterSeq: Seq,
    limit: number,
  ): Promise<EventPage>;

  /** The highest `seq` of a session, or `0` when it has no events. */
  lastSeq(scope: WorkspaceScope, sessionId: SessionId): Promise<Seq>;
}
