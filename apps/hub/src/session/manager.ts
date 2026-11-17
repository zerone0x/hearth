/**
 * The hub's session manager (PRD §5, §6.1–§6.3, §8.1; #42, #28;
 * docs/DECISIONS.md, 0013).
 *
 * - The session state machine (`states.ts`), persisted in the `session` table.
 *   Every transition is checked against the table, authorized (and so audited)
 *   with `session.<verb>`, and written to the event log as `session.state`
 *   before the row changes.
 * - Lazy start: nothing starts a box except `ensureBox`, which the runner calls
 *   when a tool call needs the box. It returns a lease; the box is not
 *   hibernated while any lease is held.
 * - Hibernate: after `idleMs` with no lease held, the box is stopped
 *   (`BoxProvider.stop`, the volume stays). The next `ensureBox` wakes it.
 * - All lifecycle work of one session runs one step at a time, so a wake
 *   waits for a hibernate still in flight (PRD §6.3).
 * - Wakes and hibernates are logged in `session_operation` before they act; a
 *   hub restart marks the ones still running interrupted and says so in the
 *   event log (PRD §8.1 principle 7), after stopping any box left running
 *   behind a session that is not idle or running.
 * - A session stays `running` for a short grace after its last tool call, so
 *   the calls of one turn do not each write `idle → running`.
 * - Supervision (#28): a box that exits is classified by its exit code
 *   (`exits.ts`) and either relaunched (bounded, `box.restarted`) or given up
 *   on (`box.failed`, session `failed`). Exits are found by polling
 *   `BoxProvider.attach` while a box boots, on every box disconnect, and on a
 *   periodic sweep.
 */

import { randomUUID } from "node:crypto";
import {
  type Authorizer,
  type BoxId,
  type BoxInfo,
  type BoxSpec,
  DEFAULT_WORKSPACE_ID,
  type EpochMs,
  type EventStore,
  HearthError,
  type JsonValue,
  type Principal,
  type SessionId,
  type StopOutcome,
  SYSTEM_PRINCIPAL,
  type WorkspaceScope,
} from "@hearth/core";
import { bodyOf, type RequestBody } from "../request-body";
import type { SessionRow, SqliteSessionStore } from "../store/sessions";
import { CONNECT_DEADLINE_CLASS, classifyExit, type ExitClass } from "./exits";
import { canTransition, isSessionState, type SessionState, TRANSITION_ACTIONS } from "./states";

/** What the manager needs from the hub to run boxes. `server.ts` wires it. */
export interface SessionBoxes {
  /** Provider name recorded in the `box` table. */
  readonly providerName: string;
  /** Authorize `box.start`, check egress, create, listen, boot with a fresh join token (`hub.startBox`). */
  start(principal: Principal, spec: BoxSpec): Promise<BoxInfo>;
  stop(boxId: BoxId): Promise<StopOutcome>;
  attach(boxId: BoxId): Promise<BoxInfo | undefined>;
  isConnected(boxId: BoxId): boolean;
  /** Resolves once the box connected, rejects at the deadline (`BoxConnections.waitForBox`). */
  waitForBox(boxId: BoxId, deadlineMs: number): Promise<void>;
}

/** Hibernate after this long without a tool call (PRD §6.3: default 15 minutes). */
export const DEFAULT_IDLE_MS = 15 * 60_000;
/**
 * A session stays `running` this long after its last tool call ended, so the
 * back-to-back tool calls of one turn do not each write `running → idle →
 * running` (two audit rows and two `session.state` events per call).
 */
export const DEFAULT_RUNNING_GRACE_MS = 3_000;
/** Named deadline for a started box to connect: container start, desktop start, one dial. */
export const DEFAULT_CONNECT_DEADLINE_MS = 120_000;
/** How often a booting box is inspected for an early exit. */
export const DEFAULT_EXIT_POLL_MS = 1_000;
/** How often every session with a box is checked for an exited box. */
export const DEFAULT_SUPERVISE_INTERVAL_MS = 5_000;
/** Relaunches after a lost credential (exit 3) before giving up. */
export const DEFAULT_MAX_CREDENTIAL_RELAUNCHES = 3;
/** Cold retries after a crash (or a missed connect deadline) before giving up. */
export const DEFAULT_MAX_CRASH_RETRIES = 3;
/** A box that stayed connected this long before exiting starts a fresh count of attempts. */
export const DEFAULT_STABLE_MS = 60_000;

export interface SessionManagerOptions {
  readonly authorizer: Authorizer;
  readonly events: EventStore;
  readonly store: SqliteSessionStore;
  /** Without boxes, `ensureBox` fails with `box.no-provider`; sessions still work. */
  readonly boxes?: SessionBoxes;
  /** Image every session's box runs. */
  readonly image: string;
  readonly idleMs?: number;
  /** How long `running` outlasts the last tool call (`DEFAULT_RUNNING_GRACE_MS`). */
  readonly runningGraceMs?: number;
  readonly connectDeadlineMs?: number;
  readonly exitPollMs?: number;
  /** 0 turns the periodic sweep off (tests drive `supervise` directly). */
  readonly superviseIntervalMs?: number;
  readonly maxCredentialRelaunches?: number;
  readonly maxCrashRetries?: number;
  readonly stableMs?: number;
  readonly now?: () => EpochMs;
  readonly log?: (line: string) => void;
  /**
   * Called after a session is archived (its virtual key is deactivated,
   * decision 0047). A failure is logged; the archive stands.
   */
  readonly onArchived?: (sessionId: SessionId) => Promise<unknown>;
}

export interface CreateSessionInput {
  readonly title?: string;
  readonly model?: string;
  readonly repoUrl?: string;
}

/** The session as the API shows it. */
export interface SessionView {
  readonly id: SessionId;
  readonly title: string;
  readonly state: SessionState;
  readonly model: string | null;
  readonly repoUrl: string | null;
  readonly boxId: BoxId | null;
  readonly lastActivityAt: EpochMs;
  readonly createdAt: EpochMs;
  readonly archivedAt: EpochMs | null;
}

/** A connected box held for one tool call. `release` when the call ended; repeat calls are no-ops. */
export interface BoxLease {
  readonly sessionId: SessionId;
  readonly boxId: BoxId;
  release(): void;
}

/** The box gave up (exit 2, or attempts exhausted): the session goes to `failed`. */
class BoxGaveUp extends Error {
  readonly error: HearthError;
  constructor(error: HearthError) {
    super(error.message);
    this.error = error;
  }
}

class Runtime {
  inFlight = 0;
  /** Queued or running lifecycle steps. */
  pending = 0;
  chain: Promise<unknown> = Promise.resolve();
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Moves a `running` session with no call in flight to `idle` when it fires. */
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  attempts = { credential: 0, crash: 0 };
  connectedAt: EpochMs | undefined;
}

type ConnectOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "exited"; readonly exitCode: number | undefined }
  | { readonly kind: "deadline" };

function newSuffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 20);
}

function asHearthError(error: unknown): HearthError {
  if (error instanceof BoxGaveUp) return error.error;
  if (error instanceof HearthError) return error;
  return new HearthError(String(error), {
    owner: "hub",
    disposition: "retry",
    code: "session.internal",
    cause: error,
  });
}

function view(row: SessionRow): SessionView {
  return {
    id: row.id,
    title: row.title,
    state: isSessionState(row.state) ? row.state : "failed",
    model: row.model,
    repoUrl: row.repoUrl,
    boxId: row.boxId,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

export class SessionManager {
  readonly #authorizer: Authorizer;
  readonly #events: EventStore;
  readonly #store: SqliteSessionStore;
  readonly #boxes: SessionBoxes | undefined;
  readonly #image: string;
  readonly #idleMs: number;
  readonly #graceMs: number;
  readonly #connectDeadlineMs: number;
  readonly #exitPollMs: number;
  readonly #maxCredential: number;
  readonly #maxCrash: number;
  readonly #stableMs: number;
  readonly #now: () => EpochMs;
  readonly #log: (line: string) => void;
  readonly #onArchived: ((sessionId: SessionId) => Promise<unknown>) | undefined;
  readonly #scope: WorkspaceScope = { workspaceId: DEFAULT_WORKSPACE_ID };
  readonly #runtimes = new Map<SessionId, Runtime>();
  readonly #sweep: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  /** Resolves once `recover` ran; every public call waits for it. */
  readonly ready: Promise<void>;

  /**
   * The workspace the sessions live in: the resource workspace of every
   * session action, also for callers outside the manager (the desktop bridge),
   * so `authorize` sees the session's workspace, not the caller's (#61).
   */
  get scope(): WorkspaceScope {
    return this.#scope;
  }

  constructor(options: SessionManagerOptions) {
    this.#authorizer = options.authorizer;
    this.#events = options.events;
    this.#store = options.store;
    this.#boxes = options.boxes;
    this.#image = options.image;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#graceMs = options.runningGraceMs ?? DEFAULT_RUNNING_GRACE_MS;
    this.#connectDeadlineMs = options.connectDeadlineMs ?? DEFAULT_CONNECT_DEADLINE_MS;
    this.#exitPollMs = options.exitPollMs ?? DEFAULT_EXIT_POLL_MS;
    this.#maxCredential = options.maxCredentialRelaunches ?? DEFAULT_MAX_CREDENTIAL_RELAUNCHES;
    this.#maxCrash = options.maxCrashRetries ?? DEFAULT_MAX_CRASH_RETRIES;
    this.#stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#onArchived = options.onArchived;
    this.ready = this.#recover();
    const interval = options.superviseIntervalMs ?? DEFAULT_SUPERVISE_INTERVAL_MS;
    if (interval > 0 && this.#boxes !== undefined) {
      this.#sweep = setInterval(() => void this.supervise(), interval);
      this.#sweep.unref?.();
    }
  }

  // -- API ----------------------------------------------------------------------

  /**
   * Create a session. No box starts (lazy start, PRD §6.2): it goes `creating → idle`.
   * A `RequestBody` input is read after `authorize` (#32).
   */
  async create(
    principal: Principal,
    body: CreateSessionInput | RequestBody<CreateSessionInput> = {},
  ): Promise<SessionView> {
    await this.ready;
    const suffix = newSuffix();
    const id = `se_${suffix}`;
    await this.#authorize(principal, TRANSITION_ACTIONS.creating, id);
    const input = await bodyOf(body);
    const now = this.#now();
    this.#store.insertSession(this.#scope, {
      id,
      title: input.title?.trim() || "New session",
      state: "creating",
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.repoUrl === undefined ? {} : { repoUrl: input.repoUrl }),
      boxId: `bx_${suffix}`,
      now,
    });
    await this.#append(id, "session.state", { from: null, to: "creating", reason: "created" });
    const row = await this.#transition(
      principal,
      this.#mustGet(id),
      "idle",
      "created; the box starts on the first tool call",
    );
    return view(row);
  }

  async list(principal: Principal): Promise<SessionView[]> {
    await this.ready;
    await this.#authorize(principal, "session.list");
    return this.#store.listSessions(this.#scope).map(view);
  }

  async get(principal: Principal, sessionId: SessionId): Promise<SessionView> {
    await this.ready;
    await this.#authorize(principal, "session.read", sessionId);
    return view(this.#mustGet(sessionId));
  }

  /** Archive a session: stop its box (the volume stays), then refuse further tool calls. */
  async archive(principal: Principal, sessionId: SessionId): Promise<SessionView> {
    await this.ready;
    return await this.#serial(sessionId, async () => {
      const s = await this.#load(principal, "session.archive", sessionId);
      const row = await this.#transition(principal, s, "archived", "archived");
      this.#clearIdle(this.#rt(sessionId));
      this.#clearGrace(this.#rt(sessionId));
      const box = s.boxId === null ? undefined : this.#store.getBox(this.#scope, s.boxId);
      if (this.#boxes !== undefined && box !== undefined && box.state !== "stopped") {
        try {
          await this.#boxes.stop(box.id);
          this.#store.setBoxState(this.#scope, box.id, "stopped");
        } catch (error) {
          this.#log(`session ${sessionId}: could not stop box ${box.id}: ${String(error)}`);
        }
      }
      try {
        await this.#onArchived?.(sessionId);
      } catch (error) {
        this.#log(`session ${sessionId}: after the archive: ${String(error)}`);
      }
      return view(row);
    });
  }

  /**
   * Mark the session `failed` through the state machine (authorized, audited,
   * and recorded as a `session.state` event). The runner calls this when its
   * turn fails (#43, decision 0015). A session already `failed` stays as it is;
   * an `archived` one is refused by the transition table. The box is stopped;
   * its volume stays.
   */
  async fail(
    sessionId: SessionId,
    reason: string,
    principal: Principal = SYSTEM_PRINCIPAL,
  ): Promise<SessionView> {
    await this.ready;
    return await this.#serial(sessionId, async () => {
      const s = await this.#load(principal, "session.fail", sessionId);
      if (s.state === "failed") {
        await this.#authorize(principal, "session.fail", sessionId);
        return view(s);
      }
      const row = await this.#transition(principal, s, "failed", reason);
      this.#clearIdle(this.#rt(sessionId));
      this.#clearGrace(this.#rt(sessionId));
      const box = s.boxId === null ? undefined : this.#store.getBox(this.#scope, s.boxId);
      if (this.#boxes !== undefined && box !== undefined && box.state !== "stopped") {
        try {
          await this.#boxes.stop(box.id);
          this.#store.setBoxState(this.#scope, box.id, "stopped");
        } catch (error) {
          this.#log(`session ${sessionId}: could not stop box ${box.id}: ${String(error)}`);
        }
      }
      return view(row);
    });
  }

  /**
   * Make sure the session has a connected box, starting or waking it if needed
   * (lazy start, PRD §6.2), and hold it for one tool call. The runner calls
   * this before every routed tool call and releases the lease when the call
   * ended. While any lease is held the session is `running` and is never
   * hibernated. Rejects with a classified `HearthError` when no box can be had.
   */
  async ensureBox(
    sessionId: SessionId,
    principal: Principal = SYSTEM_PRINCIPAL,
  ): Promise<BoxLease> {
    await this.ready;
    const boxes = this.#requireBoxes();
    const rt = this.#rt(sessionId);
    rt.inFlight++;
    this.#clearIdle(rt);
    let boxId: BoxId;
    try {
      boxId = await this.#serial(sessionId, async () => {
        // Authorize one fixed action before anything depends on the session's
        // existence or state: the action a later transition asks for (run or
        // wake) and the "unavailable" answer would tell an outsider which it is.
        // The hub's own runner (system principal) is not an outsider (#90).
        if (principal !== SYSTEM_PRINCIPAL)
          await this.#authorize(principal, "session.run", sessionId);
        const s = this.#mustGet(sessionId);
        if (s.state === "archived" || s.state === "failed") {
          throw new HearthError(`session ${sessionId} is ${s.state}`, {
            owner: "user",
            disposition: "give-up",
            code: "session.unavailable",
          });
        }
        const id = this.#boxIdOf(s);
        if ((s.state === "idle" || s.state === "running") && boxes.isConnected(id)) {
          if (s.state === "idle") await this.#transition(principal, s, "running", "tool call");
          return id;
        }
        await this.#wake(principal, s, "a tool call needs the box");
        return id;
      });
    } catch (error) {
      this.#release(sessionId);
      throw asHearthError(error);
    }
    let released = false;
    return {
      sessionId,
      boxId,
      release: () => {
        if (released) return;
        released = true;
        this.#release(sessionId);
      },
    };
  }

  /** `ensureBox`, run `fn`, release, whatever `fn` does. */
  async withBox<T>(
    sessionId: SessionId,
    fn: (lease: BoxLease) => Promise<T>,
    principal?: Principal,
  ): Promise<T> {
    const lease = await this.ensureBox(sessionId, principal);
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  /** A box connection closed: look for an exit soon (the container may still be stopping). */
  boxClosed(boxId: BoxId): void {
    if (this.#stopped) return;
    const sessionId = this.#store.getBox(this.#scope, boxId)?.sessionId;
    if (sessionId === null || sessionId === undefined) return;
    const timer = setTimeout(() => void this.supervise(sessionId), this.#exitPollMs);
    timer.unref?.();
  }

  /**
   * Look for exited boxes and handle each exit (relaunch or give up). With an
   * id, checks that session only. Sessions with lifecycle work in progress are
   * skipped: that work watches its own box.
   */
  async supervise(sessionId?: SessionId): Promise<void> {
    await this.ready;
    if (this.#boxes === undefined || this.#stopped) return;
    const sessions =
      sessionId === undefined
        ? this.#store.listSessions(this.#scope, ["idle", "running"])
        : [this.#store.getSession(this.#scope, sessionId)].filter(
            (s): s is SessionRow => s !== undefined,
          );
    for (const s of sessions) {
      if (this.#rt(s.id).pending > 0) continue;
      await this.#serial(s.id, () => this.#check(s.id)).catch((error: unknown) => {
        this.#log(`session ${s.id}: supervision failed: ${String(error)}`);
      });
    }
  }

  /** Stop timers. Work already queued finishes; no new timer fires. */
  stop(): void {
    this.#stopped = true;
    if (this.#sweep !== undefined) clearInterval(this.#sweep);
    for (const rt of this.#runtimes.values()) {
      this.#clearIdle(rt);
      this.#clearGrace(rt);
    }
  }

  // -- lifecycle ------------------------------------------------------------------

  /**
   * After a hub restart no box may be left running behind a session that says
   * it has none (PRD §5: hibernated means the box is stopped). The box of every
   * session caught mid-wake or mid-hibernate, and of every session that is not
   * `idle`/`running` but whose box row says `running`, is stopped first, and
   * the outcome goes into the `interrupted` event. A stop that fails leaves the
   * box row `running` (the next wake stops it again), and is logged and recorded.
   */
  async #recover(): Promise<void> {
    const interrupted = this.#store.runningOperations(this.#scope);
    const withOp = new Set(interrupted.map((op) => op.sessionId));
    const stops = new Map<SessionId, { [key: string]: JsonValue }>();
    for (const s of this.#store.listSessions(this.#scope)) {
      if (s.state === "idle" || s.state === "running" || s.boxId === null) continue;
      const box = this.#store.getBox(this.#scope, s.boxId);
      if (s.state !== "waking" && !withOp.has(s.id) && box?.state !== "running") continue;
      stops.set(s.id, await this.#recoverStop(s.id, s.boxId, box !== undefined));
    }
    for (const op of interrupted) {
      const stop = stops.get(op.sessionId) ?? {};
      this.#store.finishOperation(op.id, "interrupted", this.#now(), {
        reason: "hub restarted",
        ...stop,
      });
      await this.#append(op.sessionId, "session.operation", {
        operation: op.id,
        kind: op.kind,
        outcome: "interrupted",
        reason: "the hub restarted while it was in flight",
        ...stop,
      });
      this.#log(`session ${op.sessionId}: ${op.kind} interrupted by a hub restart`);
    }
    for (const [sessionId, stop] of stops) {
      if (withOp.has(sessionId)) continue;
      await this.#append(sessionId, "session.operation", {
        kind: "recover",
        outcome: "done",
        reason: "the hub restarted with this session's box still running",
        ...stop,
      });
    }
    for (const s of this.#store.listSessions(this.#scope)) {
      if (s.state === "waking") {
        await this.#transition(
          SYSTEM_PRINCIPAL,
          s,
          "hibernated",
          "the hub restarted during a wake",
        );
      } else if (s.state === "creating" || s.state === "running") {
        await this.#transition(SYSTEM_PRINCIPAL, s, "idle", "the hub restarted");
      }
    }
    for (const s of this.#store.listSessions(this.#scope, ["idle"])) this.#scheduleIdle(s.id);
  }

  /** Stop one box during recovery; say what happened, never throw. */
  async #recoverStop(
    sessionId: SessionId,
    boxId: BoxId,
    hasRow: boolean,
  ): Promise<{ [key: string]: JsonValue }> {
    if (this.#boxes === undefined) {
      this.#log(`session ${sessionId}: cannot stop box ${boxId} after a restart: no provider`);
      return { stop: "failed", code: "box.no-provider" };
    }
    try {
      const outcome = await this.#boxes.stop(boxId);
      if (hasRow) this.#store.setBoxState(this.#scope, boxId, "stopped");
      return { stop: outcome };
    } catch (error) {
      const e = asHearthError(error);
      this.#log(`session ${sessionId}: could not stop box ${boxId} after a restart: ${e.message}`);
      return { stop: "failed", code: e.code, message: e.message };
    }
  }

  #release(sessionId: SessionId): void {
    const rt = this.#rt(sessionId);
    rt.inFlight = Math.max(0, rt.inFlight - 1);
    if (rt.inFlight > 0 || this.#stopped) return;
    // Stay `running` for the grace period: the next tool call of the turn
    // usually comes before it ends (DEFAULT_RUNNING_GRACE_MS). Each release
    // restarts it; a timer that fires during a call finds it in flight.
    this.#clearGrace(rt);
    rt.graceTimer = setTimeout(() => {
      rt.graceTimer = undefined;
      if (this.#stopped) return;
      void this.#serial(sessionId, async () => {
        if (rt.inFlight > 0) return;
        const s = this.#mustGet(sessionId);
        if (s.state === "running") {
          await this.#transition(SYSTEM_PRINCIPAL, s, "idle", "no tool call in flight");
        }
        // The grace period counts toward the idle time.
        this.#scheduleIdle(sessionId, Math.max(0, this.#idleMs - this.#graceMs));
      }).catch((error: unknown) => {
        this.#log(`session ${sessionId}: could not go idle: ${String(error)}`);
      });
    }, this.#graceMs);
    rt.graceTimer.unref?.();
  }

  #clearGrace(rt: Runtime): void {
    if (rt.graceTimer !== undefined) clearTimeout(rt.graceTimer);
    rt.graceTimer = undefined;
  }

  /** Arm the hibernate timer of an idle session whose box was started. */
  #scheduleIdle(sessionId: SessionId, delayMs: number = this.#idleMs): void {
    const rt = this.#rt(sessionId);
    this.#clearIdle(rt);
    if (this.#stopped || this.#boxes === undefined || rt.inFlight > 0) return;
    const s = this.#store.getSession(this.#scope, sessionId);
    if (s?.state !== "idle" || s.boxId === null) return;
    const box = this.#store.getBox(this.#scope, s.boxId);
    if (box === undefined || box.state === "stopped") return;
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = undefined;
      if (this.#stopped) return;
      void this.#serial(sessionId, async () => {
        const current = this.#mustGet(sessionId);
        // Only stop the box when no tool call is in flight (PRD §6.3).
        if (rt.inFlight > 0) {
          this.#log(`session ${sessionId}: hibernate skipped, a tool call is in flight`);
          return;
        }
        if (current.state !== "idle") return;
        await this.#hibernate(current);
      }).catch((error: unknown) => {
        this.#log(`session ${sessionId}: hibernate failed: ${String(error)}`);
      });
    }, delayMs);
    rt.idleTimer.unref?.();
  }

  #clearIdle(rt: Runtime): void {
    if (rt.idleTimer !== undefined) clearTimeout(rt.idleTimer);
    rt.idleTimer = undefined;
  }

  /** Hibernate means "stop the box" (PRD §6.3, decision 0009). Logged before it acts. */
  async #hibernate(s: SessionRow): Promise<void> {
    const boxes = this.#requireBoxes();
    const boxId = this.#boxIdOf(s);
    await this.#transition(SYSTEM_PRINCIPAL, s, "hibernated", `idle for ${this.#idleMs} ms`);
    const op = this.#store.beginOperation(this.#scope, s.id, "hibernate", this.#now());
    try {
      const outcome = await boxes.stop(boxId);
      this.#store.setBoxState(this.#scope, boxId, "stopped");
      this.#store.finishOperation(op, "done", this.#now(), { stop: outcome });
      const rt = this.#rt(s.id);
      rt.attempts = { credential: 0, crash: 0 };
      rt.connectedAt = undefined;
      await this.#append(s.id, "session.operation", {
        operation: op,
        kind: "hibernate",
        outcome: "done",
        stop: outcome,
      });
    } catch (error) {
      const e = asHearthError(error);
      this.#store.finishOperation(op, "failed", this.#now(), { code: e.code });
      await this.#append(s.id, "session.operation", {
        operation: op,
        kind: "hibernate",
        outcome: "failed",
        code: e.code,
        message: e.message,
      });
      throw e;
    }
  }

  /**
   * Start (or restart) the session's box and wait for it to connect, through
   * `waking`. Ends in `running`/`idle`, or in `failed` when the box gave up,
   * or back in `hibernated` when the box could not be started at all.
   */
  async #wake(principal: Principal, s: SessionRow, reason: string): Promise<void> {
    const waking = await this.#transition(principal, s, "waking", reason);
    const op = this.#store.beginOperation(this.#scope, s.id, "wake", this.#now());
    try {
      await this.#bootUntilConnected(principal, waking);
    } catch (error) {
      const e = asHearthError(error);
      this.#store.finishOperation(op, "failed", this.#now(), { code: e.code });
      await this.#append(s.id, "session.operation", {
        operation: op,
        kind: "wake",
        outcome: "failed",
        code: e.code,
      });
      const to: SessionState = error instanceof BoxGaveUp ? "failed" : "hibernated";
      await this.#transition(SYSTEM_PRINCIPAL, waking, to, e.message);
      throw e;
    }
    this.#store.finishOperation(op, "done", this.#now());
    await this.#append(s.id, "session.operation", {
      operation: op,
      kind: "wake",
      outcome: "done",
      // The trajectory's box records name the box (decision 0021).
      ...(s.boxId === null ? {} : { boxId: s.boxId }),
    });
    const rt = this.#rt(s.id);
    rt.connectedAt = this.#now();
    await this.#transition(
      principal,
      waking,
      rt.inFlight > 0 ? "running" : "idle",
      "the box connected",
    );
    if (rt.inFlight === 0) this.#scheduleIdle(s.id);
  }

  async #bootUntilConnected(principal: Principal, s: SessionRow): Promise<void> {
    const boxes = this.#requireBoxes();
    const boxId = this.#boxIdOf(s);
    const spec: BoxSpec = {
      boxId,
      workspaceId: s.workspaceId,
      sessionId: s.id,
      image: this.#image,
    };
    for (;;) {
      // A fresh runtime every time, so the new join token takes effect
      // (`BoxProvider.start` leaves a running box alone).
      let info: BoxInfo;
      try {
        await boxes.stop(boxId);
        info = await boxes.start(principal, spec);
      } catch (error) {
        const e = asHearthError(error);
        await this.#append(s.id, "box.failed", {
          cause: "start",
          code: e.code,
          owner: e.owner,
          disposition: e.disposition,
          message: e.message,
        });
        throw e;
      }
      this.#store.upsertBox(this.#scope, {
        id: boxId,
        sessionId: s.id,
        provider: boxes.providerName,
        state: "running",
        image: this.#image,
        ...(info.providerRef === undefined ? {} : { providerRef: info.providerRef }),
        volumeRef: info.volumeRef,
        now: this.#now(),
      });
      const outcome = await this.#connectOrExit(boxId);
      if (outcome.kind === "connected") return;
      this.#store.setBoxState(this.#scope, boxId, "exited");
      const exitCode = outcome.kind === "exited" ? outcome.exitCode : undefined;
      const cls = outcome.kind === "exited" ? classifyExit(exitCode) : CONNECT_DEADLINE_CLASS;
      await this.#afterExit(s, cls, exitCode);
    }
  }

  #connectOrExit(boxId: BoxId): Promise<ConnectOutcome> {
    const boxes = this.#requireBoxes();
    return new Promise((resolve) => {
      let done = false;
      let polling = false;
      const finish = (outcome: ConnectOutcome) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        resolve(outcome);
      };
      boxes.waitForBox(boxId, this.#connectDeadlineMs).then(
        () => finish({ kind: "connected" }),
        () => finish({ kind: "deadline" }),
      );
      const poll = setInterval(() => {
        if (polling || done) return;
        polling = true;
        boxes.attach(boxId).then(
          (info) => {
            polling = false;
            if (info?.state === "exited") finish({ kind: "exited", exitCode: info.exitCode });
          },
          () => {
            polling = false;
          },
        );
      }, this.#exitPollMs);
    });
  }

  /**
   * Count an exit against its bound and say so in the event log: `box.restarted`
   * when another attempt follows, or `box.failed` and a `BoxGaveUp` when not.
   */
  async #afterExit(s: SessionRow, cls: ExitClass, exitCode: number | undefined): Promise<void> {
    const rt = this.#rt(s.id);
    if (rt.connectedAt !== undefined && this.#now() - rt.connectedAt >= this.#stableMs) {
      rt.attempts = { credential: 0, crash: 0 };
    }
    rt.connectedAt = undefined;
    const counter = cls.cause === "credential-lost" ? "credential" : "crash";
    const max = counter === "credential" ? this.#maxCredential : this.#maxCrash;
    const exit = exitCode === undefined ? {} : { exitCode };
    if (cls.disposition === "give-up" || rt.attempts[counter] >= max) {
      const message =
        cls.disposition === "give-up"
          ? `box failed: its configuration is invalid (exit ${String(exitCode)})`
          : `box failed: ${cls.cause}, gave up after ${max} relaunches`;
      await this.#append(s.id, "box.failed", {
        cause: cls.cause,
        code: cls.code,
        owner: "box",
        disposition: "give-up",
        ...exit,
        ...(s.boxId === null ? {} : { boxId: s.boxId }),
        message,
      });
      throw new BoxGaveUp(
        new HearthError(message, { owner: "box", disposition: "give-up", code: cls.code }),
      );
    }
    rt.attempts[counter]++;
    await this.#append(s.id, "box.restarted", {
      cause: cls.cause,
      code: cls.code,
      disposition: cls.disposition,
      ...exit,
      attempt: rt.attempts[counter],
      maxAttempts: max,
      ...(s.boxId === null ? {} : { boxId: s.boxId }),
      message: `box restarted after ${cls.cause} (attempt ${rt.attempts[counter]} of ${max})`,
    });
  }

  /** Supervision of one session (run inside its lifecycle chain). */
  async #check(sessionId: SessionId): Promise<void> {
    const boxes = this.#requireBoxes();
    const s = this.#mustGet(sessionId);
    if ((s.state !== "idle" && s.state !== "running") || s.boxId === null) return;
    const box = this.#store.getBox(this.#scope, s.boxId);
    if (box === undefined || box.state !== "running") return;
    const info = await boxes.attach(s.boxId);
    if (info?.state !== "exited") return;
    this.#store.setBoxState(this.#scope, s.boxId, "exited");
    this.#clearIdle(this.#rt(sessionId));
    const cls = classifyExit(info.exitCode);
    try {
      await this.#afterExit(s, cls, info.exitCode);
    } catch (error) {
      if (!(error instanceof BoxGaveUp)) throw error;
      await this.#transition(SYSTEM_PRINCIPAL, s, "failed", error.message);
      return;
    }
    try {
      await this.#wake(SYSTEM_PRINCIPAL, s, `the box exited (${cls.cause})`);
    } catch (error) {
      this.#log(`session ${sessionId}: relaunch failed: ${String(error)}`);
    }
  }

  // -- helpers ----------------------------------------------------------------------

  #rt(sessionId: SessionId): Runtime {
    let rt = this.#runtimes.get(sessionId);
    if (rt === undefined) {
      rt = new Runtime();
      this.#runtimes.set(sessionId, rt);
    }
    return rt;
  }

  /** Run `fn` after every lifecycle step of the session queued before it. */
  #serial<T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> {
    const rt = this.#rt(sessionId);
    rt.pending++;
    const run = rt.chain.then(fn).finally(() => {
      rt.pending--;
    });
    rt.chain = run.catch(() => undefined);
    return run;
  }

  async #transition(
    principal: Principal,
    s: SessionRow,
    to: SessionState,
    reason: string,
  ): Promise<SessionRow> {
    const from = s.state;
    // Authorize first: a refusal must not reveal the session's state (#90).
    await this.#authorize(principal, TRANSITION_ACTIONS[to], s.id);
    if (!isSessionState(from) || !canTransition(from, to)) {
      throw new HearthError(`session ${s.id} cannot go from ${from} to ${to}`, {
        owner: "hub",
        disposition: "give-up",
        code: "session.illegal-transition",
      });
    }
    await this.#append(s.id, "session.state", { from, to, reason });
    const now = this.#now();
    this.#store.setSessionState(this.#scope, s.id, to, now);
    return {
      ...s,
      state: to,
      lastActivityAt: now,
      archivedAt: to === "archived" ? now : s.archivedAt,
    };
  }

  async #authorize(
    principal: Principal,
    action: `${string}.${string}`,
    sessionId?: SessionId,
  ): Promise<void> {
    const decision = await this.#authorizer.authorize(principal, action, {
      workspaceId: this.#scope.workspaceId,
      type: "session",
      ...(sessionId === undefined ? {} : { id: sessionId }),
    });
    if (!decision.allowed) {
      throw new HearthError(`${action} denied: ${decision.reason}`, {
        owner: "user",
        disposition: "give-up",
        code: "authz.denied",
      });
    }
  }

  async #append(sessionId: SessionId, type: string, payload: JsonValue): Promise<void> {
    await this.#events.append(this.#scope, sessionId, { type, payload });
  }

  /**
   * Look a session up for a caller. An unknown id is authorized before it is
   * reported missing, so a principal the policy refuses gets the same
   * `authz.denied` (and audit row) for an unknown id as for another
   * workspace's id, and learns nothing about which ids exist (#90).
   */
  async #load(
    principal: Principal,
    action: `${string}.${string}`,
    sessionId: SessionId,
  ): Promise<SessionRow> {
    if (this.#store.getSession(this.#scope, sessionId) === undefined) {
      await this.#authorize(principal, action, sessionId);
    }
    return this.#mustGet(sessionId);
  }

  #mustGet(sessionId: SessionId): SessionRow {
    const s = this.#store.getSession(this.#scope, sessionId);
    if (s === undefined) {
      throw new HearthError(`no session ${sessionId}`, {
        owner: "user",
        disposition: "give-up",
        code: "session.not-found",
      });
    }
    return s;
  }

  #boxIdOf(s: SessionRow): BoxId {
    if (s.boxId === null) {
      throw new HearthError(`session ${s.id} has no box id`, {
        owner: "hub",
        disposition: "give-up",
        code: "session.no-box",
      });
    }
    return s.boxId;
  }

  #requireBoxes(): SessionBoxes {
    if (this.#boxes === undefined) {
      throw new HearthError("no box provider is configured", {
        owner: "hub",
        disposition: "give-up",
        code: "box.no-provider",
      });
    }
    return this.#boxes;
  }
}
