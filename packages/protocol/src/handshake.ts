/**
 * Version check for the handshake (PRD §8.2): a box speaking an incompatible
 * major version gets a clear `reject` instead of a hub that misbehaves.
 */

import type { HelloFrame, RejectFrame } from "./frames";
import { formatVersion, isCompatible, PROTOCOL_VERSION, type ProtocolVersion } from "./version";

/**
 * Returns `null` when the hub can talk to the box that sent `hello`, or the
 * `reject` frame to send back when the major versions differ. Credentials and
 * box identity are checked by the hub, not here.
 */
export function checkHelloVersion(
  hello: HelloFrame,
  hubVersion: ProtocolVersion = PROTOCOL_VERSION,
): RejectFrame | null {
  if (isCompatible(hello.version, hubVersion)) return null;
  return {
    type: "reject",
    reason: "version-mismatch",
    message:
      `box speaks protocol ${formatVersion(hello.version)} but the hub speaks ` +
      `${formatVersion(hubVersion)}; major versions must match`,
    hubVersion,
    boxVersion: hello.version,
  };
}
