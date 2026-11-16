/**
 * Live output of one `tool.exec` command (protocol 1.4, decision 0036).
 *
 * The command's output goes to the hub as `stream.data` frames on the stream
 * id the hub named in the call, while it runs. The stream is a preview, not
 * the answer: the `rpc.result` still carries the output, so this side is free
 * to drop bytes.
 *
 * - **Coalesced.** Chunks wait up to `intervalMs` and go out as one frame, or
 *   at once when `chunkBytes` are waiting, so a chatty command does not send
 *   a frame per pipe read.
 * - **Capped.** At most `maxBytes` per command; the rest is not streamed.
 * - **Never blocks the box.** When the hub socket's backlog is above
 *   `highWaterBytes` (a slow hub or link), waiting bytes are dropped instead of
 *   queued; nothing here waits on the hub.
 * - `end()` sends the last bytes and a `stream.close`, before the executor
 *   sends the result, so the hub sees the whole stream first.
 */

import {
  LIVE_OUTPUT_CHUNK_BYTES,
  LIVE_OUTPUT_INTERVAL_MS,
  MAX_LIVE_OUTPUT_BYTES,
  type StreamCloseFrame,
  type StreamDataFrame,
} from "@hearth/protocol";

/** Hub socket backlog above which live output is dropped rather than queued. */
export const LIVE_OUTPUT_HIGH_WATER_BYTES = 256 * 1024;

export interface LiveOutputSenderOptions {
  readonly streamId: number;
  /** Writes a frame to the hub if connected; a frame sent while disconnected is lost. */
  readonly send: (frame: StreamDataFrame | StreamCloseFrame) => void;
  /** Bytes queued on the hub socket (`WebSocket.bufferedAmount`). */
  readonly backlog: () => number;
  readonly maxBytes?: number;
  readonly intervalMs?: number;
  readonly chunkBytes?: number;
  readonly highWaterBytes?: number;
}

export class LiveOutputSender {
  readonly #o: LiveOutputSenderOptions;
  readonly #max: number;
  readonly #chunk: number;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #accepted = 0;
  #seq = 0;
  #dropped = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: LiveOutputSenderOptions) {
    this.#o = options;
    this.#max = options.maxBytes ?? MAX_LIVE_OUTPUT_BYTES;
    this.#chunk = options.chunkBytes ?? LIVE_OUTPUT_CHUNK_BYTES;
  }

  get streamId(): number {
    return this.#o.streamId;
  }

  /** Bytes dropped because the hub socket was backed up. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Frames of data sent so far. */
  get frames(): number {
    return this.#seq;
  }

  write(chunk: Buffer): void {
    if (this.#closed) return;
    const part = chunk.subarray(0, this.#max - this.#accepted);
    if (part.length === 0) return;
    this.#accepted += part.length;
    this.#pending.push(part);
    this.#pendingBytes += part.length;
    if (this.#pendingBytes >= this.#chunk) this.#flush();
    else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => this.#flush(), this.#o.intervalMs ?? LIVE_OUTPUT_INTERVAL_MS);
    }
  }

  /** The command ended: send what waits, then close the stream. */
  end(): void {
    if (this.#closed) return;
    this.#flush();
    this.#closed = true;
    this.#o.send({ type: "stream.close", streamId: this.#o.streamId, reason: "done" });
  }

  /** The hub closed the stream: stop sending, without a close of our own. */
  stop(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  #flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed || this.#pendingBytes === 0) return;
    const data = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#pendingBytes = 0;
    if (this.#o.backlog() > (this.#o.highWaterBytes ?? LIVE_OUTPUT_HIGH_WATER_BYTES)) {
      this.#dropped += data.length;
      return;
    }
    this.#o.send({
      type: "stream.data",
      streamId: this.#o.streamId,
      seq: this.#seq,
      data: new Uint8Array(data),
    });
    this.#seq += 1;
  }
}
