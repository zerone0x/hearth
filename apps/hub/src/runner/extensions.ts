/**
 * Extension allowlist (#56; decision 0015). The runner never discovers
 * extensions on the hub's disk (`noExtensions`, no `additionalExtensionPaths`).
 * Only an extension that is (1) bundled with the hub as a pinned factory and
 * (2) named in the config allowlist with the same version loads. The default
 * allowlist is empty, so only Hearth's own tool extension runs.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** An extension the hub ships, pinned to one version. */
export interface PinnedExtension {
  readonly name: string;
  readonly version: string;
  readonly factory: ExtensionFactory;
}

/** One allowlist entry from config: an extension name and its pinned version. */
export interface ExtensionPin {
  readonly name: string;
  readonly version: string;
}

export interface ExtensionSelection {
  readonly loaded: readonly PinnedExtension[];
  /** Available but not allowlisted, or allowlisted at another version. */
  readonly refused: readonly { readonly name: string; readonly reason: string }[];
}

/** Names reserved for the runner's own extensions; an allowlist cannot shadow them. */
export const RESERVED_EXTENSION_NAMES: ReadonlySet<string> = new Set([
  "hearth-tools",
  // The access mode reader and, with #155, the access gate (decisions 0043, 0045).
  "hearth-access",
  "codemode",
  // The trajectory observer (decision 0021): runs last and must stay passive.
  "hearth-trace",
]);

export function selectExtensions(
  available: readonly PinnedExtension[],
  allowlist: readonly ExtensionPin[],
): ExtensionSelection {
  const pins = new Map(allowlist.map((pin) => [pin.name, pin.version]));
  const loaded: PinnedExtension[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const extension of available) {
    if (RESERVED_EXTENSION_NAMES.has(extension.name)) {
      refused.push({ name: extension.name, reason: "reserved name" });
      continue;
    }
    const pinned = pins.get(extension.name);
    if (pinned === undefined) {
      refused.push({ name: extension.name, reason: "not in the allowlist" });
    } else if (pinned !== extension.version) {
      refused.push({
        name: extension.name,
        reason: `allowlist pins ${pinned}, hub has ${extension.version}`,
      });
    } else {
      loaded.push(extension);
    }
  }
  return { loaded, refused };
}
