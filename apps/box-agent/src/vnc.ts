/**
 * The box end of the desktop stream (PRD §8.2, §11.1 item 4; decision 0016).
 *
 * On a hub `stream.open` of kind `vnc`, the relay connects to the box's own
 * Xvnc on loopback (no password: only processes in the box reach it, see
 * `image/entrypoint.sh`) and relays RFB bytes both ways over `stream.data`.
 *
 * Bounded both ways:
 * - Xvnc → hub: while the hub socket has more than `VNC_HIGH_WATER_BYTES`
 *   queued, the relay stops reading Xvnc (TCP backpressure reaches Xvnc), and
 *   resumes below `VNC_LOW_WATER_BYTES`.
 * - hub → Xvnc: bytes Xvnc has not taken yet are capped at
 *   `VNC_INBOUND_LIMIT_BYTES`; past it the stream is closed with `error`.
 *   A view-only hub sends only small RFB requests, so the cap is never close.
 */

import { createConnection, type Socket } from "node:net";
import type { Frame, StreamCloseReason, StreamDataFrame, StreamOpenFrame } from "@hearth/protocol";

/** Where Xvnc listens in the box image (`HEARTH_VNC_PORT`, `-localhost`). */
export const DEFAULT_VNC_HOST = "127.0.0.1";
export const DEFAULT_VNC_PORT = 5901;
/** Largest `stream.data` payload the relay sends; larger reads are split. */
export const VNC_CHUNK_BYTES = 64 * 1024;
/** Hub socket backlog above which the relay stops reading Xvnc. */
export const VNC_HIGH_WATER_BYTES = 1024 * 1024;
/** Backlog below which a paused relay reads again. */
export const VNC_LOW_WATER_BYTES = 256 * 1024;
/** Bytes from the hub that Xvnc has not taken yet; more closes the stream. */
export const VNC_INBOUND_LIMIT_BYTES = 256 * 1024;
/** How often a paused relay looks at the hub socket backlog. */
export const VNC_DRAIN_POLL_MS = 10;
/** Desktop streams open at once; one more is refused. */
export const MAX_VNC_STREAMS = 8;

/** The part of a `node:net` socket the relay uses; tests pass their own. */
export type VncSocket = Pick<
  Socket,
  "write" | "pause" | "resume" | "destroy" | "on" | "writableLength"
>;

export interface VncRelayOptions {
  /** Sends a frame to the hub; only called while the hub connection is open. */
  readonly send: (frame: Frame) => void;
  /** Bytes queued on the hub socket (`WebSocket.bufferedAmount`). */
  readonly backlog: () => number;
  readonly host?: string;
  readonly port?: number;
  /** Opens the TCP connection to Xvnc. Tests replace it. */
  readonly connect?: (host: string, port: number) => VncSocket;
  readonly log?: (line: string) => void;
  readonly highWaterBytes?: number;
  readonly lowWaterBytes?: number;
  readonly inboundLimitBytes?: number;
  readonly chunkBytes?: number;
}

interface RelayStream {
  readonly id: number;
  readonly socket: VncSocket;
  /** Next `seq` the relay sends. */
  sendSeq: number;
  /** Next `seq` the relay expects from the hub. */
  recvSeq: number;
  paused: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  closed: boolean;
}

export class VncRelay {
  readonly #options: VncRelayOptions;
  readonly #log: (line: string) => void;
  readonly #streams = new Map<number, RelayStream>();
  readonly #high: number;
  readonly #low: number;
  readonly #inboundLimit: number;
  readonly #chunk: number;

  constructor(options: VncRelayOptions) {
    this.#options = options;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#high = options.highWaterBytes ?? VNC_HIGH_WATER_BYTES;
    this.#low = options.lowWaterBytes ?? VNC_LOW_WATER_BYTES;
    this.#inboundLimit = options.inboundLimitBytes ?? VNC_INBOUND_LIMIT_BYTES;
    this.#chunk = options.chunkBytes ?? VNC_CHUNK_BYTES;
  }

  /** Open desktop streams. */
  get size(): number {
    return this.#streams.size;
  }

  /** Handles a hub `stream.open`. Anything but a fresh, even-id `vnc` stream is closed with `error`. */
  open(frame: StreamOpenFrame): void {
    const id = frame.streamId;
    if (frame.kind !== "vnc") {
      this.#refuse(id, `${frame.kind} streams are not served by this box-agent`);
      return;
    }
    if (id % 2 !== 0) {
      this.#refuse(id, "the hub opens even stream ids");
      return;
    }
    if (this.#streams.has(id)) {
      this.#refuse(id, `stream ${id} is already open`);
      return;
    }
    if (this.#streams.size >= MAX_VNC_STREAMS) {
      this.#refuse(id, `at most ${MAX_VNC_STREAMS} desktop streams may be open`);
      return;
    }
    const host = this.#options.host ?? DEFAULT_VNC_HOST;
    const port = this.#options.port ?? DEFAULT_VNC_PORT;
    const connect =
      this.#options.connect ?? ((h: string, p: number) => createConnection({ host: h, port: p }));
    let socket: VncSocket;
    try {
      socket = connect(host, port);
    } catch (error) {
      this.#refuse(id, `cannot reach the desktop: ${String(error)}`);
      return;
    }
    const stream: RelayStream = {
      id,
      socket,
      sendSeq: 0,
      recvSeq: 0,
      paused: false,
      timer: undefined,
      closed: false,
    };
    this.#streams.set(id, stream);
    socket.on("data", (chunk: Buffer) => this.#fromDesktop(stream, chunk));
    socket.on("error", (error: Error) => {
      this.#finish(stream, "error", `desktop connection failed: ${error.message}`);
    });
    socket.on("close", () => this.#finish(stream, "done", "the desktop closed the connection"));
  }

  /** Handles a hub `stream.data`. Returns false when the frame is not for a relay stream. */
  data(frame: StreamDataFrame): boolean {
    const stream = this.#streams.get(frame.streamId);
    if (stream === undefined) return false;
    if (frame.seq !== stream.recvSeq) {
      this.#finish(stream, "error", `expected seq ${stream.recvSeq}, got ${frame.seq}`);
      return true;
    }
    stream.recvSeq += 1;
    if (stream.socket.writableLength + frame.data.byteLength > this.#inboundLimit) {
      this.#finish(
        stream,
        "error",
        `more than ${this.#inboundLimit} bytes for the desktop are waiting`,
      );
      return true;
    }
    stream.socket.write(frame.data);
    return true;
  }

  /** Handles a hub `stream.close`: drop the desktop connection, send nothing back. */
  close(streamId: number): boolean {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return false;
    this.#drop(stream);
    return true;
  }

  /** The hub connection is gone: drop every desktop connection without a frame. */
  closeAll(): void {
    for (const stream of [...this.#streams.values()]) this.#drop(stream);
  }

  #fromDesktop(stream: RelayStream, chunk: Uint8Array): void {
    if (stream.closed) return;
    for (let at = 0; at < chunk.byteLength; at += this.#chunk) {
      const data = chunk.subarray(at, Math.min(at + this.#chunk, chunk.byteLength));
      this.#options.send({ type: "stream.data", streamId: stream.id, seq: stream.sendSeq, data });
      stream.sendSeq = (stream.sendSeq + 1) >>> 0;
    }
    if (!stream.paused && this.#options.backlog() > this.#high) {
      stream.paused = true;
      stream.socket.pause();
      stream.timer = setInterval(() => {
        if (this.#options.backlog() > this.#low) return;
        clearInterval(stream.timer);
        stream.timer = undefined;
        stream.paused = false;
        if (!stream.closed) stream.socket.resume();
      }, VNC_DRAIN_POLL_MS);
    }
  }

  #refuse(streamId: number, message: string): void {
    this.#log(`box-agent: refused stream ${streamId}: ${message}`);
    this.#options.send({ type: "stream.close", streamId, reason: "error", message });
  }

  /** The desktop side ended: tell the hub once, then forget the stream. */
  #finish(stream: RelayStream, reason: StreamCloseReason, message: string): void {
    if (stream.closed) return;
    this.#drop(stream);
    this.#options.send({ type: "stream.close", streamId: stream.id, reason, message });
  }

  #drop(stream: RelayStream): void {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.timer);
    this.#streams.delete(stream.id);
    stream.socket.destroy();
  }
}
