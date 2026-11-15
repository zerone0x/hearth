/**
 * @hearth/core: extension-point interfaces (PRD §7) and the types shared by the
 * hub and the box-agent.
 *
 * Business code depends on the interfaces exported here, never on Docker,
 * SQLite or environment secrets directly (AGENTS.md, boundary rules).
 * The interfaces themselves land in a later M0 issue.
 */

/**
 * Exhaustiveness guard for discriminated unions. Put it in the `default` branch
 * of a `switch` so that adding a variant without handling it fails to compile.
 * At runtime it throws, naming the unexpected value.
 */
export function assertNever(value: never, context = "value"): never {
  throw new Error(`Unexpected ${context}: ${JSON.stringify(value)}`);
}
