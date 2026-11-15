/**
 * Encode and decode frames to and from WebSocket messages.
 *
 * Wire format:
 * - `stream.data` is a binary message: byte 0 is the tag `0x01`, bytes 1–4 the
 *   stream id and bytes 5–8 the sequence number (both unsigned 32-bit,
 *   big-endian), and the rest is the payload. Bytes are never base64-encoded.
 * - Every other frame is a text message holding one JSON object with a `type`.
 *
 * `decodeFrame` never throws: malformed input yields a typed `DecodeError`.
 * Unknown fields are dropped, so a newer minor version can add optional fields
 * without breaking an older peer. A field that belongs to another variant of
 * the same frame (e.g. `path` on a `vnc` stream) is rejected, not dropped.
 */

import {
  FieldError,
  Fields,
  isObj,
  MAX_CREDENTIAL_LENGTH,
  MAX_ID_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_U32,
} from "./fields";
import {
  type BoxState,
  type DeliveryAckFrame,
  type DesktopLockFrame,
  FAILURE_DISPOSITIONS,
  FAILURE_OWNERS,
  type Failure,
  type Frame,
  type FrameType,
  type HelloFrame,
  isFrameType,
  type RejectFrame,
  type RpcResultFrame,
  type StreamDataFrame,
  type StreamOpenFrame,
  type TurnEventFrame,
} from "./frames";
import { formatVersion, isCompatible, PROTOCOL_VERSION, type ProtocolVersion } from "./version";

/** Tag byte of a binary `stream.data` message. */
export const STREAM_DATA_TAG = 0x01;
/** Bytes before the payload in a binary `stream.data` message. */
export const STREAM_DATA_HEADER_BYTES = 9;
/** Longest received `type` string, in code points, echoed back in an `unknown-type` error. */
export const MAX_ECHOED_TYPE_LENGTH = 64;

export type DecodeErrorCode =
  /** A text message that is not valid JSON. */
  | "invalid-json"
  /** Valid JSON that is not an object, or has no string `type`. */
  | "not-a-frame"
  /** A `type` this version does not know. */
  | "unknown-type"
  /** A known type with a missing or invalid field. */
  | "invalid-field"
  /** A binary message that is not a well-formed `stream.data`. */
  | "invalid-binary"
  /** A `hello` whose major version differs from ours. Its other fields are not read. */
  | "version-mismatch";

export interface DecodeError {
  readonly code: DecodeErrorCode;
  readonly message: string;
  /**
   * The frame's `type`, when it could be read. For `unknown-type` it is
   * capped at `MAX_ECHOED_TYPE_LENGTH` code points, with control and bidi
   * characters replaced by U+FFFD.
   */
  readonly frameType?: string;
  /** Dotted path of the offending field, for `invalid-field`. */
  readonly path?: string;
  /** The version the peer's `hello` named, for `version-mismatch`. */
  readonly peerVersion?: ProtocolVersion;
}

export type DecodeResult =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly error: DecodeError };

export interface DecodeOptions {
  /**
   * The version this side speaks. A `hello` with another major fails with
   * `version-mismatch`. Defaults to `PROTOCOL_VERSION`.
   */
  readonly version?: ProtocolVersion;
}

/** What a WebSocket hands over: text, or bytes in one of the usual shapes. */
export type WireMessage = string | Uint8Array | ArrayBuffer;

/**
 * Thrown by `encodeFrame` for a frame the decoder would reject, which is a
 * caller bug. `error` is what the decoder would have answered.
 */
export class EncodeError extends RangeError {
  constructor(readonly error: DecodeError) {
    super(`cannot encode ${error.frameType ?? "frame"}: ${error.message}`);
    this.name = "EncodeError";
  }
}

/**
 * Encodes a frame. Returns a string for text frames and bytes for
 * `stream.data`. It never produces a message the decoder rejects: a text
 * frame that fails validation throws `EncodeError` (a `RangeError`), and a
 * `stream.data` whose stream id or sequence number does not fit in 32 bits
 * throws `RangeError`. The version check is not applied, so a `hello` of
 * another major can still be encoded. Values JSON would silently change or
 * cannot write are refused with `EncodeError` too: a non-finite number,
 * `undefined` in an array, a `BigInt`, a function or symbol, a cycle, and any
 * object that is not a plain object or array (a `Date`, a typed array,
 * anything with `toJSON`). An `undefined` object property is omitted, as JSON
 * does, so an absent optional field may be written as `undefined`.
 */
export function encodeFrame(frame: Frame): string | Uint8Array {
  if (frame.type === "stream.data") return encodeStreamData(frame);
  // A walk before stringify, not a replacer: `JSON.stringify` calls `toJSON`
  // (a `Date` becomes a string) before a replacer sees the value, and throws a
  // plain `TypeError` for a `BigInt` or a cycle.
  refuseUnwritable(frame, frame.type, "", new Set());
  const text: string | undefined = JSON.stringify(frame);
  if (typeof text !== "string") {
    throw new EncodeError({ code: "not-a-frame", message: "frame is not JSON-serializable" });
  }
  const checked = decodeText(text, null);
  if (!checked.ok) throw new EncodeError(checked.error);
  return text;
}

/** Throws `EncodeError` for a value `JSON.stringify` would change or throw on. */
function refuseUnwritable(
  value: unknown,
  frameType: string,
  path: string,
  ancestors: Set<object>,
): void {
  const refuse = (why: string): never => {
    throw new EncodeError({
      code: "invalid-field",
      message: `${path || "frame"}: ${why}`,
      frameType,
      ...(path ? { path } : {}),
    });
  };
  if (typeof value === "number" && !Number.isFinite(value)) refuse("expected a finite number");
  if (typeof value === "bigint") refuse("expected a JSON number, not a BigInt");
  if (typeof value === "function" || typeof value === "symbol") refuse("expected JSON");
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      // A hole reads as `undefined` too; JSON writes both as `null`.
      if (value[i] === undefined) refuse(`undefined in an array at index ${i}`);
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) refuse("expected plain JSON");
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      refuse("expected plain JSON, not an object with toJSON");
    }
  }
  if (ancestors.has(value)) refuse("cyclic value");
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    refuseUnwritable(child, frameType, path ? `${path}.${key}` : key, ancestors);
  }
  ancestors.delete(value);
}

function encodeStreamData(frame: StreamDataFrame): Uint8Array {
  for (const [name, value] of [
    ["streamId", frame.streamId],
    ["seq", frame.seq],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
      throw new RangeError(`stream.data ${name} must be an unsigned 32-bit integer`);
    }
  }
  if (!(frame.data instanceof Uint8Array)) {
    throw new RangeError("stream.data data must be a Uint8Array");
  }
  const out = new Uint8Array(STREAM_DATA_HEADER_BYTES + frame.data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, STREAM_DATA_TAG);
  view.setUint32(1, frame.streamId);
  view.setUint32(5, frame.seq);
  out.set(frame.data, STREAM_DATA_HEADER_BYTES);
  return out;
}

export function decodeFrame(message: WireMessage, options: DecodeOptions = {}): DecodeResult {
  if (typeof message === "string") return decodeText(message, options.version ?? PROTOCOL_VERSION);
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  return decodeBinary(bytes);
}

function fail(error: DecodeError): DecodeResult {
  return { ok: false, error };
}

function decodeBinary(bytes: Uint8Array): DecodeResult {
  if (bytes.byteLength < STREAM_DATA_HEADER_BYTES) {
    return fail({ code: "invalid-binary", message: "binary message shorter than its header" });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint8(0);
  if (tag !== STREAM_DATA_TAG) {
    return fail({ code: "invalid-binary", message: `unknown binary tag 0x${tag.toString(16)}` });
  }
  return {
    ok: true,
    frame: {
      type: "stream.data",
      streamId: view.getUint32(1),
      seq: view.getUint32(5),
      // Copy, so the frame does not alias a buffer the transport may reuse.
      // (`Buffer#slice` would return a view, so copy explicitly.)
      data: new Uint8Array(bytes.subarray(STREAM_DATA_HEADER_BYTES)),
    },
  };
}

/**
 * Makes a received string safe to echo into an error: capped at
 * `MAX_ECHOED_TYPE_LENGTH` characters, with control and bidi characters
 * replaced by U+FFFD so the error cannot display as something else.
 */
function capType(type: string): string {
  // Count code points, not UTF-16 units, so the cut never splits a surrogate
  // pair and leaves a lone surrogate behind. Stops early on a long type.
  let end = 0;
  let codePoints = 0;
  while (end < type.length && codePoints < MAX_ECHOED_TYPE_LENGTH) {
    const codePoint = type.codePointAt(end) ?? 0;
    end += codePoint > 0xffff ? 2 : 1;
    codePoints++;
  }
  const capped = end < type.length ? `${type.slice(0, end)}…` : type;
  return capped.replace(UNSAFE_CHARS_GLOBAL, "\uFFFD");
}

function fieldFailure(error: unknown, type: string): DecodeResult {
  if (error instanceof FieldError) {
    return fail({
      code: "invalid-field",
      message: error.message,
      frameType: type,
      path: error.path,
    });
  }
  // A bug in a decoder, not bad input; still answered, never thrown.
  return fail({ code: "invalid-field", message: String(error), frameType: type });
}

/** `ours === null` skips the hello version check (used by the encoder). */
function decodeText(text: string, ours: ProtocolVersion | null): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail({ code: "invalid-json", message: "text message is not valid JSON" });
  }
  if (!isObj(parsed) || typeof parsed["type"] !== "string") {
    return fail({ code: "not-a-frame", message: "expected a JSON object with a string type" });
  }
  const type = parsed["type"];
  if (!isFrameType(type)) {
    const shown = capType(type);
    return fail({
      code: "unknown-type",
      message: `unknown frame type ${JSON.stringify(shown)}`,
      frameType: shown,
    });
  }
  if (type === "stream.data") {
    return fail({
      code: "invalid-field",
      message: "stream.data must be sent as a binary message",
      frameType: type,
    });
  }
  const fields = new Fields(parsed);
  if (type === "hello" && ours !== null) {
    // Version first: `type` and `version` are frozen across majors, the rest
    // of a hello is not, so nothing else is read before the versions match.
    let peer: ProtocolVersion;
    try {
      peer = version(fields, "version");
    } catch (error) {
      return fieldFailure(error, type);
    }
    if (!isCompatible(peer, ours)) {
      return fail({
        code: "version-mismatch",
        message:
          `hello speaks protocol ${formatVersion(peer)} but this side speaks ` +
          `${formatVersion(ours)}; major versions must match`,
        frameType: type,
        peerVersion: peer,
      });
    }
  }
  try {
    return { ok: true, frame: DECODERS[type](fields) };
  } catch (error) {
    return fieldFailure(error, type);
  }
}

// ---------------------------------------------------------------------------
// Per-type decoders. Each builds a fresh object from known fields only.

function version(f: Fields, key: string): ProtocolVersion {
  const v = f.object(key);
  return { major: v.int("major", 0, MAX_U32), minor: v.int("minor", 0, MAX_U32) };
}

function delivery(f: Fields) {
  return { bootId: f.id("bootId"), deliveryId: f.int("deliveryId", 1) };
}

function failure(f: Fields, key: string): Failure {
  const v = f.object(key);
  return {
    owner: v.oneOf("owner", FAILURE_OWNERS),
    disposition: v.oneOf("disposition", FAILURE_DISPOSITIONS),
    message: v.string("message"),
  };
}

/** `failure` is required when `outcome` is `failed` and forbidden otherwise. */
function withFailure<T extends object>(
  f: Fields,
  outcome: string,
  base: T,
): T & { failure?: Failure } {
  if (outcome === "failed") return { ...base, failure: failure(f, "failure") };
  f.absent("failure", `only allowed when outcome is "failed"`);
  return base;
}

function nullableId(f: Fields, key: string): string | null {
  return f.raw(key) === null ? null : f.id(key);
}

function boxState(f: Fields, key: string): BoxState {
  const v = f.object(key);
  const sessionId = nullableId(v, "sessionId");
  const turnId = nullableId(v, "turnId");
  if (turnId !== null && sessionId === null) v.fail("turnId", "requires a sessionId");
  return { sessionId, turnId, lastDeliveryId: v.int("lastDeliveryId", 0) };
}

function streamId(f: Fields): number {
  return f.int("streamId", 0, MAX_U32);
}

/**
 * Characters that are invisible or reorder text: C0 and C1 controls, DEL, and
 * the Unicode bidi marks, embeddings, overrides and isolates. A path holding
 * one can display as a different path than it is.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;
const UNSAFE_CHARS_GLOBAL = new RegExp(UNSAFE_PATH_CHARS.source, "g");

/** A path relative to the box workspace: no leading `/` or `\`, no drive, no `..`. */
function relativePath(f: Fields, key: string): string {
  const value = f.string(key, 4096, false);
  if (UNSAFE_PATH_CHARS.test(value)) {
    f.fail(key, "must not contain control or bidi characters");
  }
  if (/^[/\\]/.test(value) || /^[A-Za-z]:/.test(value)) {
    f.fail(key, "must be relative to the box workspace");
  }
  if (value.split(/[/\\]/).includes("..")) f.fail(key, "must not contain '..' segments");
  return value;
}

type Decoders = {
  readonly [T in Exclude<FrameType, "stream.data">]: (f: Fields) => Extract<Frame, { type: T }>;
};

const DECODERS: Decoders = {
  hello: (f): HelloFrame => ({
    type: "hello",
    version: version(f, "version"),
    boxId: f.id("boxId"),
    bootId: f.id("bootId"),
    credential: f.string("credential", MAX_CREDENTIAL_LENGTH, false),
    state: boxState(f, "state"),
  }),
  welcome: (f) => {
    const base = { type: "welcome" as const, version: version(f, "version"), boxId: f.id("boxId") };
    return f.has("credential")
      ? { ...base, credential: f.string("credential", MAX_CREDENTIAL_LENGTH, false) }
      : base;
  },
  reject: (f) => {
    const frame: {
      -readonly [K in keyof RejectFrame]: RejectFrame[K];
    } = {
      type: "reject",
      reason: f.oneOf("reason", [
        "version-mismatch",
        "bad-credential",
        "unknown-box",
        "malformed-hello",
        "internal",
      ]),
      message: f.string("message"),
    };
    if (frame.reason === "version-mismatch") {
      frame.hubVersion = version(f, "hubVersion");
      frame.boxVersion = version(f, "boxVersion");
    } else {
      f.absent("hubVersion", `only allowed when reason is "version-mismatch"`);
      f.absent("boxVersion", `only allowed when reason is "version-mismatch"`);
    }
    return frame;
  },
  "session.assign": (f) => ({
    type: "session.assign",
    sessionId: f.id("sessionId"),
    requestId: f.id("requestId"),
    resume: f.bool("resume"),
  }),
  "turn.start": (f) => ({
    type: "turn.start",
    sessionId: f.id("sessionId"),
    turnId: f.id("turnId"),
    input: f.string("input"),
  }),
  "turn.event": (f): TurnEventFrame => {
    const event = f.jsonObject("event");
    if (typeof event["kind"] !== "string" || event["kind"] === "") {
      f.fail("event", "expected a non-empty string kind");
    }
    return {
      type: "turn.event",
      ...delivery(f),
      sessionId: f.id("sessionId"),
      turnId: f.id("turnId"),
      seq: f.int("seq", 0),
      event: event as TurnEventFrame["event"],
    };
  },
  "turn.end": (f) => {
    const outcome = f.oneOf("outcome", ["completed", "failed", "cancelled"]);
    return withFailure(f, outcome, {
      type: "turn.end" as const,
      ...delivery(f),
      sessionId: f.id("sessionId"),
      turnId: f.id("turnId"),
      outcome,
    });
  },
  "session.hibernate": (f) => ({
    type: "session.hibernate",
    sessionId: f.id("sessionId"),
    requestId: f.id("requestId"),
  }),
  "hibernate.done": (f) => {
    const outcome = f.oneOf("outcome", ["hibernated", "busy", "failed"]);
    return withFailure(f, outcome, {
      type: "hibernate.done" as const,
      ...delivery(f),
      sessionId: f.id("sessionId"),
      requestId: f.id("requestId"),
      outcome,
    });
  },
  "usage.report": (f) => ({
    type: "usage.report",
    ...delivery(f),
    sessionId: f.id("sessionId"),
    turnId: f.id("turnId"),
    model: f.string("model", MAX_ID_LENGTH, false),
    inputTokens: f.int("inputTokens", 0),
    outputTokens: f.int("outputTokens", 0),
    cacheReadTokens: f.int("cacheReadTokens", 0),
    cacheWriteTokens: f.int("cacheWriteTokens", 0),
  }),
  rpc: (f) => ({
    type: "rpc",
    id: f.id("id"),
    method: f.string("method", MAX_ID_LENGTH, false),
    params: f.json("params"),
  }),
  "rpc.result": (f): RpcResultFrame => {
    const id = f.id("id");
    if (f.bool("ok")) {
      f.absent("error", "not allowed when ok is true");
      return { type: "rpc.result", id, ok: true, result: f.json("result") };
    }
    f.absent("result", "not allowed when ok is false");
    const error = f.object("error");
    return {
      type: "rpc.result",
      id,
      ok: false,
      error: { code: error.string("code", MAX_ID_LENGTH, false), message: error.string("message") },
    };
  },
  "delivery.ack": (f): DeliveryAckFrame => ({ type: "delivery.ack", ...delivery(f) }),
  "desktop.lock": (f): DesktopLockFrame => {
    const epoch = f.int("epoch", 0);
    const leaseMs = f.int("leaseMs", 0);
    if (f.raw("holder") === null) {
      if (leaseMs !== 0) f.fail("leaseMs", "must be 0 when the lock is free");
      return { type: "desktop.lock", epoch, holder: null, leaseMs };
    }
    const holder = f.object("holder");
    return {
      type: "desktop.lock",
      epoch,
      holder: {
        kind: holder.oneOf("kind", ["person", "agent", "automation"]),
        id: holder.id("id"),
      },
      leaseMs,
    };
  },
  ping: (f) => ({ type: "ping", nonce: f.int("nonce", 0, MAX_U32) }),
  pong: (f) => ({ type: "pong", nonce: f.int("nonce", 0, MAX_U32) }),
  "stream.open": (f): StreamOpenFrame => {
    const id = streamId(f);
    const kind = f.oneOf("kind", ["vnc", "file"]);
    if (kind === "vnc") {
      // `path` and `mode` belong to file streams; both are rejected alike.
      f.absent("path", "only allowed for file streams");
      f.absent("mode", "only allowed for file streams");
      return { type: "stream.open", streamId: id, kind };
    }
    return {
      type: "stream.open",
      streamId: id,
      kind,
      path: relativePath(f, "path"),
      mode: f.oneOf("mode", ["read", "write"]),
    };
  },
  "stream.close": (f) => {
    const base = {
      type: "stream.close" as const,
      streamId: streamId(f),
      reason: f.oneOf("reason", ["done", "cancelled", "error", "revoked"]),
    };
    return f.has("message") ? { ...base, message: f.string("message", MAX_TEXT_LENGTH) } : base;
  },
};
