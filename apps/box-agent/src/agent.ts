import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { formatVersion, PROTOCOL_VERSION } from "@hearth/protocol";

export interface BoxAgentInfo {
  /** Hub-box protocol version this agent speaks. */
  readonly protocol: string;
  /** Installed pi version; the box image labels itself with the same value (PRD §8.4). */
  readonly pi: string;
}

/** Describes this build of the box-agent. Sent to the hub in `hello` once the protocol lands. */
export function describeBoxAgent(): BoxAgentInfo {
  return { protocol: formatVersion(PROTOCOL_VERSION), pi: PI_VERSION };
}
