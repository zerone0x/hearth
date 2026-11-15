/**
 * Identifier and value types shared by every extension point.
 *
 * Ids are plain strings so that they cross the database, the wire protocol and
 * logs without conversion. The aliases document intent; they do not brand.
 */

/** Root of ownership (PRD §5, E1). */
export type WorkspaceId = string;
/** Who is acting (E2). */
export type PrincipalId = string;
/** One conversation, bound to one box (PRD §5). */
export type SessionId = string;
/** One round started by a user or a trigger (PRD §5). */
export type TurnId = string;
/** A session's execution environment: a container plus a persistent volume (PRD §5). */
export type BoxId = string;
/**
 * A random id the box-agent picks each time it starts. Together with a
 * `DeliveryId` it identifies one delivery from a box (PRD §8.1 principle 5).
 */
export type BootId = string;
/** Monotonic per boot, starting at 1. Assigned by the box-agent. */
export type DeliveryId = number;
/** Per-session event sequence number, assigned by the `EventStore`. Starts at 1. */
export type Seq = number;
/** Milliseconds since the Unix epoch. */
export type EpochMs = number;

/** Any value that survives `JSON.stringify` / `JSON.parse` unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
