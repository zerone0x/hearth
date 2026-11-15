/**
 * E4 BoxProvider (PRD §5, §6.2, §6.3, §7): creates and runs boxes. Interface
 * only; the Docker implementation lives in the hub (#6).
 *
 * A box is a disposable runtime (a container) plus durable storage (a volume).
 * The volume is the source of truth and survives `stop`; only `destroy`
 * removes it. The box dials out to the hub, so the provider never hands the hub
 * an address or a path inside the box (PRD §8.2).
 */

import type { BoxId, EpochMs, SessionId, WorkspaceId } from "./ids";

/** Resource limits for one box (PRD §6.2). Omitted fields use the provider's configured defaults. */
export interface BoxResources {
  /** CPU cores, may be fractional (e.g. `1.5`). */
  readonly cpus?: number;
  readonly memoryBytes?: number;
  readonly pids?: number;
  readonly diskBytes?: number;
}

/** Everything a provider needs to create, and later recreate, a box's runtime. */
export interface BoxSpec {
  readonly boxId: BoxId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  /** Image reference, e.g. `ghcr.io/zerone0x/hearth-box:1`. */
  readonly image: string;
  readonly resources?: BoxResources;
  /**
   * Extra metadata recorded on the box (for Docker: labels). The provider adds
   * its own for workspace, session and box id; these cannot override them.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/** What `start` passes to the box for this boot only. */
export interface BoxBootConfig {
  /**
   * Environment for the box-agent: the hub URL it dials and its one-time join
   * token. Values are short-lived; a box never receives a long-lived secret
   * (PRD §6.4, §10).
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * - `stopped`: durable storage exists, no runtime (created, or hibernated).
 * - `running`: the runtime is up. It may not have connected to the hub yet;
 *   only the hub's connection state says whether it is healthy.
 * - `exited`: the runtime ended on its own (crash, OOM). The hub decides what
 *   happens next; the provider never restarts a box by itself.
 */
export type BoxState = "stopped" | "running" | "exited";

export interface BoxInfo {
  readonly boxId: BoxId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly state: BoxState;
  readonly image: string;
  /** Provider-specific handle for the runtime (a container id), absent when stopped. */
  readonly providerRef?: string;
  /** Provider-specific handle for the durable storage (a volume name). */
  readonly volumeRef: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: EpochMs;
  /**
   * The runtime's exit code, present only when `state` is `exited`. The hub
   * classifies the exit by it (docs/DECISIONS.md, 0013): box-agent exits 2 on
   * bad box configuration and 3 when its credential is lost.
   */
  readonly exitCode?: number;
}

/** The explicit answer of `stop` (PRD §8.1 principle 6). */
export type StopOutcome = "stopped" | "already-stopped" | "not-found";

/** The explicit answer of `destroy`. */
export type DestroyOutcome = "destroyed" | "not-found";

/**
 * The explicit answer of `snapshot`. Process snapshots are an optional layer on
 * top of the volume (PRD §6.3); a provider without them says so.
 */
export type SnapshotOutcome =
  | { readonly kind: "created"; readonly snapshotRef: string }
  | { readonly kind: "not-supported" };

/**
 * Creates, runs and removes boxes.
 *
 * Called only by the hub's session manager (create on session create, start on
 * wake, stop on hibernate, destroy on delete) and at hub startup (`adopt`).
 * Business code never talks to Docker or any other runtime directly.
 *
 * Every method is idempotent and safe to repeat after a hub crash, since the
 * hub logs an intent before acting and may replay it (PRD §8.1 principles 6–7).
 * Failures reject with a `HearthError` classified by owner (PRD §8.1
 * principle 2): `box` for a failure of the box or its runtime (bad image, OOM,
 * the runtime refusing the box), `hub` when the provider cannot reach or use its
 * own backend (socket missing, permission denied). Missing boxes are answered,
 * not thrown.
 */
export interface BoxProvider {
  /** Short provider name recorded in the `box` table, e.g. `docker`. */
  readonly name: string;

  /**
   * Create the box's durable storage and isolation (volume, network), without
   * running anything. Creating a box id that already exists returns the
   * existing box unchanged.
   */
  create(spec: BoxSpec): Promise<BoxInfo>;

  /**
   * Make the box run with a fresh runtime built from `spec` and the volume, and
   * pass it `boot`. If the box was never created, this creates it first. If it
   * is already running, it is left alone and `boot` is not applied; the caller
   * stops it first when it needs a new join token to take effect.
   */
  start(spec: BoxSpec, boot: BoxBootConfig): Promise<BoxInfo>;

  /**
   * Hibernate: stop and remove the runtime, keep the volume (PRD §6.3).
   * `graceMs` bounds how long the box gets to exit cleanly before it is killed.
   */
  stop(boxId: BoxId, options?: { readonly graceMs?: number }): Promise<StopOutcome>;

  /** Remove the runtime, the volume and the box's network. Removing a missing box succeeds. */
  destroy(boxId: BoxId): Promise<DestroyOutcome>;

  /** Take a process snapshot of a running box. v1 providers answer `not-supported`. */
  snapshot(boxId: BoxId): Promise<SnapshotOutcome>;

  /**
   * Re-attach to one existing box by id: its current state as the backend sees
   * it, or `undefined` when it does not exist. The hub calls this before acting
   * on a box whose state it is not sure of. It does not open a channel to the
   * box: the box dials the hub (PRD §8.2).
   */
  attach(boxId: BoxId): Promise<BoxInfo | undefined>;

  /**
   * List every box this provider manages (for Docker: containers and volumes
   * carrying Hearth labels), running or not. Called once at hub startup so a
   * restart does not orphan boxes; the hub reconciles the list with its own
   * `box` table.
   */
  adopt(): Promise<readonly BoxInfo[]>;
}
