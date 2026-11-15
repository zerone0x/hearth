/**
 * What the login needs from storage. `SqliteLoginStore` in `../store`
 * implements it; only that class touches SQLite (AGENTS.md, boundary rules).
 */

import type { EpochMs, PrincipalId, WorkspaceId } from "@hearth/core";

/** A login session as stored: only the SHA-256 of its id is kept. */
export interface LoginSessionRecord {
  readonly idHash: string;
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
}

export interface LoginStore {
  /** The stored password hash of `principalId`, or undefined before setup. */
  passwordHash(principalId: PrincipalId): string | undefined;
  /**
   * Store the first password of `principalId`. Returns false, and changes
   * nothing, when one is already set: setup happens once.
   */
  setInitialPassword(
    workspaceId: WorkspaceId,
    principalId: PrincipalId,
    hash: string,
    at: EpochMs,
  ): boolean;
  createSession(session: LoginSessionRecord): void;
  findSession(idHash: string): LoginSessionRecord | undefined;
  deleteSession(idHash: string): void;
  /** Remove every session that expired at or before `now`. Returns how many. */
  deleteExpiredSessions(now: EpochMs): number;
}
