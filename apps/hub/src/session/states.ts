/**
 * The session state machine (PRD §5, §6.3; docs/DECISIONS.md, 0013). It lives
 * only in the hub (PRD §8.1): boxes never see or change it.
 *
 *   creating → idle                       (created; no box yet, lazy start)
 *   idle → running                        (a tool call, box already connected)
 *   idle | hibernated → waking → running  (a tool call needs a box: lazy start / wake)
 *   running → idle                        (the last tool call in flight ended)
 *   idle → hibernated                     (idle for N minutes: the box is stopped)
 *   running | idle → waking               (the box exited and is relaunched)
 *   waking → idle                         (relaunched with no tool call waiting)
 *   waking → hibernated                   (the box could not start, or the hub restarted mid-wake)
 *   creating | running → idle             (after a hub restart)
 *   any but archived → failed | archived; failed → archived only
 */

import type { Action } from "@hearth/core";

export const SESSION_STATES = [
  "creating",
  "running",
  "idle",
  "hibernated",
  "waking",
  "failed",
  "archived",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/** For each state, the states it may move to. Anything else is refused. */
export const TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  creating: ["idle", "failed", "archived"],
  idle: ["running", "waking", "hibernated", "failed", "archived"],
  running: ["idle", "waking", "failed", "archived"],
  waking: ["running", "idle", "hibernated", "failed", "archived"],
  hibernated: ["waking", "failed", "archived"],
  failed: ["archived"],
  archived: [],
};

export function isSessionState(value: string): value is SessionState {
  return (SESSION_STATES as readonly string[]).includes(value);
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The `authorize` action of a transition, named by its target state. */
export const TRANSITION_ACTIONS: Readonly<Record<SessionState, Action>> = {
  creating: "session.create",
  running: "session.run",
  idle: "session.idle",
  hibernated: "session.hibernate",
  waking: "session.wake",
  failed: "session.fail",
  archived: "session.archive",
};
