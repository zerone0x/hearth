/**
 * Liveness of the hub-box connection (issue #31, decision 0028).
 *
 * Each end runs its own `Heartbeat` on its own clock: every `intervalMs` it
 * checks whether any frame arrived since the last beat. A beat with nothing
 * heard is a miss; a frame resets the count. The beat sends a `ping` so an
 * idle but healthy peer still answers (with `pong`). After `maxMisses`
 * consecutive misses the connection is declared dead and `dead` is called
 * once. Failures are counted, not timed (PRD §8.1): the bound is between
 * `maxMisses × intervalMs` and `(maxMisses + 1) × intervalMs` after the last
 * frame.
 *
 * The clock is injected, so this file stays free of I/O and tests drive the
 * beats by hand.
 */

/** Time between beats. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** Consecutive beats with no frame from the peer before the connection is dead. */
export const HEARTBEAT_MAX_MISSES = 3;
/** The largest `ping` nonce (`u32`); the counter wraps to 0 after it. */
const MAX_NONCE = 0xffff_ffff;

/** The upper bound of detection after the last frame from the peer. */
export function heartbeatBoundMs(
  intervalMs = HEARTBEAT_INTERVAL_MS,
  maxMisses = HEARTBEAT_MAX_MISSES,
): number {
  return (maxMisses + 1) * intervalMs;
}

/** A repeating timer. Returns its cancel function. */
export interface HeartbeatClock {
  every(ms: number, beat: () => void): () => void;
}

export interface HeartbeatSettings {
  readonly intervalMs?: number;
  readonly maxMisses?: number;
}

export interface HeartbeatOptions extends HeartbeatSettings {
  readonly clock: HeartbeatClock;
  /** Send a `ping` with this nonce. */
  readonly ping: (nonce: number) => void;
  /** The connection is dead: `misses` beats in a row heard nothing. Called once. */
  readonly dead: (misses: number) => void;
}

export class Heartbeat {
  readonly intervalMs: number;
  readonly maxMisses: number;
  readonly #options: HeartbeatOptions;
  #cancel: (() => void) | undefined;
  #heard = false;
  #misses = 0;
  #nonce = 0;

  constructor(options: HeartbeatOptions) {
    this.#options = options;
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.maxMisses = options.maxMisses ?? HEARTBEAT_MAX_MISSES;
    if (!(this.intervalMs > 0) || !Number.isInteger(this.maxMisses) || this.maxMisses < 1) {
      throw new RangeError(
        `heartbeat needs intervalMs > 0 and maxMisses >= 1, got ${this.intervalMs} and ${this.maxMisses}`,
      );
    }
  }

  /** Consecutive beats that heard nothing so far. */
  get misses(): number {
    return this.#misses;
  }

  get running(): boolean {
    return this.#cancel !== undefined;
  }

  /** Start beating. A second call does nothing. */
  start(): void {
    if (this.#cancel !== undefined) return;
    this.#heard = false;
    this.#misses = 0;
    this.#cancel = this.#options.clock.every(this.intervalMs, () => this.#beat());
  }

  /** Any frame from the peer: the connection is alive. */
  heard(): void {
    this.#heard = true;
  }

  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #beat(): void {
    if (this.#cancel === undefined) return;
    if (this.#heard) this.#misses = 0;
    else this.#misses += 1;
    this.#heard = false;
    if (this.#misses >= this.maxMisses) {
      this.stop();
      this.#options.dead(this.#misses);
      return;
    }
    this.#nonce = this.#nonce >= MAX_NONCE ? 0 : this.#nonce + 1;
    this.#options.ping(this.#nonce);
  }
}
