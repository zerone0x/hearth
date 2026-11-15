/**
 * Failure classification (PRD §8.1 principle 2: classify before recovering).
 *
 * Every failure that crosses an extension-point boundary is a `HearthError`
 * tagged with an owner and a retry disposition, so the caller can recover
 * without guessing: a model-provider failure never destroys a box, and a box
 * failure never burns model retries.
 */

import type { FailureDisposition, FailureOwner } from "@hearth/protocol";

/**
 * Who is responsible for a failure (`box`, `model-provider`, `gateway`, `hub`,
 * `user`), and what the caller may do about it:
 *
 * - `retry`: transient; the same call may succeed if retried (bounded, with backoff).
 * - `retry-cold`: the current runtime is suspect; retry after recreating it
 *   (for a box: a cold boot from the volume, PRD §6.3).
 * - `give-up`: retrying cannot help; surface the failure to the user.
 *
 * `@hearth/protocol` owns both vocabularies (decision 0005); core re-exports
 * them and must not redefine them.
 */
export type { FailureDisposition, FailureOwner };

export interface FailureClass {
  readonly owner: FailureOwner;
  readonly disposition: FailureDisposition;
}

export interface HearthErrorOptions extends FailureClass {
  /** Stable, machine-readable code such as `box.not-found` or `secret.empty`. */
  readonly code: string;
  readonly cause?: unknown;
}

/**
 * A classified failure. Messages must never contain secret values; put
 * references or fingerprints in them instead.
 */
export class HearthError extends Error {
  readonly owner: FailureOwner;
  readonly disposition: FailureDisposition;
  readonly code: string;

  constructor(message: string, options: HearthErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HearthError";
    this.owner = options.owner;
    this.disposition = options.disposition;
    this.code = options.code;
  }
}

/**
 * Classify any thrown value. A `HearthError` keeps its own class; anything else
 * is an unexpected bug in the hub, which retrying will not fix.
 */
export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof HearthError) {
    return { owner: error.owner, disposition: error.disposition };
  }
  return { owner: "hub", disposition: "give-up" };
}
