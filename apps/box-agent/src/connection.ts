/**
 * The box end of the hub-box connection (PRD §8.1 principle 5, §8.2).
 *
 * The box dials the hub over one WebSocket, sends `hello` with its one-time
 * join token, and keeps the per-box credential from `welcome` for every later
 * connect. After each handshake it redelivers every unacked frame of its
 * outbox. A dropped connection is retried with exponential backoff and jitter;
 * a `reject` that retrying cannot fix ends the agent with the hub's reason.
 */

import { randomUUID } from "node:crypto";
import { HearthError, Logger } from "@hearth/core";
import {
  type CommandHistory,
  decodeFrame,
  encodeFrame,
  type Frame,
  isDuplicateCommand,
  PROTOCOL_VERSION,
  type ProtocolVersion,
  type RejectReason,
  type ReliableFrame,
} from "@hearth/protocol";
import { type OutboundFrame, Outbox } from "./outbox";
import { ToolExecutor, type ToolExecutorOptions } from "./tools/executor";
import { VncRelay, type VncRelayOptions } from "./vnc";

/** First reconnect delay; it doubles per failed attempt up to `RECONNECT_MAX_MS`. */
export const RECONNECT_BASE_MS = 250;
/** Cap of the reconnect delay. */
export const RECONNECT_MAX_MS = 10_000;
/** A connection that gets no `welcome` or `reject` within this time is dropped and retried. */
export const HANDSHAKE_DEADLINE_MS = 10_000;

/**
 * Reject reasons that retrying with the same credential cannot fix: the agent
 * stops and reports them. `internal` is the hub's own trouble and is retried.
 */
const FATAL_REJECTS: ReadonlySet<RejectReason> = new Set([
  "version-mismatch",
  "bad-credential",
  "unknown-box",
  "malformed-hello",
]);

/**
 * The delay before reconnect attempt `attempt` (0-based): "equal jitter", half
 * of the capped exponential delay plus a random share of the other half, so
 * boxes that lost the hub together do not all dial back at once, and the delay
 * never collapses to zero.
 */
export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
  baseMs = RECONNECT_BASE_MS,
  maxMs = RECONNECT_MAX_MS,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(cap / 2 + random() * (cap / 2));
}

export interface BoxAgentOptions {
  /** The hub's box socket URL (`ws://…/v1/box/socket`). */
  readonly hubUrl: string;
  readonly boxId: string;
  /** The one-time join token from the boot environment. */
  readonly joinToken: string;
  readonly bootId?: string;
  /** Protocol version sent in `hello`. Only tests change it. */
  readonly version?: ProtocolVersion;
  readonly outboxLimit?: number;
  readonly random?: () => number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly log?: (line: string) => void;
  /** The tool executor's settings; without them, tool methods are refused. */
  readonly tools?: Omit<ToolExecutorOptions, "send" | "log">;
  /** Where the desktop relay finds Xvnc, and its bounds (decision 0016). Tests change them. */
  readonly vnc?: Omit<VncRelayOptions, "send" | "backlog" | "log">;
}

/** How the agent ended: stopped on request, or refused by the hub for good. */
export type AgentExit =
  | { readonly kind: "stopped" }
  | { readonly kind: "rejected"; readonly reason: RejectReason; readonly message: string };

type Phase = "idle" | "connecting" | "handshake" | "open" | "waiting" | "ended";

export class BoxAgent {
  readonly bootId: string;
  readonly outbox: Outbox;
  readonly done: Promise<AgentExit>;
  readonly #options: BoxAgentOptions;
  readonly #log: (line: string) => void;
  readonly #history = {
    assignRequestIds: new Set<string>(),
    turnIds: new Set<string>(),
    hibernateRequestIds: new Set<string>(),
  } satisfies CommandHistory;
  #finish!: (exit: AgentExit) => void;
  #phase: Phase = "idle";
  #socket: WebSocket | undefined;
  #credential: string;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sessionId: string | null = null;
  #connects = 0;
  readonly #tools: ToolExecutor | undefined;
  readonly #vnc: VncRelay;

  constructor(options: BoxAgentOptions) {
    this.#options = options;
    this.#log = options.log ?? ((line) => console.error(line));
    this.bootId = options.bootId ?? `boot_${randomUUID()}`;
    this.outbox = new Outbox(this.bootId, options.outboxLimit);
    this.#credential = options.joinToken;
    this.done = new Promise((resolve) => {
      this.#finish = resolve;
    });
    this.#tools =
      options.tools === undefined
        ? undefined
        : new ToolExecutor({
            ...options.tools,
            log: this.#log,
            // One JSON line per tool call with the hub's trace ids (decision 0021).
            logger: options.tools.logger ?? new Logger({ component: "box-agent.tools" }),
            // An answer written while disconnected is lost; the hub re-sends the
            // call on the same boot and the executor answers it again.
            send: (frame) => {
              if (this.#phase === "open") this.#write(frame);
            },
          });
    this.#vnc = new VncRelay({
      ...options.vnc,
      log: this.#log,
      // Desktop bytes are not redelivered: a stream ends with its connection.
      send: (frame) => {
        if (this.#phase === "open") this.#write(frame);
      },
      backlog: () => this.#socket?.bufferedAmount ?? 0,
    });
  }

  /** Open desktop streams (decision 0016). */
  get desktopStreams(): number {
    return this.#vnc.size;
  }

  /** True between `welcome` and the next disconnect. */
  get connected(): boolean {
    return this.#phase === "open";
  }

  /** How many handshakes succeeded so far. */
  get connects(): number {
    return this.#connects;
  }

  start(): void {
    if (this.#phase !== "idle") return;
    this.#dial();
  }

  stop(): void {
    this.#end({ kind: "stopped" });
  }

  /**
   * Queue an at-least-once frame. It is sent now when connected, and
   * redelivered after every reconnect until the hub acks it. Throws
   * `outbox.full` when the outbox is at its limit.
   */
  send(frame: OutboundFrame): ReliableFrame {
    const stamped = this.outbox.enqueue(frame);
    if (this.#phase === "open") this.#write(stamped);
    return stamped;
  }

  #dial(): void {
    if (this.#phase === "ended") return;
    this.#phase = "connecting";
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#options.hubUrl);
    } catch (error) {
      this.#retry(`cannot dial: ${String(error)}`);
      return;
    }
    this.#socket = socket;
    let lastError: string | undefined;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#phase = "handshake";
      this.#timer = setTimeout(() => {
        this.#log("box-agent: no answer to hello within the deadline");
        socket.close();
      }, HANDSHAKE_DEADLINE_MS);
      this.#write({
        type: "hello",
        version: this.#options.version ?? PROTOCOL_VERSION,
        boxId: this.#options.boxId,
        bootId: this.bootId,
        credential: this.#credential,
        state: {
          sessionId: this.#sessionId,
          turnId: null,
          lastDeliveryId: this.outbox.lastDeliveryId,
        },
      });
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.#onMessage(event.data as string | ArrayBuffer);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      clearTimeout(this.#timer);
      this.#vnc.closeAll();
      if (this.#phase === "ended") return;
      const lost = this.#phase === "open";
      const how = lost
        ? "connection lost"
        : this.#phase === "handshake"
          ? "closed before welcome"
          : "could not connect";
      const detail = [`code ${event.code}`, event.reason, lastError].filter(Boolean).join(", ");
      this.#retry(`${how} (${detail})`, lost);
    });
    socket.addEventListener("error", (event) => {
      // A `close` event follows; the retry, and its log line, happen there.
      lastError = (event as ErrorEvent).message || undefined;
    });
  }

  /**
   * Schedule the next dial. Every failed attempt is logged with its number,
   * the delay before the next one and why it failed, so an unreachable hub is
   * never retried silently (PRD §8.1 principle 1). The delay is capped at
   * `RECONNECT_MAX_MS`, which bounds the log to a few lines a minute.
   */
  #retry(reason: string, lost = false): void {
    if (this.#phase === "ended") return;
    this.#phase = "waiting";
    const delay = reconnectDelay(
      this.#attempt,
      this.#options.random,
      this.#options.reconnectBaseMs,
      this.#options.reconnectMaxMs,
    );
    this.#attempt += 1;
    this.#log(
      lost
        ? `box-agent: ${reason} to ${this.#options.hubUrl}; reconnecting in ${delay} ms`
        : `box-agent: dial attempt ${this.#attempt} to ${this.#options.hubUrl} failed: ${reason}; next attempt in ${delay} ms`,
    );
    this.#timer = setTimeout(() => this.#dial(), delay);
  }

  /**
   * Queue the answer to a hub command. The caller records the command id in
   * its history only when this returns `true`, so a command whose answer was
   * never queued is not mistaken for a duplicate: the hub re-sends any command
   * whose effect it has not seen (decision 0005), and that re-send is applied.
   * A full outbox is logged by name, never dropped silently (PRD §8.1
   * principle 1). Any other error is a bug and is rethrown.
   */
  #answer(command: string, frame: OutboundFrame): boolean {
    try {
      this.send(frame);
      return true;
    } catch (error) {
      if (!(error instanceof HearthError) || error.code !== "outbox.full") throw error;
      this.#log(
        `box-agent: refused ${command}: its ${frame.type} could not be queued (${error.code}: ${error.message}); a re-send from the hub will be applied`,
      );
      return false;
    }
  }

  #write(frame: Frame): void {
    this.#socket?.send(encodeFrame(frame));
  }

  #end(exit: AgentExit): void {
    if (this.#phase === "ended") return;
    this.#phase = "ended";
    clearTimeout(this.#timer);
    this.#tools?.abortAll();
    this.#vnc.closeAll();
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.#finish(exit);
  }

  #onMessage(data: string | ArrayBuffer): void {
    const decoded = decodeFrame(data);
    if (!decoded.ok) {
      this.#log(
        `box-agent: dropped an undecodable frame (${decoded.error.code}: ${decoded.error.message})`,
      );
      return;
    }
    const frame = decoded.frame;
    if (this.#phase === "handshake") {
      if (frame.type === "welcome") {
        clearTimeout(this.#timer);
        if (frame.credential !== undefined) this.#credential = frame.credential;
        this.#phase = "open";
        this.#attempt = 0;
        this.#connects += 1;
        this.#log(`box-agent: connected (boot ${this.bootId}, ${this.outbox.size} to redeliver)`);
        for (const pending of this.outbox.pending()) this.#write(pending);
        return;
      }
      if (frame.type === "reject") {
        clearTimeout(this.#timer);
        this.#log(`box-agent: the hub rejected the connection (${frame.reason}): ${frame.message}`);
        if (FATAL_REJECTS.has(frame.reason)) {
          this.#end({ kind: "rejected", reason: frame.reason, message: frame.message });
        }
        return;
      }
      this.#log(`box-agent: ignored ${frame.type} before welcome`);
      return;
    }
    if (this.#phase !== "open") return;
    switch (frame.type) {
      case "delivery.ack":
        this.outbox.ack(frame.bootId, frame.deliveryId);
        return;
      case "rpc":
        if (frame.method === "echo") {
          this.#write({ type: "rpc.result", id: frame.id, ok: true, result: frame.params });
        } else if (this.#tools?.handles(frame.method)) {
          this.#tools.handle(frame);
        } else {
          this.#write({
            type: "rpc.result",
            id: frame.id,
            ok: false,
            error: { code: "unknown-method", message: `the box has no method ${frame.method}` },
          });
        }
        return;
      case "ping":
        this.#write({ type: "pong", nonce: frame.nonce });
        return;
      case "stream.open":
        this.#vnc.open(frame);
        return;
      case "stream.data":
        if (!this.#vnc.data(frame)) {
          this.#log(`box-agent: dropped stream.data for unknown stream ${frame.streamId}`);
        }
        return;
      case "stream.close":
        this.#vnc.close(frame.streamId);
        return;
      case "session.assign":
        if (isDuplicateCommand(this.#history, frame)) return;
        this.#history.assignRequestIds.add(frame.requestId);
        this.#sessionId = frame.sessionId;
        return;
      case "turn.start":
        if (isDuplicateCommand(this.#history, frame)) return;
        // pi is wired in M1. Until then every turn ends visibly, never silently
        // (PRD §8.1 principle 1).
        if (
          !this.#answer(`turn.start ${frame.turnId}`, {
            type: "turn.end",
            sessionId: frame.sessionId,
            turnId: frame.turnId,
            outcome: "failed",
            failure: {
              owner: "box",
              disposition: "give-up",
              message: "this box-agent cannot run turns yet",
            },
          })
        ) {
          return;
        }
        this.#history.turnIds.add(frame.turnId);
        return;
      case "session.hibernate":
        if (isDuplicateCommand(this.#history, frame)) return;
        if (
          !this.#answer(`session.hibernate ${frame.requestId}`, {
            type: "hibernate.done",
            sessionId: frame.sessionId,
            requestId: frame.requestId,
            outcome: "failed",
            failure: {
              owner: "box",
              disposition: "give-up",
              message: "this box-agent cannot hibernate yet",
            },
          })
        ) {
          return;
        }
        this.#history.hibernateRequestIds.add(frame.requestId);
        return;
      default:
        return;
    }
  }
}
