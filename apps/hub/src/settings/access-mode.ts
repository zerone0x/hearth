/**
 * The access mode (decision 0045; PRD §6.5; decisions 0042, 0043): `yolo`
 * runs every tool without asking, `ask` stops risky actions for the owner.
 * This module holds the setting only; the gate that acts on it is built in
 * the runner (0043).
 *
 * - **Global default.** The `access_mode` setting next to `model` (0038),
 *   `{mode}`. Unset, it is `ask`: on a new install and on an existing one
 *   (the safer of the two), so no install starts in `yolo` unasked.
 * - **Per-session override.** `session.access_mode`, null to follow the
 *   global default.
 * - **One resolver.** `resolve(sessionId)` is read once per tool call (the
 *   runner's `hearth-access` extension, and the gate of #155), so a change
 *   applies to the next call, also mid-turn.
 * - **Audited and logged.** Each change authorizes first (the body is read
 *   after), writes an audit row before anything else, then a
 *   `session.access_mode` event to every session whose mode it changes (the
 *   one session, or all that follow the global default), then the row.
 */

import {
  type AuditRecord,
  type AuditSink,
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  type EpochMs,
  type EventStore,
  HearthError,
  type JsonValue,
  type Principal,
  type SessionId,
  type WorkspaceScope,
  withAudit,
} from "@hearth/core";
import { bodyOf, type RequestBody } from "../request-body";
import type { SqliteSessionStore, SqliteSettingStore } from "../store";

export type AccessMode = "yolo" | "ask";

export const ACCESS_MODES: readonly AccessMode[] = ["yolo", "ask"];

/** The mode when nothing is saved: a new install, and an install from before the setting. */
export const DEFAULT_ACCESS_MODE: AccessMode = "ask";

/** The setting key of the global default, next to `model` (decision 0038). */
export const ACCESS_MODE_KEY = "access_mode";

export function isAccessMode(value: unknown): value is AccessMode {
  return value === "yolo" || value === "ask";
}

/** What `GET /v1/settings/access-mode` answers. */
export interface GlobalAccessModeView {
  readonly mode: AccessMode;
  /** `default`: nothing saved, the mode is `DEFAULT_ACCESS_MODE`; `settings`: saved here. */
  readonly source: "default" | "settings";
  readonly updatedAt: EpochMs | null;
}

/** What `GET /v1/sessions/:id/access-mode` answers. */
export interface SessionAccessModeView {
  readonly sessionId: SessionId;
  /** The session's own choice; null follows the global default. */
  readonly override: AccessMode | null;
  readonly global: AccessMode;
  /** The mode in force: `override ?? global`. */
  readonly mode: AccessMode;
}

export interface AccessModesOptions {
  readonly settings: SqliteSettingStore;
  readonly sessions: SqliteSessionStore;
  readonly events: EventStore;
  readonly authorizer: Authorizer;
  readonly audit: AuditSink;
  readonly log?: (line: string) => void;
  readonly now?: () => EpochMs;
}

function fail(code: string, message: string): HearthError {
  return new HearthError(message, { owner: "user", disposition: "give-up", code });
}

function invalid(message: string): HearthError {
  return fail("request.invalid", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `{mode}` with nothing else; `nullable` lets `mode` be null (a session following the default). */
function parseBody(input: unknown, nullable: boolean): AccessMode | null {
  const expected = nullable ? '{mode: "yolo" | "ask" | null}' : '{mode: "yolo" | "ask"}';
  if (!isRecord(input)) throw invalid(`expected ${expected}`);
  for (const key of Object.keys(input)) {
    if (key !== "mode") throw invalid(`unknown field ${JSON.stringify(key)}`);
  }
  const { mode } = input;
  if (isAccessMode(mode)) return mode;
  if (nullable && mode === null) return null;
  throw invalid(`mode must be ${nullable ? '"yolo", "ask" or null' : '"yolo" or "ask"'}`);
}

/** A stored override; anything else (a hand-edited row) is read as no override. */
function overrideOf(value: string | null | undefined): AccessMode | null {
  return isAccessMode(value) ? value : null;
}

export class AccessModes {
  readonly #o: AccessModesOptions;
  readonly #scope: WorkspaceScope = { workspaceId: DEFAULT_WORKSPACE_ID };
  readonly #now: () => EpochMs;
  /** Serializes changes: two saves never interleave their audit, events and rows. */
  #lock: Promise<unknown> = Promise.resolve();

  constructor(options: AccessModesOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The mode in force for `sessionId` now: its override, else the global
   * default. Read once per tool call; never cached, so a change applies to
   * the next call. An unknown session follows the global default.
   */
  resolve(sessionId: SessionId): AccessMode {
    const row = this.#o.sessions.getSession(this.#scope, sessionId);
    return overrideOf(row?.accessMode) ?? this.#global().mode;
  }

  async getGlobal(principal: Principal): Promise<GlobalAccessModeView> {
    await this.#authorize(principal, "settings.read", { type: "setting", id: ACCESS_MODE_KEY });
    return this.#global();
  }

  /** Save the global default `{mode}`. Sessions that follow it get a `session.access_mode` event. */
  async putGlobal(
    principal: Principal,
    body: unknown | RequestBody<unknown>,
  ): Promise<GlobalAccessModeView> {
    await this.#authorize(principal, "settings.access_mode.update", {
      type: "setting",
      id: ACCESS_MODE_KEY,
    });
    // Read only now, after `authorize` (#32).
    const mode = parseBody(await bodyOf(body), false) as AccessMode;
    await this.#serial(async () => {
      const previous = this.#global();
      const followers = this.#o.sessions
        .listSessions(this.#scope)
        .filter((s) => s.state !== "archived" && overrideOf(s.accessMode) === null);
      const record = this.#record(
        principal,
        "settings.access_mode.update",
        { type: "setting", id: ACCESS_MODE_KEY },
        {
          mode,
          previous: previous.mode,
          previous_source: previous.source,
          sessions_following: followers.length,
        },
      );
      await withAudit(this.#o.audit, record, async () => {
        for (const s of followers) {
          await this.#event(principal, s.id, {
            mode,
            previous: previous.mode,
            override: null,
            global: mode,
            changed: "global",
          });
        }
        this.#o.settings.put(
          this.#scope.workspaceId,
          ACCESS_MODE_KEY,
          JSON.stringify({ mode }),
          this.#now(),
        );
      });
      this.#log(
        `access: global default set to ${mode} (was ${previous.mode}); ${followers.length} session(s) follow it from their next tool call`,
      );
    });
    return this.#global();
  }

  async getSession(principal: Principal, sessionId: SessionId): Promise<SessionAccessModeView> {
    await this.#authorize(principal, "session.read", { type: "session", id: sessionId });
    return this.#sessionView(sessionId);
  }

  /** Set the session's override `{mode}`; null follows the global default again. */
  async putSession(
    principal: Principal,
    sessionId: SessionId,
    body: unknown | RequestBody<unknown>,
  ): Promise<SessionAccessModeView> {
    await this.#authorize(principal, "session.access_mode.update", {
      type: "session",
      id: sessionId,
    });
    this.#mustGet(sessionId);
    // Read only now, after `authorize` and the existence check (#32).
    const override = parseBody(await bodyOf(body), true);
    await this.#serial(async () => {
      const before = this.#sessionView(sessionId);
      const global = this.#global().mode;
      const mode = override ?? global;
      const record = this.#record(
        principal,
        "session.access_mode.update",
        { type: "session", id: sessionId },
        { override, mode, previous_override: before.override, previous: before.mode },
      );
      await withAudit(this.#o.audit, record, async () => {
        await this.#event(principal, sessionId, {
          mode,
          previous: before.mode,
          override,
          global,
          changed: "session",
        });
        this.#o.sessions.setAccessMode(this.#scope, sessionId, override);
      });
      this.#log(
        `access: session ${sessionId} set to ${override ?? `follow the global default (${global})`}; its next tool call runs in ${mode}`,
      );
    });
    return this.#sessionView(sessionId);
  }

  #sessionView(sessionId: SessionId): SessionAccessModeView {
    const override = overrideOf(this.#mustGet(sessionId).accessMode);
    const global = this.#global().mode;
    return { sessionId, override, global, mode: override ?? global };
  }

  #mustGet(sessionId: SessionId) {
    const row = this.#o.sessions.getSession(this.#scope, sessionId);
    if (row === undefined) throw fail("session.not-found", `no session ${sessionId}`);
    return row;
  }

  #global(): GlobalAccessModeView {
    const row = this.#o.settings.get(this.#scope.workspaceId, ACCESS_MODE_KEY);
    if (row === undefined) return { mode: DEFAULT_ACCESS_MODE, source: "default", updatedAt: null };
    let mode: unknown;
    try {
      mode = (JSON.parse(row.valueJson) as { mode?: unknown } | null)?.mode;
    } catch {
      mode = undefined;
    }
    // A row this code cannot read is the safer mode, not `yolo`.
    return {
      mode: isAccessMode(mode) ? mode : DEFAULT_ACCESS_MODE,
      source: "settings",
      updatedAt: row.updatedAt,
    };
  }

  async #event(principal: Principal, sessionId: SessionId, payload: Record<string, JsonValue>) {
    await this.#o.events.append(this.#scope, sessionId, {
      type: "session.access_mode",
      payload: { ...payload, by: { kind: principal.kind, id: principal.id } },
    });
  }

  #record(
    principal: Principal,
    action: string,
    resource: { type: string; id: string },
    detail: JsonValue,
  ): AuditRecord {
    return {
      workspaceId: principal.workspaceId,
      principalId: principal.id,
      principalKind: principal.kind,
      action,
      resource: { workspaceId: this.#scope.workspaceId, ...resource },
      at: this.#now(),
      detail,
    };
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(work, work);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  async #authorize(
    principal: Principal,
    action: `${string}.${string}`,
    resource: { type: string; id: string },
  ): Promise<void> {
    const decision = await this.#o.authorizer.authorize(principal, action, {
      workspaceId: this.#scope.workspaceId,
      ...resource,
    });
    if (!decision.allowed) throw fail("authz.denied", `${action} denied: ${decision.reason}`);
  }

  #log(line: string): void {
    (this.#o.log ?? console.error)(line);
  }
}
