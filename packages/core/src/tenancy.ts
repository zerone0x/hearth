/**
 * E1 Tenancy (PRD §7). Every table has `workspace_id`, and every store query
 * takes a `WorkspaceScope`, so adding workspaces later is a resolver change,
 * not a schema change.
 */

import type { Principal } from "./identity";
import type { WorkspaceId } from "./ids";

/**
 * The workspace a call runs in. Stores filter every read and stamp every write
 * with `workspaceId`; they never accept a bare id from request input.
 */
export interface WorkspaceScope {
  readonly workspaceId: WorkspaceId;
}

/**
 * Maps an authenticated principal to the workspace it acts in.
 *
 * Called by the hub's request pipeline right after authentication, before
 * `authorize`. Guarantees: pure lookup with no side effects; the returned scope
 * equals `principal.workspaceId` for every implementation.
 */
export interface WorkspaceResolver {
  scopeFor(principal: Principal): WorkspaceScope;
}

/** The one workspace of the personal edition (PRD §5). Never changes once data exists. */
export const DEFAULT_WORKSPACE_ID: WorkspaceId = "ws_default";

/** v1 implementation of E1: a single fixed workspace. */
export class SingleWorkspaceResolver implements WorkspaceResolver {
  readonly scope: WorkspaceScope;

  constructor(workspaceId: WorkspaceId = DEFAULT_WORKSPACE_ID) {
    this.scope = Object.freeze({ workspaceId });
  }

  scopeFor(principal: Principal): WorkspaceScope {
    if (principal.workspaceId !== this.scope.workspaceId) {
      // A principal from another workspace cannot exist in v1; failing loudly
      // beats silently acting in the wrong workspace.
      throw new Error(
        `Principal ${principal.id} belongs to workspace ${principal.workspaceId}, not ${this.scope.workspaceId}`,
      );
    }
    return this.scope;
  }
}
