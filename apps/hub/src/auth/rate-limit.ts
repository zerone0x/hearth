/**
 * The login rate limit (PRD §10, decision 0014).
 *
 * The personal edition has one account, and behind a reverse proxy every
 * request comes from the proxy's address (`X-Forwarded-For` is not trusted,
 * decision 0010), so the limit is per account, not per client: at most
 * `maxAttempts` failed attempts within `windowMs`. An attempt counts from the
 * moment it starts, so a burst of parallel guesses cannot all reach the KDF
 * before the first failure is recorded. A successful attempt clears the count.
 */

import type { EpochMs } from "@hearth/core";

export interface RateLimit {
  /** Failed (or still running) attempts allowed within `windowMs`. */
  readonly maxAttempts: number;
  /** Length of the sliding window. */
  readonly windowMs: number;
}

/**
 * 10 failed login or setup attempts per 15 minutes: about a thousand guesses a
 * day against a password of at least 12 characters. The cost is that someone
 * who can reach the login can keep the owner out by guessing; the owner then
 * waits out the window.
 */
export const LOGIN_RATE_LIMIT: RateLimit = Object.freeze({
  maxAttempts: 10,
  windowMs: 15 * 60_000,
});

export type Admission =
  | { readonly admitted: true; readonly ticket: number }
  | { readonly admitted: false; readonly retryAfterMs: number };

export class AttemptLimiter {
  readonly #limit: RateLimit;
  readonly #now: () => EpochMs;
  /** Start times of the attempts that count, oldest first, keyed by ticket. */
  readonly #attempts = new Map<number, EpochMs>();
  #nextTicket = 1;

  constructor(limit: RateLimit = LOGIN_RATE_LIMIT, now: () => EpochMs = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** Admit an attempt, or say how long to wait. An admitted attempt counts until `succeeded`. */
  admit(): Admission {
    const now = this.#now();
    for (const [ticket, at] of this.#attempts) {
      if (now - at < this.#limit.windowMs) break;
      this.#attempts.delete(ticket);
    }
    if (this.#attempts.size >= this.#limit.maxAttempts) {
      const oldest = this.#attempts.values().next().value ?? now;
      return { admitted: false, retryAfterMs: Math.max(1, oldest + this.#limit.windowMs - now) };
    }
    const ticket = this.#nextTicket++;
    this.#attempts.set(ticket, now);
    return { admitted: true, ticket };
  }

  /** The attempt succeeded: the earlier failures no longer count either. */
  succeeded(): void {
    this.#attempts.clear();
  }
}
