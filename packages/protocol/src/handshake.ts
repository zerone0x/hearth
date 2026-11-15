/**
 * Version check for the handshake (PRD §8.2): a box speaking an incompatible
 * major version gets a clear `reject` instead of a hub that misbehaves.
 *
 * `decodeFrame` already checks a `hello`'s version before any other field and
 * fails with `version-mismatch`. The hub turns any failed first frame into a
 * `reject` with `rejectHello`.
 */

import type { DecodeError } from "./codec";
import type { HelloFrame, RejectFrame } from "./frames";
import { formatVersion, isCompatible, PROTOCOL_VERSION, type ProtocolVersion } from "./version";

function versionMismatch(boxVersion: ProtocolVersion, hubVersion: ProtocolVersion): RejectFrame {
  return {
    type: "reject",
    reason: "version-mismatch",
    message:
      `box speaks protocol ${formatVersion(boxVersion)} but the hub speaks ` +
      `${formatVersion(hubVersion)}; major versions must match`,
    hubVersion,
    boxVersion,
  };
}

/**
 * Returns `null` when the hub can talk to the box that sent `hello`, or the
 * `reject` frame to send back when the major versions differ. Credentials and
 * box identity are checked by the hub, not here.
 */
export function checkHelloVersion(
  hello: Pick<HelloFrame, "version">,
  hubVersion: ProtocolVersion = PROTOCOL_VERSION,
): RejectFrame | null {
  if (isCompatible(hello.version, hubVersion)) return null;
  return versionMismatch(hello.version, hubVersion);
}

/**
 * The `reject` to send when the first frame of a connection failed to decode
 * as a `hello`: `version-mismatch` naming both versions when the decoder
 * found another major, `malformed-hello` with the decoder's message otherwise.
 */
export function rejectHello(
  error: DecodeError,
  hubVersion: ProtocolVersion = PROTOCOL_VERSION,
): RejectFrame {
  if (error.code === "version-mismatch" && error.peerVersion !== undefined) {
    return versionMismatch(error.peerVersion, hubVersion);
  }
  return { type: "reject", reason: "malformed-hello", message: error.message };
}
