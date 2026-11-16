/**
 * The hub end of the hub-box connection (PRD §8.1 principle 5, §8.2).
 *
 * One WebSocket per box, opened by the box. The first frame must be `hello`:
 * the hub checks its version, authenticates its credential (a one-time join
 * token, exchanged for a per-box credential sent back in `welcome`, or that
 * credential), calls `authorize`, and only then reads or changes anything.
 *
 * At-least-once frames are applied through the `EventStore` and acked only
 * after the append resolved (ack on apply). A frame that cannot be applied is
 * never acked; the hub closes the socket, so the box redelivers it after it
 * reconnects. The store's idempotent append makes the redelivery a no-op when
 * the first apply did land.
 */

import {
  type Authorizer,
  type BoxId,
  type Decision,
  type EventStore,
  HearthError,
  type JsonValue,
  type Principal,
  type Resource,
} from "@hearth/core";
import {
  checkHelloVersion,
  decodeFrame,
  EncodeError,
  encodeFrame,
  type Frame,
  Heartbeat,
  type HeartbeatClock,
  type HeartbeatSettings,
  type HelloFrame,
  PROTOCOL_VERSION,
  type RejectFrame,
  type ReliableFrame,
  type RpcFrame,
  type RpcResultFrame,
  rejectHello,
  type StreamCloseFrame,
  type StreamDataFrame,
  type StreamOpenFrame,
  type WireMessage,
} from "@hearth/protocol";
import { bodyOf, type RequestBody } from "../request-body";
import {
  BOX_CREDENTIAL_PREFIX,
  type BoxBinding,
  type BoxCredentialStore,
  JOIN_TOKEN_PREFIX,
} from "./credentials";

/** Path of the box WebSocket endpoint on the hub. */
export const BOX_SOCKET_PATH = "/v1/box/socket";

/** A connection that sends no valid `hello` within this time is closed. */
export const HELLO_DEADLINE_MS = 10_000;

/** Deadline of the `echo` RPC: the box answers it without doing any work. */
export const ECHO_DEADLINE_MS = 5_000;

/** WebSocket close codes the hub uses (4000–4999 is the application range). */
export const CLOSE_CODES = {
  /** The handshake was refused; a `reject` frame said why. */
  rejected: 4001,
  /** A newer connection of the same box replaced this one. */
  superseded: 4002,
  /** A frame could not be applied; the box redelivers after reconnect. */
  applyFailed: 4003,
  /** No `hello` arrived within `HELLO_DEADLINE_MS`. */
  helloTimeout: 4004,
  /** No frame arrived for `maxMisses` heartbeats (decision 0028). */
  heartbeatTimeout: 4005,
  /** The hub is shutting down. */
  shutdown: 1001,
} as const;

/** The socket operations the handler needs; Bun's `ServerWebSocket` has them. */
export interface BoxSocket {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
  /**
   * Drop the connection without a closing handshake. A dead path never
   * answers one, so a connection declared dead is terminated, not closed.
   */
  terminate?(): void;
}

/** The repeating timer `setInterval` gives; heartbeats use it outside tests. */
export const SYSTEM_HEARTBEAT_CLOCK: HeartbeatClock = {
  every(ms, beat) {
    const timer = setInterval(beat, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/** Event type the hub appends to a session's log when its box connection dies. */
export const CONNECTION_DEAD_EVENT = "box.connection-dead";

/** Reported after each applied delivery, before its ack is sent. */
export interface AppliedDelivery {
  readonly boxId: BoxId;
  readonly bootId: string;
  readonly deliveryId: number;
  readonly seq: number;
  readonly duplicate: boolean;
}

export interface BoxConnectionsOptions {
  readonly authorizer: Authorizer;
  readonly events: EventStore;
  readonly credentials: BoxCredentialStore;
  readonly log?: (line: string) => void;
  /** Observes every applied delivery before it is acked (logging, tests). */
  readonly onApplied?: (applied: AppliedDelivery) => void;
  /** Deadline of the `echo` RPC. Defaults to `ECHO_DEADLINE_MS`; tests shorten it. */
  readonly echoDeadlineMs?: number;
  /**
   * The hub's heartbeat on each open connection (decision 0028): interval,
   * misses before the connection is dead, and its clock. Tests inject the clock.
   */
  readonly heartbeat?: HeartbeatSettings & { readonly clock?: HeartbeatClock };
}

/** Why a connection was declared dead. */
export interface ConnectionDeath {
  /** Consecutive heartbeats that heard nothing. */
  readonly misses: number;
  readonly intervalMs: number;
}

/**
 * Observes box connections without owning them. The tool RPC client uses it
 * to keep calls alive across a reconnect and to tell a new boot from the old.
 */
export interface BoxConnectionListener {
  /** A box finished its handshake (first connect or reconnect). */
  connected?(boxId: BoxId, bootId: string): void;
  /** An `rpc.result` no `rpc()` call is waiting for. Return true when it was yours. */
  rpcResult?(boxId: BoxId, frame: RpcResultFrame): boolean;
  /** A box sent `stream.data` or `stream.close` (decision 0016). Return true when it was yours. */
  stream?(boxId: BoxId, frame: StreamDataFrame | StreamCloseFrame): boolean;
  /**
   * The hub's heartbeat declared `boxId`'s open connection dead (decision
   * 0028). Called before `disconnected`; calls in flight on it fail now.
   */
  dead?(boxId: BoxId, bootId: string | undefined, death: ConnectionDeath): void;
  /** A box's open connection ended (closed, superseded, or the hub shut down). */
  disconnected?(boxId: BoxId, bootId: string | undefined): void;
}

interface PendingRpc {
  readonly resolve: (result: JsonValue) => void;
  readonly reject: (error: HearthError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type ConnState = "awaiting-hello" | "open" | "closed";

/** One box connection. Frames are handled one at a time, in arrival order. */
export class BoxConnection {
  state: ConnState = "awaiting-hello";
  binding: BoxBinding | undefined;
  principal: Principal | undefined;
  bootId: string | undefined;
  readonly socket: BoxSocket;
  readonly pending = new Map<string, PendingRpc>();
  queue: Promise<void> = Promise.resolve();
  helloTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeat: Heartbeat | undefined;

  constructor(socket: BoxSocket) {
    this.socket = socket;
  }

  /** Read after an `await`: the socket may have closed meanwhile. */
  get isClosed(): boolean {
    return this.state === "closed";
  }

  send(frame: Frame): void {
    if (this.state === "closed") return;
    this.socket.send(encodeFrame(frame));
  }

  /** Sends a frame `encodeFrame` already produced. */
  sendEncoded(data: string | Uint8Array): void {
    if (this.state === "closed") return;
    this.socket.send(data);
  }
}

/**
 * Encodes an `rpc` frame the caller built from its own params. Params the
 * protocol cannot carry (nested deeper than `MAX_JSON_DEPTH`, a non-finite
 * number, ...) are the caller's mistake, not a hub fault: they become a
 * classified `rpc.invalid-params` instead of escaping as a `RangeError`.
 */
export function encodeRpc(frame: RpcFrame): string | Uint8Array {
  try {
    return encodeFrame(frame);
  } catch (error) {
    if (!(error instanceof EncodeError)) throw error;
    throw new HearthError(`the params of ${frame.method} cannot be sent: ${error.error.message}`, {
      owner: "user",
      disposition: "give-up",
      code: "rpc.invalid-params",
    });
  }
}

function boxPrincipal(binding: BoxBinding): Principal {
  return {
    id: `box:${binding.boxId}`,
    workspaceId: binding.workspaceId,
    kind: "box",
    displayName: binding.boxId,
  };
}

function frameSummary(frame: ReliableFrame): string {
  return `${frame.type} ${frame.bootId}/${frame.deliveryId}`;
}

/** The payload stored for a box frame: the frame without its delivery fields. */
function payloadOf(frame: ReliableFrame): JsonValue {
  const { bootId: _b, deliveryId: _d, ...rest } = frame;
  return rest as JsonValue;
}

function turnIdOf(frame: ReliableFrame): string | undefined {
  return frame.type === "hibernate.done" ? undefined : frame.turnId;
}

export class BoxConnections {
  readonly #authorizer: Authorizer;
  readonly #events: EventStore;
  readonly #credentials: BoxCredentialStore;
  readonly #log: (line: string) => void;
  readonly #onApplied: ((applied: AppliedDelivery) => void) | undefined;
  readonly #echoDeadlineMs: number;
  readonly #heartbeat: HeartbeatSettings & { readonly clock: HeartbeatClock };
  readonly #byBox = new Map<BoxId, BoxConnection>();
  readonly #all = new Set<BoxConnection>();
  readonly #waiters = new Map<BoxId, Set<() => void>>();
  readonly #listeners = new Set<BoxConnectionListener>();
  #rpcCounter = 0;
  #shutDown = false;

  constructor(options: BoxConnectionsOptions) {
    this.#authorizer = options.authorizer;
    this.#events = options.events;
    this.#credentials = options.credentials;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#onApplied = options.onApplied;
    this.#echoDeadlineMs = options.echoDeadlineMs ?? ECHO_DEADLINE_MS;
    this.#heartbeat = {
      ...options.heartbeat,
      clock: options.heartbeat?.clock ?? SYSTEM_HEARTBEAT_CLOCK,
    };
  }

  /** True when `boxId` has a connection that finished its handshake. */
  isConnected(boxId: BoxId): boolean {
    return this.#byBox.get(boxId)?.state === "open";
  }

  /** Resolves once `boxId` is connected, or rejects with `box.connect-deadline`. */
  waitForBox(boxId: BoxId, deadlineMs: number): Promise<void> {
    if (this.isConnected(boxId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(boxId) ?? new Set();
      this.#waiters.set(boxId, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.delete(done);
        reject(
          new HearthError(`Box ${boxId} did not connect within ${deadlineMs} ms`, {
            owner: "box",
            disposition: "retry-cold",
            code: "box.connect-deadline",
          }),
        );
      }, deadlineMs);
      waiters.add(done);
    });
  }

  /** Adds a listener; returns its removal. */
  listen(listener: BoxConnectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The boot id of `boxId`'s open connection, if any. */
  bootIdOf(boxId: BoxId): string | undefined {
    const conn = this.#byBox.get(boxId);
    return conn?.state === "open" ? conn.bootId : undefined;
  }

  /**
   * Sends an `rpc` frame whose answer a listener collects. Returns the boot id
   * it went to, or undefined when the box is not connected (nothing was sent).
   * Throws `rpc.invalid-params` (nothing was sent) for params the protocol
   * cannot carry.
   */
  sendRpc(boxId: BoxId, frame: RpcFrame): string | undefined {
    const conn = this.#byBox.get(boxId);
    if (conn === undefined || conn.state !== "open") return undefined;
    conn.sendEncoded(encodeRpc(frame));
    return conn.bootId;
  }

  /**
   * Sends a byte-stream frame to a connected box (decision 0016). Returns
   * false when the box is not connected; nothing was sent.
   */
  sendStream(boxId: BoxId, frame: StreamOpenFrame | StreamDataFrame | StreamCloseFrame): boolean {
    const conn = this.#byBox.get(boxId);
    if (conn === undefined || conn.state !== "open") return false;
    conn.send(frame);
    return true;
  }

  // -- socket events (called by the server) --------------------------------

  open(socket: BoxSocket): BoxConnection {
    const conn = new BoxConnection(socket);
    this.#all.add(conn);
    if (this.#shutDown) {
      conn.state = "closed";
      socket.close(CLOSE_CODES.shutdown, "hub is shutting down");
      return conn;
    }
    conn.helloTimer = setTimeout(() => {
      if (conn.state !== "awaiting-hello") return;
      this.#log("box connection closed: no hello within the deadline");
      this.#close(conn, CLOSE_CODES.helloTimeout, "no hello");
    }, HELLO_DEADLINE_MS);
    return conn;
  }

  message(conn: BoxConnection, message: WireMessage): void {
    // Any frame proves the path is alive, even one queued behind a slow apply.
    conn.heartbeat?.heard();
    conn.queue = conn.queue.then(
      () => this.#handle(conn, message),
      () => this.#handle(conn, message),
    );
  }

  closed(conn: BoxConnection): void {
    this.#forget(conn, "the connection closed");
  }

  /** Close every connection and refuse new ones. */
  shutdown(): void {
    this.#shutDown = true;
    for (const conn of [...this.#all]) this.#close(conn, CLOSE_CODES.shutdown, "hub shutdown");
  }

  // -- RPC --------------------------------------------------------------------

  /**
   * `echo` round trip (the M0 exit criterion). Calls `authorize` first, then
   * sends `rpc` `echo` and resolves with what the box sent back.
   *
   * The resource workspace is the box's own (its join binding), so `authorize`
   * sees, denies and audits an echo to a box of another workspace (#50,
   * decision 0022). A box that has not said hello, or is not there, has no
   * binding; it is checked against the caller's workspace.
   *
   * A box the caller cannot see (not connected, or connected for another
   * workspace) answers `box.not-connected` whatever the policy decided, so the
   * answer never tells an unknown id from another workspace's box. Only a
   * connected box of the caller's own workspace can answer `authz.denied`.
   * Visibility is checked after `authorize`, so the box may have connected or
   * gone meanwhile, and a policy that allowed a cross-workspace echo still
   * sends nothing to the box.
   */
  async echo(
    principal: Principal,
    boxId: BoxId,
    params: JsonValue | RequestBody<JsonValue>,
  ): Promise<JsonValue> {
    const boxWorkspace = this.#byBox.get(boxId)?.binding?.workspaceId ?? principal.workspaceId;
    const decision = await this.#authorizer.authorize(principal, "box.echo", {
      workspaceId: boxWorkspace,
      type: "box",
      id: boxId,
    });
    // `#byBox` holds open connections only (`#hello` adds a box as it opens,
    // `#forget` removes it as it closes), each with its binding.
    if (this.#byBox.get(boxId)?.binding?.workspaceId !== principal.workspaceId) {
      throw notConnected(boxId);
    }
    if (!decision.allowed) {
      throw new HearthError(`box.echo denied: ${decision.reason}`, {
        owner: "user",
        disposition: "give-up",
        code: "authz.denied",
      });
    }
    // The body is read only now, after `authorize` and the visibility check
    // (#32): a caller who may not echo learns nothing from its body.
    return await this.rpc(boxId, "echo", await bodyOf(params), this.#echoDeadlineMs);
  }

  /**
   * Send an `rpc` to a connected box and wait for its `rpc.result`, up to
   * `deadlineMs`. Params the protocol cannot carry reject with
   * `rpc.invalid-params`; nothing is sent and nothing stays pending.
   */
  rpc(boxId: BoxId, method: string, params: JsonValue, deadlineMs: number): Promise<JsonValue> {
    const conn = this.#byBox.get(boxId);
    if (conn === undefined || conn.state !== "open") return Promise.reject(notConnected(boxId));
    this.#rpcCounter += 1;
    const id = `rpc_${this.#rpcCounter}`;
    let data: string | Uint8Array;
    try {
      // Encoded before the pending entry and its timer exist, so a refusal leaves neither.
      data = encodeRpc({ type: "rpc", id, method, params });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(
          new HearthError(`Box ${boxId} did not answer ${method} within ${deadlineMs} ms`, {
            owner: "box",
            disposition: "retry",
            code: "rpc.deadline",
          }),
        );
      }, deadlineMs);
      conn.pending.set(id, { resolve, reject, timer });
      conn.sendEncoded(data);
    });
  }

  // -- frame handling ---------------------------------------------------------

  async #handle(conn: BoxConnection, message: WireMessage): Promise<void> {
    if (conn.state === "closed") return;
    const decoded = decodeFrame(message);
    if (conn.state === "awaiting-hello") {
      if (!decoded.ok) return this.#reject(conn, rejectHello(decoded.error));
      if (decoded.frame.type !== "hello") {
        return this.#reject(conn, {
          type: "reject",
          reason: "malformed-hello",
          message: `the first frame must be hello, got ${decoded.frame.type}`,
        });
      }
      return await this.#hello(conn, decoded.frame);
    }
    if (!decoded.ok) {
      this.#log(
        `box ${conn.binding?.boxId}: dropped an undecodable frame (${decoded.error.code}: ${decoded.error.message})`,
      );
      return;
    }
    const frame = decoded.frame;
    switch (frame.type) {
      case "turn.event":
      case "turn.end":
      case "hibernate.done":
      case "usage.report":
        return await this.#apply(conn, frame);
      case "rpc.result": {
        const pending = conn.pending.get(frame.id);
        if (pending === undefined) {
          const boxId = conn.binding?.boxId;
          if (boxId !== undefined) {
            for (const listener of this.#listeners) {
              if (listener.rpcResult?.(boxId, frame) === true) return;
            }
          }
          this.#log(`box ${conn.binding?.boxId}: rpc.result for unknown id ${frame.id}`);
          return;
        }
        conn.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.result);
        else {
          pending.reject(
            new HearthError(`Box answered with ${frame.error.code}: ${frame.error.message}`, {
              owner: "box",
              disposition: "give-up",
              code: "rpc.error",
            }),
          );
        }
        return;
      }
      case "rpc":
        conn.send({
          type: "rpc.result",
          id: frame.id,
          ok: false,
          error: { code: "unknown-method", message: `the hub has no method ${frame.method}` },
        });
        return;
      case "ping":
        conn.send({ type: "pong", nonce: frame.nonce });
        return;
      case "pong":
        return;
      case "stream.data":
      case "stream.close": {
        const boxId = conn.binding?.boxId;
        if (boxId !== undefined) {
          for (const listener of this.#listeners) {
            if (listener.stream?.(boxId, frame) === true) return;
          }
        }
        // A stream nobody holds: tell the box to stop sending on it.
        if (frame.type === "stream.data") {
          conn.send({ type: "stream.close", streamId: frame.streamId, reason: "cancelled" });
        }
        return;
      }
      default:
        this.#log(`box ${conn.binding?.boxId}: ignored unexpected ${frame.type} frame`);
    }
  }

  async #hello(conn: BoxConnection, hello: HelloFrame): Promise<void> {
    const versionReject = checkHelloVersion(hello);
    if (versionReject !== null) return this.#reject(conn, versionReject);

    // A store or policy that throws (SQLITE_BUSY, a disk error) is the hub's
    // trouble: the box gets `reject` `internal`, which it retries, and the
    // socket closes as rejected, never silence and a later "no hello" (#32).
    let binding: Authenticated | undefined;
    let decision: Decision;
    try {
      binding = await this.#authenticate(hello);
      if (conn.isClosed) return;
      if (binding === undefined) {
        return this.#reject(conn, {
          type: "reject",
          reason: "bad-credential",
          message: "the credential is unknown, expired, already used or revoked",
        });
      }
      decision = await this.#authorizer.authorize(boxPrincipal(binding.binding), "box.connect", {
        workspaceId: binding.binding.workspaceId,
        type: "box",
        id: binding.binding.boxId,
      });
    } catch (error) {
      if (conn.isClosed) return;
      this.#log(`box ${hello.boxId}: hello failed on the hub: ${String(error)}`);
      return this.#reject(conn, {
        type: "reject",
        reason: "internal",
        message: "the hub could not check the credential; try again",
      });
    }
    if (conn.isClosed) return;
    const principal = boxPrincipal(binding.binding);
    if (!decision.allowed) {
      return this.#reject(conn, {
        type: "reject",
        reason: "bad-credential",
        message: `the box may not connect: ${decision.reason}`,
      });
    }

    const previous = this.#byBox.get(hello.boxId);
    if (previous !== undefined && previous !== conn) {
      this.#close(previous, CLOSE_CODES.superseded, "superseded by a newer connection");
    }
    clearTimeout(conn.helloTimer);
    conn.state = "open";
    conn.binding = binding.binding;
    conn.principal = principal;
    conn.bootId = hello.bootId;
    this.#byBox.set(hello.boxId, conn);
    conn.heartbeat = new Heartbeat({
      ...this.#heartbeat,
      ping: (nonce) => conn.send({ type: "ping", nonce }),
      dead: (misses) => this.#dead(conn, misses),
    });
    conn.heartbeat.start();
    conn.send({
      type: "welcome",
      version: PROTOCOL_VERSION,
      boxId: hello.boxId,
      ...(binding.credential === undefined ? {} : { credential: binding.credential }),
    });
    this.#log(
      `box ${hello.boxId} connected (boot ${hello.bootId}, last delivery ${hello.state.lastDeliveryId})`,
    );
    for (const listener of this.#listeners) listener.connected?.(hello.boxId, hello.bootId);
    const waiters = this.#waiters.get(hello.boxId);
    if (waiters !== undefined) for (const wake of [...waiters]) wake();
  }

  async #authenticate(hello: HelloFrame): Promise<Authenticated | undefined> {
    if (hello.credential.startsWith(JOIN_TOKEN_PREFIX)) {
      const outcome = await this.#credentials.redeemJoinToken(hello.boxId, hello.credential);
      if (outcome.kind === "rejected") {
        this.#log(`box ${hello.boxId}: join token rejected (${outcome.reason})`);
        return undefined;
      }
      return { binding: outcome.binding, credential: outcome.credential };
    }
    if (hello.credential.startsWith(BOX_CREDENTIAL_PREFIX)) {
      const binding = await this.#credentials.verifyCredential(hello.boxId, hello.credential);
      if (binding === undefined) this.#log(`box ${hello.boxId}: credential rejected`);
      return binding === undefined ? undefined : { binding };
    }
    this.#log(`box ${hello.boxId}: credential has no known prefix`);
    return undefined;
  }

  async #apply(conn: BoxConnection, frame: ReliableFrame): Promise<void> {
    const binding = conn.binding;
    const principal = conn.principal;
    if (binding === undefined || principal === undefined) return;
    if (frame.bootId !== conn.bootId) {
      // The box only redelivers frames of its current boot; another boot id
      // here is a box bug. Not acking keeps it visible.
      this.#log(`box ${binding.boxId}: ${frameSummary(frame)} is not from boot ${conn.bootId}`);
      return this.#close(conn, CLOSE_CODES.applyFailed, "frame from another boot");
    }
    const resource: Resource = {
      workspaceId: binding.workspaceId,
      type: "session",
      id: frame.sessionId,
    };
    try {
      const decision = await this.#authorizer.authorize(principal, "event.append", resource);
      if (!decision.allowed) {
        throw new HearthError(`event.append denied: ${decision.reason}`, {
          owner: "hub",
          disposition: "retry",
          code: "authz.denied",
        });
      }
      if (frame.sessionId !== binding.sessionId) {
        throw new HearthError(
          `box ${binding.boxId} is bound to session ${binding.sessionId}, not ${frame.sessionId}`,
          { owner: "box", disposition: "give-up", code: "box.wrong-session" },
        );
      }
      const turnId = turnIdOf(frame);
      const result = await this.#events.append(
        { workspaceId: binding.workspaceId },
        frame.sessionId,
        {
          type: frame.type,
          ...(turnId === undefined ? {} : { turnId }),
          payload: payloadOf(frame),
          delivery: { bootId: frame.bootId, deliveryId: frame.deliveryId },
        },
      );
      this.#onApplied?.({
        boxId: binding.boxId,
        bootId: frame.bootId,
        deliveryId: frame.deliveryId,
        seq: result.seq,
        duplicate: result.duplicate,
      });
      if (conn.isClosed || this.#shutDown) return;
      conn.send({ type: "delivery.ack", bootId: frame.bootId, deliveryId: frame.deliveryId });
    } catch (error) {
      if (conn.isClosed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#log(
        `box ${binding.boxId}: could not apply ${frameSummary(frame)}, not acked: ${message}`,
      );
      this.#close(conn, CLOSE_CODES.applyFailed, "apply failed; redeliver after reconnect");
    }
  }

  #reject(conn: BoxConnection, reject: RejectFrame): void {
    this.#log(`box connection rejected (${reject.reason}): ${reject.message}`);
    conn.send(reject);
    this.#close(conn, CLOSE_CODES.rejected, reject.reason);
  }

  /**
   * The heartbeat heard nothing for `misses` beats: the path is dead (a NAT
   * timeout, a paused or frozen box, a lost route), even though no FIN or RST
   * came. Say so in the log and the session's event log, tell the listeners
   * (the tool RPC client fails its calls, the session manager looks at the
   * box), fail this connection's own calls, and drop the socket.
   */
  #dead(conn: BoxConnection, misses: number): void {
    if (conn.state !== "open") return;
    const binding = conn.binding;
    const bootId = conn.bootId;
    const intervalMs = conn.heartbeat?.intervalMs ?? 0;
    const death: ConnectionDeath = { misses, intervalMs };
    const boxId = binding?.boxId;
    this.#log(
      `box ${boxId} connection dead: no frame for ${misses} heartbeats of ${intervalMs} ms; dropping it`,
    );
    if (boxId !== undefined) {
      for (const listener of this.#listeners) listener.dead?.(boxId, bootId, death);
    }
    this.#close(conn, CLOSE_CODES.heartbeatTimeout, "heartbeat timeout", {
      code: "box.connection-dead",
      message: `its connection was declared dead after ${misses} missed heartbeats`,
    });
    if (binding !== undefined) void this.#recordDeath(binding, bootId, death);
  }

  /** The death in the session's event log, so the trajectory shows it (decision 0021). */
  async #recordDeath(
    binding: BoxBinding,
    bootId: string | undefined,
    death: ConnectionDeath,
  ): Promise<void> {
    try {
      await this.#events.append({ workspaceId: binding.workspaceId }, binding.sessionId, {
        type: CONNECTION_DEAD_EVENT,
        payload: {
          boxId: binding.boxId,
          bootId: bootId ?? null,
          detectedBy: "hub",
          misses: death.misses,
          intervalMs: death.intervalMs,
          closeCode: CLOSE_CODES.heartbeatTimeout,
        },
      });
    } catch (error) {
      this.#log(
        `box ${binding.boxId}: could not record its dead connection in session ${binding.sessionId}: ${String(error)}`,
      );
    }
  }

  #close(conn: BoxConnection, code: number, reason: string, failure?: PendingFailure): void {
    if (conn.state === "closed") return;
    this.#forget(conn, reason, failure);
    try {
      if (failure !== undefined && conn.socket.terminate !== undefined) conn.socket.terminate();
      else conn.socket.close(code, reason);
    } catch {
      // Already closed by the peer.
    }
  }

  #forget(conn: BoxConnection, reason: string, failure?: PendingFailure): void {
    if (conn.state === "closed") return;
    conn.state = "closed";
    clearTimeout(conn.helloTimer);
    conn.heartbeat?.stop();
    this.#all.delete(conn);
    const boxId = conn.binding?.boxId;
    if (boxId !== undefined && this.#byBox.get(boxId) === conn) {
      this.#byBox.delete(boxId);
      this.#log(`box ${boxId} disconnected: ${reason}`);
      for (const listener of this.#listeners) listener.disconnected?.(boxId, conn.bootId);
    }
    for (const [id, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new HearthError(
          failure === undefined
            ? `Box ${boxId} disconnected before answering ${id}`
            : `Box ${boxId} did not answer ${id}: ${failure.message}`,
          { owner: "box", disposition: "retry", code: failure?.code ?? "box.disconnected" },
        ),
      );
    }
    conn.pending.clear();
  }
}

/** A box whose credential checked out, and the credential to send in `welcome`. */
interface Authenticated {
  readonly binding: BoxBinding;
  readonly credential?: string;
}

/** How the calls of a connection that is dropped on purpose fail. */
interface PendingFailure {
  readonly code: string;
  readonly message: string;
}

function notConnected(boxId: BoxId): HearthError {
  return new HearthError(`Box ${boxId} is not connected`, {
    owner: "box",
    disposition: "retry",
    code: "box.not-connected",
  });
}
