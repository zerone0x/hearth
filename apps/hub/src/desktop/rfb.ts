/**
 * View-only filter for the browser → box half of an RFB stream (RFC 6143;
 * decision 0016). M1 shows the desktop and takes no input: the desktop lock
 * that decides who may type is M2 (PRD §8.3).
 *
 * The filter parses the client's byte stream and passes on only what a
 * viewer needs: the handshake (protocol version 3.7 or 3.8, security type
 * None, `ClientInit` forced to shared), `SetPixelFormat`, `SetEncodings`
 * (without the pseudo-encodings that would make the server push unrequested
 * updates or expect client answers) and `FramebufferUpdateRequest`. Input
 * (`KeyEvent`, `PointerEvent`, `ClientCutText`, `SetDesktopSize`, QEMU key
 * events) and the messages tied to stripped extensions are dropped. Anything
 * it cannot parse ends the stream: without a length it cannot find the next
 * message boundary, so passing bytes on would let input through.
 */

/** Client message types (RFC 6143 §7.5 and the community registry). */
export const RFB_CLIENT = {
  setPixelFormat: 0,
  setEncodings: 2,
  framebufferUpdateRequest: 3,
  keyEvent: 4,
  pointerEvent: 5,
  clientCutText: 6,
  enableContinuousUpdates: 150,
  clientFence: 248,
  setDesktopSize: 251,
  qemu: 255,
} as const;

/** Pseudo-encodings removed from `SetEncodings`: each one lets the server push or expect answers. */
export const STRIPPED_ENCODINGS: ReadonlySet<number> = new Set([
  -313, // ContinuousUpdates: the server would push updates nobody requested.
  -312, // Fence: the server would expect the client to answer fences.
  -258, // QEMU extended key events: input, which is dropped anyway.
]);

/** Most encodings a `SetEncodings` may list (noVNC sends about 20). */
export const MAX_ENCODINGS = 256;
/** Largest `ClientCutText` the filter skips; a longer one ends the stream. */
export const MAX_CUT_TEXT_BYTES = 1024 * 1024;

const VERSIONS = new Set(["RFB 003.008\n", "RFB 003.007\n"]);
const SECURITY_NONE = 1;

export class RfbViolation extends Error {}

type Phase = "version" | "security" | "client-init" | "messages" | "skip";

/** One direction's parser state. Feed it chunks in order; it returns the bytes to forward. */
export class ViewOnlyFilter {
  #phase: Phase = "version";
  #buffer = new Uint8Array(0);
  #skip = 0;
  /** Messages dropped so far (input the viewer tried to send). */
  dropped = 0;

  /**
   * Consumes `chunk` and returns the bytes the box may see, possibly empty.
   * Throws `RfbViolation` on a stream it cannot follow; the caller ends the stream.
   */
  push(chunk: Uint8Array): Uint8Array {
    const out: Uint8Array[] = [];
    let input = chunk;
    if (this.#buffer.byteLength > 0) {
      input = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      input.set(this.#buffer);
      input.set(chunk, this.#buffer.byteLength);
    }
    let at = 0;
    for (;;) {
      const rest = input.byteLength - at;
      if (this.#phase === "skip") {
        const n = Math.min(this.#skip, rest);
        at += n;
        this.#skip -= n;
        if (this.#skip > 0) break;
        this.#phase = "messages";
        continue;
      }
      const need = this.#needed(input.subarray(at));
      if (need === undefined || need > rest) break;
      const message = input.subarray(at, at + need);
      at += need;
      const forward = this.#take(message);
      if (forward !== undefined) out.push(forward);
    }
    this.#buffer = input.slice(at);
    return concat(out);
  }

  /** Bytes the next unit needs, or undefined when not enough has arrived to tell. */
  #needed(view: Uint8Array): number | undefined {
    switch (this.#phase) {
      case "version":
        return 12;
      case "security":
      case "client-init":
        return 1;
      default:
        break;
    }
    if (view.byteLength < 1) return undefined;
    const type = view[0] as number;
    switch (type) {
      case RFB_CLIENT.setPixelFormat:
        return 20;
      case RFB_CLIENT.setEncodings: {
        if (view.byteLength < 4) return undefined;
        const count = u16(view, 2);
        if (count > MAX_ENCODINGS) {
          throw new RfbViolation(`SetEncodings lists ${count} encodings (max ${MAX_ENCODINGS})`);
        }
        return 4 + 4 * count;
      }
      case RFB_CLIENT.framebufferUpdateRequest:
        return 10;
      case RFB_CLIENT.keyEvent:
        return 8;
      case RFB_CLIENT.pointerEvent:
        return 6;
      case RFB_CLIENT.clientCutText:
        // Only the 8-byte header is buffered; the text is skipped as it arrives.
        return 8;
      case RFB_CLIENT.enableContinuousUpdates:
        return 10;
      case RFB_CLIENT.clientFence: {
        if (view.byteLength < 9) return undefined;
        const length = view[8] as number;
        if (length > 64) throw new RfbViolation(`ClientFence carries ${length} bytes (max 64)`);
        return 9 + length;
      }
      case RFB_CLIENT.setDesktopSize: {
        if (view.byteLength < 8) return undefined;
        return 8 + 16 * (view[6] as number);
      }
      case RFB_CLIENT.qemu: {
        if (view.byteLength < 2) return undefined;
        if (view[1] !== 0) throw new RfbViolation(`QEMU client message subtype ${view[1]}`);
        return 12;
      }
      default:
        throw new RfbViolation(`unknown client message type ${type}`);
    }
  }

  /** Handles one complete unit; returns what to forward, if anything. */
  #take(message: Uint8Array): Uint8Array | undefined {
    switch (this.#phase) {
      case "version": {
        const text = new TextDecoder().decode(message);
        if (!VERSIONS.has(text)) {
          throw new RfbViolation(`unsupported protocol version ${JSON.stringify(text)}`);
        }
        this.#phase = "security";
        return message.slice();
      }
      case "security":
        if (message[0] !== SECURITY_NONE) {
          throw new RfbViolation(`security type ${message[0]} (only None is relayed)`);
        }
        this.#phase = "client-init";
        return message.slice();
      case "client-init":
        // Always shared: a viewer must never disconnect the desktop's other clients.
        this.#phase = "messages";
        return Uint8Array.of(1);
      default:
        break;
    }
    const type = message[0] as number;
    switch (type) {
      case RFB_CLIENT.setPixelFormat:
      case RFB_CLIENT.framebufferUpdateRequest:
        return message.slice();
      case RFB_CLIENT.setEncodings:
        return stripEncodings(message);
      case RFB_CLIENT.clientCutText: {
        // Signed: a negative length is the extended clipboard format, |length| bytes.
        const length = Math.abs(new DataView(message.buffer, message.byteOffset).getInt32(4));
        if (length > MAX_CUT_TEXT_BYTES) {
          throw new RfbViolation(`ClientCutText of ${length} bytes (max ${MAX_CUT_TEXT_BYTES})`);
        }
        this.dropped += 1;
        if (length > 0) {
          this.#skip = length;
          this.#phase = "skip";
        }
        return undefined;
      }
      default:
        this.dropped += 1;
        return undefined;
    }
  }
}

function stripEncodings(message: Uint8Array): Uint8Array {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const kept: number[] = [];
  for (let i = 0; i < u16(message, 2); i++) {
    const encoding = view.getInt32(4 + 4 * i);
    if (!STRIPPED_ENCODINGS.has(encoding)) kept.push(encoding);
  }
  const out = new Uint8Array(4 + 4 * kept.length);
  const outView = new DataView(out.buffer);
  out[0] = RFB_CLIENT.setEncodings;
  outView.setUint16(2, kept.length);
  kept.forEach((encoding, i) => outView.setInt32(4 + 4 * i, encoding));
  return out;
}

function u16(view: Uint8Array, at: number): number {
  return ((view[at] as number) << 8) | (view[at + 1] as number);
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
