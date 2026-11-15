/**
 * Frame types for the hub-box protocol v1 (PRD §8.2).
 *
 * Every frame is a plain object discriminated by `type`. The `Frame` union and
 * the `FRAME_SPECS` table below are the single list of frames: the codec, the
 * README and the tests all follow it.
 *
 * No frame carries a hub-local path or address (PRD §8.2). File streams name a
 * path relative to the box's own workspace, and the decoder rejects absolute
 * paths and `..` segments.
 */

import type { ProtocolVersion } from "./version";

/** Any JSON value. Used for opaque payloads such as pi events and RPC params. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Fields carried by every box → hub frame that must survive a hub restart
 * (PRD §8.1, principle 5). `deliveryId` is a positive integer, strictly
 * increasing within one boot of the box. The pair (`bootId`, `deliveryId`)
 * identifies a delivery; the hub applies it at most once and then acks it.
 */
export interface Delivery {
  readonly bootId: string;
  readonly deliveryId: number;
}

/** Who a failure belongs to (PRD §8.1, principle 2). */
export type FailureOwner = "box" | "model-provider" | "gateway" | "hub" | "user";

export interface Failure {
  readonly owner: FailureOwner;
  /** Whether retrying the same work may succeed. */
  readonly retryable: boolean;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Handshake

/** Box → hub, first frame on every connection. */
export interface HelloFrame {
  readonly type: "hello";
  readonly version: ProtocolVersion;
  readonly boxId: string;
  /** Random id chosen at box-agent start; a new boot starts deliveries afresh. */
  readonly bootId: string;
  /** The one-time token on first connect, then the per-box credential. */
  readonly credential: string;
}

/** Hub → box, the handshake succeeded. */
export interface WelcomeFrame {
  readonly type: "welcome";
  readonly version: ProtocolVersion;
  readonly boxId: string;
  /**
   * The per-box credential to use on later connects. Present when the box
   * connected with its one-time token.
   */
  readonly credential?: string;
}

export type RejectReason =
  | "version-mismatch"
  | "bad-credential"
  | "unknown-box"
  | "malformed-hello"
  | "internal";

/** Hub → box, the handshake failed. The hub closes the socket after sending it. */
export interface RejectFrame {
  readonly type: "reject";
  readonly reason: RejectReason;
  /** Human-readable; for `version-mismatch` it names both versions. */
  readonly message: string;
  /** Set for `version-mismatch`. */
  readonly hubVersion?: ProtocolVersion;
  /** Set for `version-mismatch`. */
  readonly boxVersion?: ProtocolVersion;
}

// ---------------------------------------------------------------------------
// Sessions and turns

/** Hub → box: run this session in the box (fresh or restored from hibernation). */
export interface SessionAssignFrame {
  readonly type: "session.assign";
  readonly sessionId: string;
  /** `true` when the session is being restored rather than started. */
  readonly resume: boolean;
}

/** Hub → box: start a turn with this user input. */
export interface TurnStartFrame {
  readonly type: "turn.start";
  readonly sessionId: string;
  readonly turnId: string;
  readonly input: string;
}

/** Box → hub: one event of a running turn. `seq` orders events within the turn. */
export interface TurnEventFrame extends Delivery {
  readonly type: "turn.event";
  readonly sessionId: string;
  readonly turnId: string;
  readonly seq: number;
  /** The Hearth event; opaque to the protocol beyond being a JSON object with a `kind`. */
  readonly event: JsonObject & { readonly kind: string };
}

export type TurnOutcome = "completed" | "failed" | "cancelled";

/** Box → hub: the turn ended. Every turn ends in exactly one of these (principle 1). */
export interface TurnEndFrame extends Delivery {
  readonly type: "turn.end";
  readonly sessionId: string;
  readonly turnId: string;
  readonly outcome: TurnOutcome;
  /** Required when `outcome` is `failed`, absent otherwise. */
  readonly failure?: Failure;
}

/** Hub → box: hibernate this session. Answered by exactly one `hibernate.done`. */
export interface SessionHibernateFrame {
  readonly type: "session.hibernate";
  readonly sessionId: string;
  readonly requestId: string;
}

/** The fixed set of hibernate answers (principle 6). */
export type HibernateOutcome = "hibernated" | "busy" | "failed";

/** Box → hub: the answer to `session.hibernate`. */
export interface HibernateDoneFrame extends Delivery {
  readonly type: "hibernate.done";
  readonly sessionId: string;
  readonly requestId: string;
  readonly outcome: HibernateOutcome;
  /** Required when `outcome` is `failed`, absent otherwise. */
  readonly failure?: Failure;
}

/** Box → hub: model usage of one model call, for budgets and the retro. */
export interface UsageReportFrame extends Delivery {
  readonly type: "usage.report";
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

// ---------------------------------------------------------------------------
// RPC

/** Either side: a request. The caller times it out with its own named deadline. */
export interface RpcFrame {
  readonly type: "rpc";
  readonly id: string;
  readonly method: string;
  readonly params: JsonValue;
}

export interface RpcError {
  readonly code: string;
  readonly message: string;
}

/** Either side: the answer to an `rpc` with the same `id`. Exactly one of result or error. */
export type RpcResultFrame =
  | {
      readonly type: "rpc.result";
      readonly id: string;
      readonly ok: true;
      readonly result: JsonValue;
    }
  | {
      readonly type: "rpc.result";
      readonly id: string;
      readonly ok: false;
      readonly error: RpcError;
    };

// ---------------------------------------------------------------------------
// Delivery

/** Hub → box: the delivery was applied (written to the EventStore), not merely received. */
export interface DeliveryAckFrame extends Delivery {
  readonly type: "delivery.ack";
}

// ---------------------------------------------------------------------------
// Desktop

export type DesktopHolderKind = "person" | "agent" | "automation";

export interface DesktopHolder {
  readonly kind: DesktopHolderKind;
  readonly id: string;
}

/**
 * Hub → box: the current desktop lock (PRD §8.3). `holder: null` means free.
 * `leaseMs` is a duration, not a timestamp, so the box never compares clocks
 * with the hub; the box stops trusting the grant slightly before it runs out.
 * `epoch` increases with every change, so a stale frame can be ignored.
 */
export interface DesktopLockFrame {
  readonly type: "desktop.lock";
  readonly epoch: number;
  readonly holder: DesktopHolder | null;
  readonly leaseMs: number;
}

// ---------------------------------------------------------------------------
// Liveness

export interface PingFrame {
  readonly type: "ping";
  readonly nonce: number;
}

export interface PongFrame {
  readonly type: "pong";
  readonly nonce: number;
}

// ---------------------------------------------------------------------------
// Byte streams

export type StreamKind = "vnc" | "file";

/**
 * Either side: open a byte stream. Stream ids are unsigned 32-bit integers.
 * To avoid collisions the hub opens even ids and the box opens odd ids.
 */
export type StreamOpenFrame =
  | { readonly type: "stream.open"; readonly streamId: number; readonly kind: "vnc" }
  | {
      readonly type: "stream.open";
      readonly streamId: number;
      readonly kind: "file";
      /** Relative to the box workspace. Never absolute, never contains `..`. */
      readonly path: string;
      /** `read` streams bytes from the box, `write` streams bytes into it. */
      readonly mode: "read" | "write";
    };

/** Either side: bytes of an open stream. `seq` starts at 0 and increases by 1. */
export interface StreamDataFrame {
  readonly type: "stream.data";
  readonly streamId: number;
  readonly seq: number;
  readonly data: Uint8Array;
}

export type StreamCloseReason = "done" | "cancelled" | "error" | "revoked";

/** Either side: the stream is finished. No `stream.data` follows for this id. */
export interface StreamCloseFrame {
  readonly type: "stream.close";
  readonly streamId: number;
  readonly reason: StreamCloseReason;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Unions

export type Frame =
  | HelloFrame
  | WelcomeFrame
  | RejectFrame
  | SessionAssignFrame
  | TurnStartFrame
  | TurnEventFrame
  | TurnEndFrame
  | SessionHibernateFrame
  | HibernateDoneFrame
  | UsageReportFrame
  | RpcFrame
  | RpcResultFrame
  | DeliveryAckFrame
  | DesktopLockFrame
  | PingFrame
  | PongFrame
  | StreamOpenFrame
  | StreamDataFrame
  | StreamCloseFrame;

export type FrameType = Frame["type"];

export type FrameOf<T extends FrameType> = Extract<Frame, { type: T }>;

/** Box → hub frames that carry a delivery and wait for `delivery.ack`. */
export type ReliableFrame = TurnEventFrame | TurnEndFrame | HibernateDoneFrame | UsageReportFrame;

export type Direction = "box-to-hub" | "hub-to-box" | "both";

/**
 * - `at-least-once`: the box buffers the frame, redelivers it after a
 *   reconnect until it gets `delivery.ack`, and the hub applies it idempotently.
 * - `fire-and-forget`: sent once; lost if the connection drops. Recovery, if
 *   any, comes from the layer above (handshake retry, the hub's state machine,
 *   an RPC deadline, reopening a stream).
 */
export type Guarantee = "at-least-once" | "fire-and-forget";

export interface FrameSpec {
  readonly direction: Direction;
  readonly guarantee: Guarantee;
}

/** Direction and delivery guarantee of every frame type. The README mirrors this table. */
export const FRAME_SPECS: { readonly [T in FrameType]: FrameSpec } = {
  hello: { direction: "box-to-hub", guarantee: "fire-and-forget" },
  welcome: { direction: "hub-to-box", guarantee: "fire-and-forget" },
  reject: { direction: "hub-to-box", guarantee: "fire-and-forget" },
  "session.assign": { direction: "hub-to-box", guarantee: "fire-and-forget" },
  "turn.start": { direction: "hub-to-box", guarantee: "fire-and-forget" },
  "turn.event": { direction: "box-to-hub", guarantee: "at-least-once" },
  "turn.end": { direction: "box-to-hub", guarantee: "at-least-once" },
  "session.hibernate": { direction: "hub-to-box", guarantee: "fire-and-forget" },
  "hibernate.done": { direction: "box-to-hub", guarantee: "at-least-once" },
  "usage.report": { direction: "box-to-hub", guarantee: "at-least-once" },
  rpc: { direction: "both", guarantee: "fire-and-forget" },
  "rpc.result": { direction: "both", guarantee: "fire-and-forget" },
  "delivery.ack": { direction: "hub-to-box", guarantee: "fire-and-forget" },
  "desktop.lock": { direction: "hub-to-box", guarantee: "fire-and-forget" },
  ping: { direction: "both", guarantee: "fire-and-forget" },
  pong: { direction: "both", guarantee: "fire-and-forget" },
  "stream.open": { direction: "both", guarantee: "fire-and-forget" },
  "stream.data": { direction: "both", guarantee: "fire-and-forget" },
  "stream.close": { direction: "both", guarantee: "fire-and-forget" },
};

export const FRAME_TYPES = Object.keys(FRAME_SPECS) as readonly FrameType[];

export function isFrameType(value: string): value is FrameType {
  return Object.hasOwn(FRAME_SPECS, value);
}

/** True for frames the box must buffer until the hub acks them. */
export function isReliable(frame: Frame): frame is ReliableFrame {
  return FRAME_SPECS[frame.type].guarantee === "at-least-once";
}
