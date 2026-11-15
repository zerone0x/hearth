/**
 * Box egress gate (docs/DECISIONS.md, 0012). Boxes get the host, the LAN and
 * cloud metadata out of reach only through `scripts/box-firewall.sh apply`,
 * which runs as root outside the hub. The script writes a marker file after
 * every rule is in place; the marker lives on tmpfs (`/run`), so it is gone
 * after a reboot exactly like the rules. The hub reads it before every box
 * start and refuses to start boxes without it, unless the owner set
 * `HEARTH_BOX_EGRESS=unrestricted` on purpose.
 */

import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HearthError } from "@hearth/core";

/** Where `scripts/box-firewall.sh apply` writes its marker (tmpfs; cleared on reboot). */
export const DEFAULT_BOX_EGRESS_MARKER = "/run/hearth/box-egress.applied";

/**
 * What the hub knows about box egress:
 * - `filtered`: the firewall marker exists; boxes start.
 * - `unrestricted`: the owner set `HEARTH_BOX_EGRESS=unrestricted`; boxes
 *   start with full host, LAN and metadata egress.
 * - `unfiltered`: no marker and no opt-out; `startBox` is refused.
 */
export type BoxEgressState = "filtered" | "unrestricted" | "unfiltered";

export interface BoxEgressStatus {
  readonly state: BoxEgressState;
  /** One line for the owner: what it means and what to do. */
  readonly detail: string;
}

/** Reads the current egress status. Called on every `startBox`, so a later `apply` counts. */
export type BoxEgressCheck = () => BoxEgressStatus;

/** Options for `markerEgressCheck`. */
export interface MarkerTrust {
  /**
   * The uid that must own the marker and every directory above it (root also
   * qualifies for the directories). Default 0: the firewall runs as root, on
   * bare metal and as the compose one-shot alike. Tests pass their own uid.
   */
  readonly owner?: number;
}

const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;

/**
 * Why the marker at `marker` cannot be trusted, or `undefined` when it can.
 *
 * The rule (docs/DECISIONS.md, 0023): the marker is a regular file (not a
 * symlink) owned by `owner` and writable by nobody else, and every directory
 * on its real path is owned by root or `owner` and is either writable by
 * nobody else or sticky (`/tmp`), so no other user can create, replace or
 * rename the marker or a directory above it, and it has exactly one hard
 * link (a hard link to a root file, made in a sticky directory where
 * `fs.protected_hardlinks=0`, is otherwise root-owned and mode 0644). A hub that does not run as the
 * owner therefore cannot forge the marker, whatever `HEARTH_BOX_EGRESS_MARKER`
 * points at. A hub that runs as root (the compose install) is not held off by
 * any file mode; there the guarantee is that the marker is root's, and compose
 * mounts /run/hearth read-only into the hub.
 */
export function untrustedMarker(
  marker: string,
  owner = 0,
  lstat: (path: string) => Stats = lstatSync,
): string | undefined {
  let file: Stats;
  let dir: string;
  try {
    // Resolve the directory once; the file and the directory walk both use
    // this resolved path, so a swap between two lookups cannot split them.
    dir = realpathSync(dirname(resolve(marker)));
    file = lstat(join(dir, basename(marker)));
  } catch {
    return "missing";
  }
  if (!file.isFile()) return "it is not a regular file";
  if (file.nlink !== 1) return `it has ${file.nlink} hard links, not 1`;
  if (file.uid !== owner) return `it is owned by uid ${file.uid}, not ${owner}`;
  if ((file.mode & GROUP_OR_OTHER_WRITE) !== 0) return "it is writable by group or others";
  for (let at = dir; ; at = dirname(at)) {
    let st: Stats;
    try {
      st = lstat(at);
    } catch {
      return `${at} cannot be read`;
    }
    if (st.uid !== owner && st.uid !== 0) return `${at} is owned by uid ${st.uid}`;
    if ((st.mode & GROUP_OR_OTHER_WRITE) !== 0 && (st.mode & STICKY) === 0) {
      return `${at} is writable by group or others`;
    }
    if (dirname(at) === at) return undefined;
  }
}

/**
 * The marker check: `filtered` while `marker` exists and passes
 * `untrustedMarker`, `unfiltered` otherwise.
 */
export function markerEgressCheck(
  marker: string = DEFAULT_BOX_EGRESS_MARKER,
  trust: MarkerTrust = {},
): BoxEgressCheck {
  const owner = trust.owner ?? 0;
  return () => {
    const why = untrustedMarker(marker, owner);
    if (why === undefined) return { state: "filtered", detail: `box firewall applied (${marker})` };
    const fix =
      "Run `sudo scripts/box-firewall.sh apply` (again after every reboot), or set " +
      "HEARTH_BOX_EGRESS=unrestricted to start boxes with open host and LAN egress";
    return {
      state: "unfiltered",
      detail:
        why === "missing"
          ? `box firewall not applied: ${marker} is missing. ${fix}`
          : `box firewall marker ${marker} not trusted: ${why}. Only root may write the ` +
            `marker and the directories above it. ${fix}`,
    };
  };
}

/** The explicit opt-out: boxes start with open egress. */
export const UNRESTRICTED_EGRESS: BoxEgressCheck = () => ({
  state: "unrestricted",
  detail: "HEARTH_BOX_EGRESS=unrestricted: boxes can reach the host, the LAN and cloud metadata",
});

/**
 * The egress check from `HEARTH_BOX_EGRESS` (unset or `filtered`: the marker
 * check; `unrestricted`: the opt-out) and `HEARTH_BOX_EGRESS_MARKER` (the
 * marker path, default `DEFAULT_BOX_EGRESS_MARKER`).
 */
export function boxEgressFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): BoxEgressCheck {
  const mode = env["HEARTH_BOX_EGRESS"] || "filtered";
  if (mode === "unrestricted") return UNRESTRICTED_EGRESS;
  if (mode !== "filtered") {
    throw new Error(`HEARTH_BOX_EGRESS must be "filtered" or "unrestricted", got "${mode}"`);
  }
  return markerEgressCheck(env["HEARTH_BOX_EGRESS_MARKER"] || DEFAULT_BOX_EGRESS_MARKER);
}

/** Throws the box-owned refusal unless `status` lets boxes start. */
export function requireBoxEgress(status: BoxEgressStatus): void {
  if (status.state !== "unfiltered") return;
  throw new HearthError(status.detail, {
    owner: "box",
    disposition: "give-up",
    code: "box.egress-unfiltered",
  });
}
