/**
 * @hearth/protocol: the hub-box wire protocol (PRD §8.2).
 *
 * This package holds pure types and encode/decode functions only: no sockets,
 * no I/O, and never a hub-local path or address. Frames are filled in by the
 * protocol issue; the scaffold only fixes the version shape.
 */

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/** The version this build speaks. A different major is incompatible. */
export const PROTOCOL_VERSION: ProtocolVersion = { major: 1, minor: 0 };

/**
 * Two peers can talk when their major versions match. Minor versions only add
 * optional fields or frame types, so any minor is accepted.
 */
export function isCompatible(peer: ProtocolVersion, ours: ProtocolVersion = PROTOCOL_VERSION) {
  return peer.major === ours.major;
}

export function formatVersion(version: ProtocolVersion): string {
  return `${version.major}.${version.minor}`;
}
