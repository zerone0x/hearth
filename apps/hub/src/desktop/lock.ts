/**
 * The desktop lock (PRD §8.3, §11.2; decision 0033): who may send input to a
 * session's desktop. One lock per session, held in the hub's memory as a
 * lease: the holder renews it by interacting (each key or pointer message the
 * relay passes renews it), and a lease nobody renews lapses after `ttlMs`.
 *
 * - The owner takes it over with `acquire` and hands it back with `release`
 *   (both `desktop.control`: authorized, so audited, first). Closing the last
 *   desktop viewer the holder has open also releases it (`viewerLeft`).
 * - While a person holds it, the RFB relay passes that person's input (see
 *   `bridge.ts`) and the agent's desktop and browser tools refuse with
 *   `desktop.locked` ("user is in control"): they call `isDesktopLocked` or
 *   `assertUnlocked` before they act.
 * - Every change is a `desktop.lock` event in the session's log, written
 *   before the change takes effect (PRD §10: the record comes before the
 *   action). A lock change whose event cannot be written does not happen.
 */

import {
  type Authorizer,
  type EpochMs,
  type EventStore,
  HearthError,
  type Principal,
  type SessionId,
  type WorkspaceScope,
} from "@hearth/core";
import type { SessionManager } from "../session";

/** How long a lease lasts without input from its holder. */
export const DESKTOP_LOCK_TTL_MS = 60_000;

/** The event type of every lock change. */
export const DESKTOP_LOCK_EVENT = "desktop.lock";

/** What the agent's tools answer while a person holds the lock (PRD §11.2). */
export const USER_IN_CONTROL = "user is in control";

/** Who may hold the lock (PRD §8.3). Only `person` acquires it today. */
export type DesktopLockHolderKind = "person" | "agent" | "automation";

export interface DesktopLockHolder {
  readonly kind: DesktopLockHolderKind;
  readonly principalId: string;
}

/** What `state`, `acquire` and `release` answer. */
export interface DesktopLockView {
  readonly held: boolean;
  /** The caller holds it. */
  readonly mine: boolean;
  readonly holder: DesktopLockHolder | null;
  /** When the lease lapses unless its holder interacts, or null when free. */
  readonly expiresAt: EpochMs | null;
}

/** Why a lock ended, as its event says. */
export type DesktopLockEnd = "released" | "expired" | "viewer-left";

export interface DesktopLocksOptions {
  readonly authorizer: Authorizer;
  readonly sessions: Pick<SessionManager, "get" | "scope">;
  readonly events: Pick<EventStore, "append">;
  readonly ttlMs?: number;
  readonly now?: () => EpochMs;
  readonly log?: (line: string) => void;
}

interface Lease {
  readonly holder: DesktopLockHolder;
  expiresAt: EpochMs;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The read side the runner's tools need (documented in docs/runner.md). */
export interface DesktopLockCheck {
  /** True while someone holds `sessionId`'s desktop lock. */
  isDesktopLocked(sessionId: SessionId): boolean;
  /** Throws `desktop.locked` ("user is in control") while a person holds it. */
  assertUnlocked(sessionId: SessionId): void;
}

export class DesktopLocks implements DesktopLockCheck {
  readonly #options: DesktopLocksOptions;
  readonly #ttl: number;
  readonly #now: () => EpochMs;
  readonly #log: (line: string) => void;
  readonly #leases = new Map<SessionId, Lease>();
  /** Sessions with a lock change in flight; a second change waits its turn. */
  readonly #chains = new Map<SessionId, Promise<unknown>>();

  constructor(options: DesktopLocksOptions) {
    this.#options = options;
    this.#ttl = options.ttlMs ?? DESKTOP_LOCK_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  // -- The check the agent's tools use ----------------------------------------

  isDesktopLocked(sessionId: SessionId): boolean {
    return this.#live(sessionId) !== undefined;
  }

  assertUnlocked(sessionId: SessionId): void {
    const lease = this.#live(sessionId);
    if (lease === undefined) return;
    throw new HearthError(USER_IN_CONTROL, {
      owner: "user",
      disposition: "retry",
      code: "desktop.locked",
    });
  }

  /** The current holder, if any. */
  holder(sessionId: SessionId): DesktopLockHolder | undefined {
    return this.#live(sessionId)?.holder;
  }

  // -- The relay's gate ----------------------------------------------------------

  /**
   * True when `principalId` holds `sessionId`'s lock as a person: the relay
   * then passes that viewer's input. Each true answer renews the lease, so a
   * person keeps control by using the desktop.
   */
  allowsInput(sessionId: SessionId, principalId: string): boolean {
    const lease = this.#live(sessionId);
    if (lease === undefined) return false;
    if (lease.holder.kind !== "person" || lease.holder.principalId !== principalId) return false;
    lease.expiresAt = this.#now() + this.#ttl;
    return true;
  }

  // -- The API -------------------------------------------------------------------

  /** The lock as `principal` sees it (`desktop.view`). */
  async state(principal: Principal, sessionId: SessionId): Promise<DesktopLockView> {
    await this.#authorize(principal, "desktop.view", sessionId);
    await this.#options.sessions.get(principal, sessionId);
    return this.#view(sessionId, principal);
  }

  /**
   * Take over `sessionId`'s desktop as a person (`desktop.control`). Taking a
   * lock one already holds renews it. A lock someone else holds is refused
   * with `desktop.locked`: first come, first served (PRD §8.3).
   */
  async acquire(principal: Principal, sessionId: SessionId): Promise<DesktopLockView> {
    await this.#authorize(principal, "desktop.control", sessionId);
    const session = await this.#options.sessions.get(principal, sessionId);
    if (session.state === "archived" || session.state === "failed") {
      throw new HearthError(`session ${sessionId} is ${session.state}`, {
        owner: "user",
        disposition: "give-up",
        code: "session.unavailable",
      });
    }
    return await this.#serial(sessionId, async () => {
      const lease = this.#live(sessionId);
      if (lease !== undefined) {
        if (lease.holder.kind !== "person" || lease.holder.principalId !== principal.id) {
          throw new HearthError("the desktop is held by someone else", {
            owner: "user",
            disposition: "retry",
            code: "desktop.locked",
          });
        }
        lease.expiresAt = this.#now() + this.#ttl;
        return this.#view(sessionId, principal);
      }
      const holder: DesktopLockHolder = { kind: "person", principalId: principal.id };
      const expiresAt = this.#now() + this.#ttl;
      // The record comes first: an event that cannot be written grants nothing.
      await this.#append(sessionId, { action: "acquired", holder: { ...holder }, expiresAt });
      const next: Lease = { holder, expiresAt, timer: undefined };
      this.#leases.set(sessionId, next);
      this.#arm(sessionId, next);
      this.#log(`desktop: session ${sessionId} lock acquired by ${principal.id}`);
      return this.#view(sessionId, principal);
    });
  }

  /**
   * Hand `sessionId`'s desktop back (`desktop.control`). Releasing a lock one
   * does not hold changes nothing; one held by someone else is refused.
   */
  async release(principal: Principal, sessionId: SessionId): Promise<DesktopLockView> {
    await this.#authorize(principal, "desktop.control", sessionId);
    await this.#options.sessions.get(principal, sessionId);
    return await this.#serial(sessionId, async () => {
      const lease = this.#live(sessionId);
      if (lease === undefined) return this.#view(sessionId, principal);
      if (lease.holder.kind !== "person" || lease.holder.principalId !== principal.id) {
        throw new HearthError("the desktop is held by someone else", {
          owner: "user",
          disposition: "give-up",
          code: "desktop.locked",
        });
      }
      await this.#end(sessionId, lease, "released");
      return this.#view(sessionId, principal);
    });
  }

  /**
   * The holder's last desktop viewer of `sessionId` closed (the tab closed,
   * the box went to sleep): release the lock if `principalId` holds it. Not
   * an API call, so nothing to authorize; the event records it.
   */
  viewerLeft(sessionId: SessionId, principalId: string): Promise<void> {
    return this.#serial(sessionId, async () => {
      const lease = this.#live(sessionId);
      if (lease === undefined || lease.holder.principalId !== principalId) return;
      await this.#end(sessionId, lease, "viewer-left");
    }).catch((error) => {
      this.#log(`desktop: session ${sessionId} lock release failed: ${String(error)}`);
    });
  }

  /** Drop every lease and its timer (hub shutdown). */
  shutdown(): void {
    for (const lease of this.#leases.values()) clearTimeout(lease.timer);
    this.#leases.clear();
  }

  // -- Internals -----------------------------------------------------------------

  /**
   * The lease of `sessionId` if it has not lapsed. A lapsed one is dropped
   * here at once, so no caller ever sees it held past `expiresAt`, even
   * before its timer fires; the timer writes the event.
   */
  #live(sessionId: SessionId): Lease | undefined {
    const lease = this.#leases.get(sessionId);
    if (lease === undefined) return undefined;
    if (this.#now() < lease.expiresAt) return lease;
    this.#expire(sessionId, lease);
    return undefined;
  }

  /** Fires when the lease would lapse; a renewed lease re-arms for the rest. */
  #arm(sessionId: SessionId, lease: Lease): void {
    const wait = Math.max(0, lease.expiresAt - this.#now());
    lease.timer = setTimeout(() => {
      // A lease that ended has its timer cleared; this one is still current.
      if (this.#now() < lease.expiresAt) {
        this.#arm(sessionId, lease);
        return;
      }
      this.#expire(sessionId, lease);
    }, wait);
    lease.timer.unref?.();
  }

  #expire(sessionId: SessionId, lease: Lease): void {
    if (this.#leases.get(sessionId) !== lease) return;
    clearTimeout(lease.timer);
    this.#leases.delete(sessionId);
    this.#log(`desktop: session ${sessionId} lock expired`);
    void this.#append(sessionId, {
      action: "expired",
      holder: { ...lease.holder },
    }).catch((error) => {
      this.#log(`desktop: session ${sessionId} lock expiry not recorded: ${String(error)}`);
    });
  }

  async #end(sessionId: SessionId, lease: Lease, why: DesktopLockEnd): Promise<void> {
    // Recorded first; should the event fail, the lease still lapses on its own.
    await this.#append(sessionId, { action: why, holder: { ...lease.holder } });
    clearTimeout(lease.timer);
    this.#leases.delete(sessionId);
    this.#log(`desktop: session ${sessionId} lock ${why}`);
  }

  #view(sessionId: SessionId, principal: Principal): DesktopLockView {
    const lease = this.#live(sessionId);
    if (lease === undefined) return { held: false, mine: false, holder: null, expiresAt: null };
    return {
      held: true,
      mine: lease.holder.kind === "person" && lease.holder.principalId === principal.id,
      holder: { ...lease.holder },
      expiresAt: lease.expiresAt,
    };
  }

  async #append(
    sessionId: SessionId,
    payload: {
      action: "acquired" | DesktopLockEnd;
      holder: { kind: string; principalId: string };
      expiresAt?: number;
    },
  ): Promise<void> {
    const scope: WorkspaceScope = this.#options.sessions.scope;
    await this.#options.events.append(scope, sessionId, {
      type: DESKTOP_LOCK_EVENT,
      payload: { ...payload },
    });
  }

  /**
   * Authorize against the session's workspace, not the caller's (decision
   * 0022), before anything is read: a caller the policy refuses gets the same
   * answer for an unknown id as for another workspace's session (#90, #94).
   */
  async #authorize(principal: Principal, action: "desktop.view" | "desktop.control", id: string) {
    const decision = await this.#options.authorizer.authorize(principal, action, {
      workspaceId: this.#options.sessions.scope.workspaceId,
      type: "session",
      id,
    });
    if (!decision.allowed) {
      throw new HearthError(`${action} denied: ${decision.reason}`, {
        owner: "user",
        disposition: "give-up",
        code: "authz.denied",
      });
    }
  }

  /** Runs lock changes of one session one at a time. */
  async #serial<T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> {
    const before = this.#chains.get(sessionId) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#chains.set(sessionId, tail);
    try {
      return await run;
    } finally {
      if (this.#chains.get(sessionId) === tail) this.#chains.delete(sessionId);
    }
  }
}
