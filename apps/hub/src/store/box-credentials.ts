/**
 * The SQLite implementation of `BoxCredentialStore` (#7): join tokens and
 * per-box credentials, stored as SHA-256 hashes only.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type BoxId,
  type EpochMs,
  HearthError,
  type SessionId,
  type WorkspaceScope,
} from "@hearth/core";
import {
  BOX_CREDENTIAL_PREFIX,
  type BoxBinding,
  type BoxCredentialStore,
  type IssuedJoinToken,
  JOIN_TOKEN_PREFIX,
  JOIN_TOKEN_TTL_MS,
  type RedeemOutcome,
} from "../box/credentials";

/** Random bytes in a token or credential: 256 bits, so a plain SHA-256 is a safe hash. */
const SECRET_BYTES = 32;

function mint(prefix: string): string {
  return prefix + randomBytes(SECRET_BYTES).toString("base64url");
}

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

interface TokenRow {
  workspace_id: string;
  box_id: string;
  session_id: string;
  expires_at: number;
  used_at: number | null;
}

interface CredentialRow {
  workspace_id: string;
  session_id: string;
  credential_hash: string;
}

export interface SqliteBoxCredentialStoreOptions {
  readonly now?: () => EpochMs;
}

export class SqliteBoxCredentialStore implements BoxCredentialStore {
  readonly #db: Database;
  readonly #now: () => EpochMs;
  readonly #redeem: (boxId: BoxId, tokenHash: string, credentialHash: string) => RedeemOutcome;

  constructor(db: Database, options: SqliteBoxCredentialStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    const findToken = db.query<TokenRow, [string]>(
      "SELECT workspace_id, box_id, session_id, expires_at, used_at FROM box_join_token WHERE token_hash = ?",
    );
    const markUsed = db.query<never, [number, string]>(
      "UPDATE box_join_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
    );
    const saveCredential = db.query<never, [string, string, string, string, number]>(
      `INSERT INTO box_credential (box_id, workspace_id, session_id, credential_hash, issued_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (box_id) DO UPDATE SET workspace_id = excluded.workspace_id,
         session_id = excluded.session_id, credential_hash = excluded.credential_hash,
         issued_at = excluded.issued_at`,
    );
    const redeem = db.transaction(
      (boxId: BoxId, tokenHash: string, credentialHash: string): RedeemOutcome => {
        const row = findToken.get(tokenHash);
        if (row === null) return { kind: "rejected", reason: "unknown" };
        if (row.box_id !== boxId) return { kind: "rejected", reason: "wrong-box" };
        if (row.used_at !== null) return { kind: "rejected", reason: "used" };
        const now = this.#now();
        if (now >= row.expires_at) return { kind: "rejected", reason: "expired" };
        markUsed.run(now, tokenHash);
        saveCredential.run(boxId, row.workspace_id, row.session_id, credentialHash, now);
        return {
          kind: "issued",
          binding: { workspaceId: row.workspace_id, boxId, sessionId: row.session_id },
          credential: "",
        };
      },
    );
    this.#redeem = (boxId, tokenHash, credentialHash) =>
      redeem.immediate(boxId, tokenHash, credentialHash);
  }

  async issueJoinToken(
    scope: WorkspaceScope,
    boxId: BoxId,
    sessionId: SessionId,
    ttlMs: number = JOIN_TOKEN_TTL_MS,
  ): Promise<IssuedJoinToken> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new HearthError(`Join token TTL ${String(ttlMs)} is not a positive integer`, {
        owner: "hub",
        disposition: "give-up",
        code: "box.invalid-ttl",
      });
    }
    const token = mint(JOIN_TOKEN_PREFIX);
    const now = this.#now();
    const expiresAt = now + ttlMs;
    try {
      this.#db.run(
        `INSERT INTO box_join_token (token_hash, workspace_id, box_id, session_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [hash(token), scope.workspaceId, boxId, sessionId, now, expiresAt],
      );
    } catch (cause) {
      throw new HearthError(`Could not issue a join token for box ${boxId}`, {
        owner: "hub",
        disposition: "retry",
        code: "box.token-write-failed",
        cause,
      });
    }
    return { token, expiresAt };
  }

  async redeemJoinToken(boxId: BoxId, token: string): Promise<RedeemOutcome> {
    if (!token.startsWith(JOIN_TOKEN_PREFIX)) return { kind: "rejected", reason: "unknown" };
    const credential = mint(BOX_CREDENTIAL_PREFIX);
    const outcome = this.#redeem(boxId, hash(token), hash(credential));
    return outcome.kind === "issued" ? { ...outcome, credential } : outcome;
  }

  async verifyCredential(boxId: BoxId, credential: string): Promise<BoxBinding | undefined> {
    if (!credential.startsWith(BOX_CREDENTIAL_PREFIX)) return undefined;
    const row = this.#db
      .query<CredentialRow, [string]>(
        "SELECT workspace_id, session_id, credential_hash FROM box_credential WHERE box_id = ?",
      )
      .get(boxId);
    if (row === null) return undefined;
    const expected = Buffer.from(row.credential_hash, "hex");
    const actual = Buffer.from(hash(credential), "hex");
    if (!timingSafeEqual(expected, actual)) return undefined;
    return { workspaceId: row.workspace_id, boxId, sessionId: row.session_id };
  }
}
