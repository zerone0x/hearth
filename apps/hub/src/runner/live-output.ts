/**
 * Live output of a running `bash` call as `tool.output` events (decision 0036).
 *
 * The box streams the command's output while it runs (protocol 1.4); this
 * turns it into events the web polls. The tool result stays the answer: these
 * events are a preview the web drops once the result is in.
 *
 * - **Redacted with the runner's redactor**, the one every stored payload and
 *   tool result goes through. A secret can arrive split across chunks, so
 *   text is only emitted up to a line break (or, for a long line, up to
 *   `holdChars` before its end), never past the start of a tail that could
 *   begin a secret (`secretStart`: a proper prefix of one, raw, JSON-escaped
 *   or URL-encoded, however long the secret and whatever line breaks it holds),
 *   and only where redacting the emitted part alone gives the same text as
 *   redacting it with what follows. The held back tail waits for the next
 *   chunk; whatever is held back when the call ends is never emitted (the
 *   result has it).
 * - **Capped** at `maxBytes` of output per call; then one last event says so.
 * - **Rate limited and coalesced**: at most one append every `intervalMs`,
 *   and never two at once. Output that arrives while an append is in flight
 *   waits and goes out with the next one, so a slow store makes the events
 *   fewer and larger; it never queues work or holds up the box connection.
 * - A failed append stops this call's live output; the call goes on.
 */

import type { EventStore, SessionId, TurnId, WorkspaceScope } from "@hearth/core";
import { MAX_LIVE_OUTPUT_BYTES } from "@hearth/protocol";

/** Event type of a live output chunk. */
export const TOOL_OUTPUT_EVENT = "tool.output";
/** At most one `tool.output` event per call every this many ms. */
export const LIVE_OUTPUT_EVENT_INTERVAL_MS = 250;
/** A line longer than this is emitted in parts, holding back its last `holdChars`. */
export const LIVE_OUTPUT_LONG_LINE_CHARS = 4096;
/** Characters held back from the end of a long line, so a split secret is never half shown. */
export const LIVE_OUTPUT_HOLD_CHARS = 1024;

export interface ToolOutputPayload {
  readonly toolCallId: string;
  /** 0, 1, 2, … within the call. */
  readonly seq: number;
  /** Redacted text that follows the previous event's. */
  readonly text: string;
  /** Set on the last event once the call hit `maxBytes`. */
  readonly truncated?: true;
}

export interface LiveToolOutputOptions {
  readonly toolCallId: string;
  readonly redact: (text: string) => string;
  /**
   * Where the tail of `text` that could be the start of a secret begins
   * (`text.length` when none): nothing from there on is emitted yet.
   */
  readonly secretStart: (text: string) => number;
  readonly append: (payload: ToolOutputPayload) => Promise<unknown>;
  readonly log?: (line: string) => void;
  readonly maxBytes?: number;
  readonly intervalMs?: number;
  readonly longLineChars?: number;
  readonly holdChars?: number;
}

export class LiveToolOutput {
  readonly #o: LiveToolOutputOptions;
  readonly #max: number;
  readonly #decoder = new TextDecoder("utf-8");
  /** Decoded output not emitted yet (raw, not redacted). */
  #raw = "";
  #bytes = 0;
  #capped = false;
  #capReported = false;
  #seq = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight = false;
  #closed = false;

  constructor(options: LiveToolOutputOptions) {
    this.#o = options;
    this.#max = options.maxBytes ?? MAX_LIVE_OUTPUT_BYTES;
  }

  /** Events appended or in flight. */
  get events(): number {
    return this.#seq;
  }

  /**
   * Output bytes from the box. Never blocks and never throws. Returns false
   * once it takes no more (capped or closed), so the stream can be closed.
   */
  write(chunk: Uint8Array): boolean {
    if (this.#closed || this.#capped) return false;
    const room = this.#max - this.#bytes;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.#bytes += part.length;
    if (part.length > 0) this.#raw += this.#decoder.decode(part, { stream: true });
    if (this.#bytes >= this.#max) this.#capped = true;
    this.#schedule();
    return !this.#capped;
  }

  /** The call ended: no more events, and what is held back is dropped. */
  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#raw = "";
  }

  #schedule(): void {
    if (this.#closed || this.#timer !== undefined || this.#inFlight) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, this.#o.intervalMs ?? LIVE_OUTPUT_EVENT_INTERVAL_MS);
  }

  #flush(): void {
    if (this.#closed) return;
    const cut = this.#safeCut();
    let text = "";
    if (cut > 0) {
      text = this.#o.redact(this.#raw.slice(0, cut));
      this.#raw = this.#raw.slice(cut);
    }
    const truncated = this.#capped && !this.#capReported;
    if (text.length === 0 && !truncated) return;
    if (truncated) {
      this.#capReported = true;
      // What is held back at the cap is never completed: drop it.
      this.#raw = "";
    }
    const payload: ToolOutputPayload = {
      toolCallId: this.#o.toolCallId,
      seq: this.#seq,
      text,
      ...(truncated ? { truncated: true as const } : {}),
    };
    this.#seq += 1;
    this.#inFlight = true;
    this.#o.append(payload).then(
      () => {
        this.#inFlight = false;
        if (this.#raw.length > 0 || (this.#capped && !this.#capReported)) this.#schedule();
      },
      (error: unknown) => {
        this.#inFlight = false;
        this.#o.log?.(
          `live output of ${this.#o.toolCallId} stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.close();
      },
    );
  }

  /**
   * How much of `#raw` can be emitted now: up to the last line break, or for
   * a long line up to `holdChars` before its end; moved back to before any
   * tail that could start a secret; and only where the head redacts the same
   * alone as with the rest after it.
   */
  #safeCut(): number {
    const raw = this.#raw;
    const long = this.#o.longLineChars ?? LIVE_OUTPUT_LONG_LINE_CHARS;
    const hold = this.#o.holdChars ?? LIVE_OUTPUT_HOLD_CHARS;
    const candidates: number[] = [];
    let at = lastBreak(raw, raw.length);
    if (raw.length - at > long) candidates.push(noSplitPair(raw, raw.length - hold));
    while (at > 0 && candidates.length < 8) {
      candidates.push(at);
      at = lastBreak(raw, at - 1);
    }
    const whole = this.#o.redact(raw);
    for (const candidate of candidates) {
      const cut = this.#beforeSecret(raw, candidate);
      if (cut <= 0) continue;
      if (whole.startsWith(this.#o.redact(raw.slice(0, cut)))) return cut;
    }
    return 0;
  }

  /**
   * `cut`, moved back to where the longest tail of `raw.slice(0, cut)` that
   * could start a secret begins. No secret then spans the cut: its first part
   * would be such a tail.
   */
  #beforeSecret(raw: string, cut: number): number {
    return Math.min(cut, this.#o.secretStart(raw.slice(0, cut)));
  }
}

/** The index just after the last `\n` or `\r` before `end`, or 0. */
function lastBreak(text: string, end: number): number {
  const n = text.lastIndexOf("\n", end - 1);
  const r = text.lastIndexOf("\r", end - 1);
  return Math.max(n, r) + 1;
}

/** `cut`, moved back one when it would split a surrogate pair. */
function noSplitPair(text: string, cut: number): number {
  const code = text.charCodeAt(cut - 1);
  return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
}

/** What `liveToolOutput` needs from the runner's options. */
export interface LiveOutputRunner {
  readonly events: Pick<EventStore, "append">;
  readonly scope: WorkspaceScope;
  readonly sessionId: SessionId;
  readonly redact?: (text: string) => string;
  readonly secretStart?: (text: string) => number;
  readonly log?: (line: string) => void;
}

/** The runner's live output for one call: `tool.output` events in the session's log. */
export function liveToolOutput(
  runner: LiveOutputRunner,
  toolCallId: string,
  turnId: () => string | undefined,
): LiveToolOutput {
  return new LiveToolOutput({
    toolCallId,
    redact: runner.redact ?? ((text) => text),
    secretStart: runner.secretStart ?? ((text) => text.length),
    append: (payload) => {
      const turn = turnId();
      return runner.events.append(runner.scope, runner.sessionId, {
        type: TOOL_OUTPUT_EVENT,
        ...(turn === undefined ? {} : { turnId: turn as TurnId }),
        payload: { ...payload },
      });
    },
    ...(runner.log === undefined ? {} : { log: runner.log }),
  });
}
