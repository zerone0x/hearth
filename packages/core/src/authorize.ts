/**
 * E3 Authorization (PRD §7): the single entry point
 * `authorize(principal, action, resource)`. Every API handler calls it first
 * (the one exception, `GET /healthz`, is decision 0001).
 */

import type { AuditSink } from "./audit";
import type { Principal } from "./identity";
import type { EpochMs, WorkspaceId } from "./ids";

/**
 * What the principal wants to do, as `<resource type>.<verb>`, for example
 * `session.create`, `session.message`, `box.echo`, `settings.update`.
 */
export type Action = `${string}.${string}`;

/** What the action applies to. `id` is absent for collection actions such as create or list. */
export interface Resource {
  readonly workspaceId: WorkspaceId;
  /** For example `session`, `box`, `approval`, `trigger`, `settings`. */
  readonly type: string;
  readonly id?: string;
}

/**
 * The answer to an authorization request. There is no "unknown" (PRD §8.1
 * principle 6): a request is allowed or denied with a reason.
 */
export type Decision =
  | { readonly allowed: true; readonly policy: string }
  | { readonly allowed: false; readonly policy: string; readonly reason: string };

/**
 * The authorization policy.
 *
 * Called by every API handler and protocol handler before it reads or changes
 * anything. Guarantees:
 * - Every decision, allow or deny, is written to the `AuditSink` before
 *   `authorize` resolves (E10).
 * - Fails closed: if the decision cannot be audited, the result is a denial,
 *   never an allow. `authorize` itself does not reject.
 * - A principal never acts across workspaces: a resource outside the
 *   principal's workspace is denied by every implementation.
 */
export interface Authorizer {
  authorize(principal: Principal, action: Action, resource: Resource): Promise<Decision>;
}

export interface AllowAllAuthorizerOptions {
  readonly audit: AuditSink;
  readonly now?: () => EpochMs;
}

/**
 * v1 implementation of E3: allows everything a signed-in principal asks for
 * within its own workspace, and audits every decision.
 */
export class AllowAllAuthorizer implements Authorizer {
  static readonly POLICY = "allow-all";
  readonly #audit: AuditSink;
  readonly #now: () => EpochMs;

  constructor(options: AllowAllAuthorizerOptions) {
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
  }

  async authorize(principal: Principal, action: Action, resource: Resource): Promise<Decision> {
    const policy = AllowAllAuthorizer.POLICY;
    const decision: Decision =
      resource.workspaceId === principal.workspaceId
        ? { allowed: true, policy }
        : { allowed: false, policy, reason: "resource is in another workspace" };
    try {
      await this.#audit.write({
        workspaceId: principal.workspaceId,
        principalId: principal.id,
        principalKind: principal.kind,
        action,
        resource,
        decision,
        at: this.#now(),
      });
    } catch {
      return { allowed: false, policy, reason: "audit unavailable" };
    }
    return decision;
  }
}
