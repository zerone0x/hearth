/**
 * The runner's access extension (decisions 0043, 0045): one `tool_call`
 * handler, registered first under the reserved name `hearth-access`, that
 * reads the session's access mode once per tool call and hands it to the
 * trajectory. The `ask` gate of #155 grows here; today the handler never
 * blocks a call itself, but an exception in it (the mode could not be read)
 * blocks the call, as pi does for any `tool_call` handler: fail-closed.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AccessMode } from "../settings/access-mode";

/** The reserved extension name (`RESERVED_EXTENSION_NAMES`). */
export const ACCESS_EXTENSION = "hearth-access";

export interface AccessExtensionOptions {
  /** The mode in force for the session now (`AccessModes.resolve`). */
  readonly resolve: () => AccessMode;
  /** The mode the call was preflighted under, for its trajectory record. */
  readonly onMode?: (toolCallId: string, mode: AccessMode) => void;
}

export function accessExtension(options: AccessExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      // Read per call, never cached: a change applies to the next call.
      const mode = options.resolve();
      options.onMode?.(event.toolCallId, mode);
      return undefined;
    });
  };
}
