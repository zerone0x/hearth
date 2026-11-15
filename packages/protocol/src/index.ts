/**
 * @hearth/protocol: the hub-box wire protocol v1 (PRD §8.1–8.2).
 *
 * Pure types and encode/decode functions only: no sockets, no I/O, and never
 * a hub-local path or address. See README.md for the frame list.
 */

export {
  type DecodeError,
  type DecodeErrorCode,
  type DecodeOptions,
  type DecodeResult,
  decodeFrame,
  EncodeError,
  encodeFrame,
  MAX_ECHOED_TYPE_LENGTH,
  STREAM_DATA_HEADER_BYTES,
  STREAM_DATA_TAG,
  type WireMessage,
} from "./codec";
export { type CommandHistory, isCommand, isDuplicateCommand } from "./commands";
export {
  MAX_CREDENTIAL_LENGTH,
  MAX_ID_LENGTH,
  MAX_JSON_DEPTH,
  MAX_TEXT_LENGTH,
} from "./fields";
export * from "./frames";
export { checkHelloVersion, rejectHello } from "./handshake";
export { formatVersion, isCompatible, PROTOCOL_VERSION, type ProtocolVersion } from "./version";
export * from "./tools";
