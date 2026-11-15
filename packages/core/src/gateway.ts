/**
 * E8 ModelGateway (PRD §6.4, §7): issues and revokes per-session model
 * credentials and reports usage. Interface only; Bifrost (one virtual key per
 * session) and `direct` implement it later.
 */

import type { EpochMs, SessionId } from "./ids";
import type { SecretValue } from "./secrets";
import type { WorkspaceScope } from "./tenancy";

export interface SessionCredentialRequest {
  readonly sessionId: SessionId;
  /**
   * Models the credential may call. An empty list allows no model, never all
   * models (PRD §6.4).
   */
  readonly models: readonly string[];
  /** Spending cap in US dollars, if the gateway supports budgets. */
  readonly budgetUsd?: number;
  /** Requests per minute, if the gateway supports rate limits. */
  readonly requestsPerMinute?: number;
}

/** What the box needs to reach models for one session. */
export interface SessionCredential {
  readonly sessionId: SessionId;
  /** Base URL as reachable from the box. Never a hub-local path. */
  readonly baseUrl: string;
  /** The per-session key (a Bifrost virtual key). Never a provider key. */
  readonly key: SecretValue;
  /** Gateway-side id of the credential, used to revoke it and match usage. */
  readonly credentialRef: string;
  readonly models: readonly string[];
}

export interface UsageReport {
  readonly sessionId: SessionId;
  readonly since: EpochMs;
  readonly until: EpochMs;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Absent when the gateway does not price requests (e.g. `direct`). */
  readonly costUsd?: number;
}

/** The explicit answer of `revoke`. */
export type RevokeOutcome = "revoked" | "not-found";

/**
 * Called by the hub's session manager: `issue` before a box starts, `setModels`
 * when the user switches model, `revoke` on archive or delete, and `usage` for
 * spend display and the retro.
 *
 * Failures reject with a `HearthError` owned by `gateway` (the gateway itself
 * failed or refused) or `model-provider` (a model was retired or the upstream
 * refused); they never imply anything about the box.
 */
export interface ModelGateway {
  /** Short gateway name, e.g. `bifrost` or `direct`. */
  readonly name: string;

  /**
   * Issue the credential for a session. Idempotent per session: issuing again
   * returns the existing credential (with the requested models applied) rather
   * than a second key.
   */
  issue(scope: WorkspaceScope, request: SessionCredentialRequest): Promise<SessionCredential>;

  /** Replace the model allowlist of a session's credential. An empty list allows no model. */
  setModels(scope: WorkspaceScope, sessionId: SessionId, models: readonly string[]): Promise<void>;

  /** Revoke a session's credential. After it resolves, the key is refused by the gateway. */
  revoke(scope: WorkspaceScope, sessionId: SessionId): Promise<RevokeOutcome>;

  /** Usage of a session's credential in `[since, now)`, from the gateway's own request log. */
  usage(scope: WorkspaceScope, sessionId: SessionId, since: EpochMs): Promise<UsageReport>;
}
