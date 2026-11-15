/**
 * Idempotent apply of hub → box commands (docs/DECISIONS.md, 0005).
 *
 * Commands are fire-and-forget, and after a reconnect the hub re-sends any
 * command whose effect it has not seen. So the box may receive the same
 * command twice, and must apply it at most once. These rules are pure, so the
 * box-agent and the tests share one definition.
 */

import type { CommandFrame, Frame } from "./frames";

/** What the box remembers about commands in the current boot. */
export interface CommandHistory {
  /** Every assign `requestId` the box has received in this boot. */
  readonly assignRequestIds: ReadonlySet<string>;
  /** Every `turnId` the box has started in this boot, running or ended. */
  readonly turnIds: ReadonlySet<string>;
  /** Every hibernate `requestId` the box has received in this boot. */
  readonly hibernateRequestIds: ReadonlySet<string>;
}

export function isCommand(frame: Frame): frame is CommandFrame {
  return (
    frame.type === "session.assign" ||
    frame.type === "turn.start" ||
    frame.type === "session.hibernate"
  );
}

/**
 * True when the box must ignore `command` because it has already applied it:
 *
 * - `session.assign` with a `requestId` the box knows. A replayed assign is
 *   ignored even after the session was hibernated, so it cannot wake the
 *   session again; a real resume carries a new `requestId`.
 * - `turn.start` with a `turnId` the box knows, so a turn never runs twice.
 *   Its outcome reaches the hub anyway: `turn.event` and `turn.end` are
 *   at-least-once.
 * - `session.hibernate` with a `requestId` the box knows. Its single
 *   `hibernate.done` is at-least-once, so the hub still gets the answer.
 */
export function isDuplicateCommand(history: CommandHistory, command: CommandFrame): boolean {
  switch (command.type) {
    case "session.assign":
      return history.assignRequestIds.has(command.requestId);
    case "turn.start":
      return history.turnIds.has(command.turnId);
    case "session.hibernate":
      return history.hibernateRequestIds.has(command.requestId);
  }
}
