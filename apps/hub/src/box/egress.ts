/**
 * Box egress gate (docs/DECISIONS.md, 0012). Boxes get the host, the LAN and
 * cloud metadata out of reach only through `scripts/box-firewall.sh apply`,
 * which runs as root outside the hub. The script writes a marker file after
 * every rule is in place; the marker lives on tmpfs (`/run`), so it is gone
 * after a reboot exactly like the rules. The hub reads it before every box
 * start and refuses to start boxes without it, unless the owner set
 * `HEARTH_BOX_EGRESS=unrestricted` on purpose.
 */

import { existsSync } from "node:fs";
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

/** The marker check: `filtered` while `marker` exists, `unfiltered` otherwise. */
export function markerEgressCheck(marker: string = DEFAULT_BOX_EGRESS_MARKER): BoxEgressCheck {
  return () =>
    existsSync(marker)
      ? { state: "filtered", detail: `box firewall applied (${marker})` }
      : {
          state: "unfiltered",
          detail:
            `box firewall not applied: ${marker} is missing. Run ` +
            "`sudo scripts/box-firewall.sh apply` (again after every reboot), or set " +
            "HEARTH_BOX_EGRESS=unrestricted to start boxes with open host and LAN egress",
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
