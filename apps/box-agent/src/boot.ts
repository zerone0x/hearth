/**
 * Start-up hardening of box-agent against the commands it runs (#57, decision
 * 0018). Tool commands run as the same uid as box-agent, so without these steps
 * any command could read box-agent's start-up environment through
 * `/proc/<pid>/environ` and its memory (the per-box credential) through
 * `/proc/<pid>/mem` or `ptrace`.
 *
 * - `makeNonDumpable` sets `PR_SET_DUMPABLE` to 0. The kernel then hands this
 *   process's `/proc/<pid>/` files to root and refuses same-uid `ptrace`, so a
 *   process without `CAP_SYS_PTRACE` (every process in a box: `CapDrop ALL`)
 *   can read neither its environment, its memory map nor its memory. The flag
 *   is reset by `execve`, so the commands box-agent starts are dumpable again
 *   and the executor can still find them by their run marker.
 * - `takeJoinToken` reads the join token from the file the box entrypoint
 *   wrote (`HEARTH_JOIN_TOKEN_FILE`) and deletes it, so it is gone before any
 *   tool runs. Outside the image (tests, the hub's demo) the token may still
 *   come from `HEARTH_JOIN_TOKEN`; either way both variables are removed from
 *   `process.env`, so nothing box-agent starts can inherit them.
 */

import { unlinkSync } from "node:fs";
import { createDefaultSecretStore, type SecretStore } from "@hearth/core";

/** The file the box entrypoint moved the join token to (`apps/box-agent/image/entrypoint.sh`). */
export const JOIN_TOKEN_FILE_VAR = "HEARTH_JOIN_TOKEN_FILE";
/** The join token in the environment: only outside the image. */
export const JOIN_TOKEN_VAR = "HEARTH_JOIN_TOKEN";

/** `prctl` options from `<linux/prctl.h>`. */
const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

export type DumpableResult =
  | { readonly kind: "set" }
  | { readonly kind: "unsupported"; readonly reason: string };

/**
 * Makes this process non-dumpable (Linux only) and checks that it took.
 * Throws when the kernel refused it; answers `unsupported` off Linux.
 */
export async function makeNonDumpable(): Promise<DumpableResult> {
  if (process.platform !== "linux") {
    return { kind: "unsupported", reason: `no prctl on ${process.platform}` };
  }
  const { dlopen, FFIType } = await import("bun:ffi");
  const word = FFIType.u64;
  const libc = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, word, word, word, word], returns: FFIType.i32 },
  });
  try {
    const set = libc.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n);
    const now = libc.symbols.prctl(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n);
    if (set !== 0 || now !== 0) {
      throw new Error(`prctl(PR_SET_DUMPABLE, 0) failed (returned ${set}, dumpable ${now})`);
    }
  } finally {
    libc.close();
  }
  return { kind: "set" };
}

export interface TakeJoinTokenOptions {
  /** The environment to read and scrub; `process.env` in production. */
  readonly env: Record<string, string | undefined>;
  readonly secrets?: SecretStore;
}

/**
 * Reads the join token, from `HEARTH_JOIN_TOKEN_FILE` when set (and deletes
 * that file) or else from `HEARTH_JOIN_TOKEN`, and removes both variables from
 * `env`. Throws the SecretStore's error when there is no usable token.
 */
export async function takeJoinToken(options: TakeJoinTokenOptions): Promise<string> {
  const { env } = options;
  const file = env[JOIN_TOKEN_FILE_VAR];
  const ref = file ? `file:${file}` : `env:${JOIN_TOKEN_VAR}`;
  const secrets = options.secrets ?? createDefaultSecretStore({ env: { ...env } });
  delete env[JOIN_TOKEN_VAR];
  delete env[JOIN_TOKEN_FILE_VAR];
  try {
    return (await secrets.resolve(ref)).reveal();
  } finally {
    if (file) {
      try {
        unlinkSync(file);
      } catch {
        // Already gone (a restarted box-agent), or never written.
      }
    }
  }
}
