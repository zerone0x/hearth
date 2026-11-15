/**
 * @hearth/core: extension-point interfaces (PRD §7) and the types shared by the
 * hub and the box-agent.
 *
 * Business code depends on the interfaces exported here, never on Docker,
 * SQLite or environment secrets directly (AGENTS.md, boundary rules).
 *
 * | PRD §7 | Module | v1 implementation here |
 * |---|---|---|
 * | E1 Tenancy | `tenancy.ts` | `SingleWorkspaceResolver` |
 * | E2 Identity | `identity.ts` | `LOCAL_PRINCIPAL` |
 * | E3 Authorization | `authorize.ts` | `AllowAllAuthorizer` |
 * | E4 BoxProvider | `box.ts` | none (Docker, in the hub) |
 * | E6 EventStore | `events.ts` | none (SQLite, in the hub) |
 * | E7 SecretStore | `secrets.ts` | `ResolvingSecretStore` with `env:` / `file:` |
 * | E8 ModelGateway | `gateway.ts` | none (Bifrost, in the hub) |
 * | E9 Channel | `channel.ts` | none (Web, Telegram) |
 * | E10 Audit | `audit.ts` | `MemoryAuditSink`, `withAudit` |
 *
 * E5, the hub-box protocol, lives in `@hearth/protocol`.
 */

export * from "./audit";
export * from "./authorize";
export * from "./box";
export * from "./channel";
export * from "./events";
export * from "./failure";
export * from "./gateway";
export * from "./identity";
export * from "./ids";
export * from "./log";
export * from "./secrets";
export * from "./tenancy";

/**
 * Exhaustiveness guard for discriminated unions. Put it in the `default` branch
 * of a `switch` so that adding a variant without handling it fails to compile.
 * At runtime it throws, naming the unexpected value.
 */
export function assertNever(value: never, context = "value"): never {
  throw new Error(`Unexpected ${context}: ${JSON.stringify(value)}`);
}
