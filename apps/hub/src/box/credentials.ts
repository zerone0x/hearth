/**
 * Box authentication (PRD §8.2): a box starts with a one-time join token and
 * exchanges it in `hello` for a per-box credential it uses on every later
 * connect. The connection handler depends on this interface only; the SQLite
 * implementation lives in `../store` (AGENTS.md, boundary rules).
 */

import type { BoxId, EpochMs, SessionId, WorkspaceId, WorkspaceScope } from "@hearth/core";

/**
 * How long a join token stays valid after it is issued. The token is minted
 * right before the box's runtime starts and is redeemed by its first `hello`,
 * so it only has to cover a container start and one dial.
 */
export const JOIN_TOKEN_TTL_MS = 5 * 60_000;

/** Prefix of a raw join token. Lets the hub tell a token from a credential in `hello`. */
export const JOIN_TOKEN_PREFIX = "hjt_";
/** Prefix of a raw per-box credential. */
export const BOX_CREDENTIAL_PREFIX = "hbc_";

/** What a token or credential authenticates: one box, bound to one session in one workspace. */
export interface BoxBinding {
  readonly workspaceId: WorkspaceId;
  readonly boxId: BoxId;
  readonly sessionId: SessionId;
}

export interface IssuedJoinToken {
  /** The raw token. Hand it to the box once (boot environment); it is never stored. */
  readonly token: string;
  readonly expiresAt: EpochMs;
}

/**
 * The explicit answer of a redeem (PRD §8.1 principle 6). A rejection never
 * says more to the box than "bad credential"; the reason is for the hub's log.
 */
export type RedeemOutcome =
  | { readonly kind: "issued"; readonly binding: BoxBinding; readonly credential: string }
  | {
      readonly kind: "rejected";
      readonly reason: "unknown" | "used" | "expired" | "wrong-box";
    };

/**
 * Issues and checks box join tokens and per-box credentials.
 *
 * Guarantees:
 * - Only hashes are stored; raw tokens and credentials are returned once.
 * - A join token is single-use and expires `JOIN_TOKEN_TTL_MS` (or the given
 *   TTL) after it was issued. Redeeming is atomic: of two concurrent redeems of
 *   one token, exactly one gets `issued`.
 * - Redeeming issues a fresh credential for the box and revokes the previous
 *   one, so only the latest boot of a box can connect.
 */
export interface BoxCredentialStore {
  issueJoinToken(
    scope: WorkspaceScope,
    boxId: BoxId,
    sessionId: SessionId,
    ttlMs?: number,
  ): Promise<IssuedJoinToken>;
  redeemJoinToken(boxId: BoxId, token: string): Promise<RedeemOutcome>;
  /** The box's binding when `credential` is its current credential, else `undefined`. */
  verifyCredential(boxId: BoxId, credential: string): Promise<BoxBinding | undefined>;
}
