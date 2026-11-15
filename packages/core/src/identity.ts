/**
 * E2 Identity (PRD §7): who is acting. Authentication (password, passkey, and
 * later OIDC or API keys) produces a `Principal`; everything after that only
 * sees the principal.
 */

import type { PrincipalId, WorkspaceId } from "./ids";
import { DEFAULT_WORKSPACE_ID } from "./tenancy";

/**
 * - `user`: a person signed in through the web UI or a paired chat.
 * - `service`: a non-human caller such as a trigger or webhook (later: API keys).
 * - `box`: a box-agent, authenticated by its per-box credential.
 * - `system`: the hub itself (sweeps, schedulers, startup preflight).
 */
export type PrincipalKind = "user" | "service" | "box" | "system";

export interface Principal {
  readonly id: PrincipalId;
  readonly workspaceId: WorkspaceId;
  readonly kind: PrincipalKind;
  /** A label for display and audit. Never used for identity decisions. */
  readonly displayName: string;
}

/** Id of the one local user of the personal edition. */
export const LOCAL_PRINCIPAL_ID: PrincipalId = "pr_local";

/** v1 implementation of E2: the one local user, owner of the default workspace. */
export const LOCAL_PRINCIPAL: Principal = Object.freeze({
  id: LOCAL_PRINCIPAL_ID,
  workspaceId: DEFAULT_WORKSPACE_ID,
  kind: "user",
  displayName: "local",
});

/** The hub acting on its own behalf, e.g. a sweep or the startup preflight. */
export const SYSTEM_PRINCIPAL: Principal = Object.freeze({
  id: "pr_system",
  workspaceId: DEFAULT_WORKSPACE_ID,
  kind: "system",
  displayName: "hub",
});
