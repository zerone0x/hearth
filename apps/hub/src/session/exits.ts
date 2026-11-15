/**
 * Box exit classification (PRD §6.2, §8.1 principles 1 and 2; #28;
 * docs/DECISIONS.md, 0013). box-agent's exit codes (decision 0008):
 *
 * - 2: the box's configuration is wrong (missing boot environment). Retrying
 *   cannot fix it: give up visibly.
 * - 3: the box lost its credential (the `welcome` was lost, so its join token
 *   is spent). Relaunch with a fresh join token, a bounded number of times.
 * - anything else: a crash (including a kill or OOM). Retry from a cold start,
 *   a bounded number of times.
 */

import type { FailureDisposition } from "@hearth/core";

export const EXIT_CODE_CONFIG = 2;
export const EXIT_CODE_CREDENTIAL_LOST = 3;

export type ExitCause = "config" | "credential-lost" | "crash" | "connect-deadline";

export interface ExitClass {
  readonly cause: ExitCause;
  readonly disposition: FailureDisposition;
  /** Stable failure code for the session event (`box.<…>`). */
  readonly code: string;
}

export function classifyExit(exitCode: number | undefined): ExitClass {
  if (exitCode === EXIT_CODE_CONFIG) {
    return { cause: "config", disposition: "give-up", code: "box.config" };
  }
  if (exitCode === EXIT_CODE_CREDENTIAL_LOST) {
    return { cause: "credential-lost", disposition: "retry", code: "box.credential-lost" };
  }
  return { cause: "crash", disposition: "retry-cold", code: "box.crashed" };
}

/** A box that started but never connected within its deadline: retried like a crash. */
export const CONNECT_DEADLINE_CLASS: ExitClass = {
  cause: "connect-deadline",
  disposition: "retry-cold",
  code: "box.connect-deadline",
};
