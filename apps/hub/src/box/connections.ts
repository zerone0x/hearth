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
  type EventStore,
  HearthError,
  type JsonValue,
  type Principal,
  type Resource,
} from "@hearth/core";
import {
  checkHelloVersion,
  decodeFrame,
  encodeFrame,
  type Frame,
  type HelloFrame,
  PROTOCOL_VERSION,
  type RejectFrame,
  type ReliableFrame,
  rejectHello,
  type WireMessage,
} from "@hearth/protocol";
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
  /** The hub is shutting down. */
  shutdown: 1001,
} as const;

/** The socket operations the handler needs; Bun's `ServerWebSocket` has them. */
export interface BoxSocket {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
}

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
  readonly #byBox = new Map<BoxId, BoxConnection>();
  readonly #all = new Set<BoxConnection>();
  readonly #waiters = new Map<BoxId, Set<() => void>>();
  #rpcCounter = 0;
  #shutDown = false;

  constructor(options: BoxConnectionsOptions) {
    this.#authorizer = options.authorizer;
    this.#events = options.events;
    this.#credentials = options.credentials;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#onApplied = options.onApplied;
    this.#echoDeadlineMs = options.echoDeadlineMs ?? ECHO_DEADLINE_MS;
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
   */
  async echo(principal: Principal, boxId: BoxId, params: JsonValue): Promise<JsonValue> {
    const decision = await this.#authorizer.authorize(principal, "box.echo", {
      workspaceId: principal.workspaceId,
      type: "box",
      id: boxId,
    });
    if (!decision.allowed) {
      throw new HearthError(`box.echo denied: ${decision.reason}`, {
        owner: "user",
        disposition: "give-up",
        code: "authz.denied",
      });
    }
    const conn = this.#byBox.get(boxId);
    if (conn?.binding !== undefined && conn.binding.workspaceId !== principal.workspaceId) {
      throw notConnected(boxId);
    }
    return await this.rpc(boxId, "echo", params, this.#echoDeadlineMs);
  }

  /** Send an `rpc` to a connected box and wait for its `rpc.result`, up to `deadlineMs`. */
  rpc(boxId: BoxId, method: string, params: JsonValue, deadlineMs: number): Promise<JsonValue> {
    const conn = this.#byBox.get(boxId);
    if (conn === undefined || conn.state !== "open") return Promise.reject(notConnected(boxId));
    this.#rpcCounter += 1;
    const id = `rpc_${this.#rpcCounter}`;
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
      conn.send({ type: "rpc", id, method, params });
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
      default:
        this.#log(`box ${conn.binding?.boxId}: ignored unexpected ${frame.type} frame`);
    }
  }

  async #hello(conn: BoxConnection, hello: HelloFrame): Promise<void> {
    const versionReject = checkHelloVersion(hello);
    if (versionReject !== null) return this.#reject(conn, versionReject);

    const binding = await this.#authenticate(hello);
    if (conn.isClosed) return;
    if (binding === undefined) {
      return this.#reject(conn, {
        type: "reject",
        reason: "bad-credential",
        message: "the credential is unknown, expired, already used or revoked",
      });
    }
    const principal = boxPrincipal(binding.binding);
    const decision = await this.#authorizer.authorize(principal, "box.connect", {
      workspaceId: binding.binding.workspaceId,
      type: "box",
      id: binding.binding.boxId,
    });
    if (conn.isClosed) return;
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
    conn.send({
      type: "welcome",
      version: PROTOCOL_VERSION,
      boxId: hello.boxId,
      ...(binding.credential === undefined ? {} : { credential: binding.credential }),
    });
    this.#log(
      `box ${hello.boxId} connected (boot ${hello.bootId}, last delivery ${hello.state.lastDeliveryId})`,
    );
    const waiters = this.#waiters.get(hello.boxId);
    if (waiters !== undefined) for (const wake of [...waiters]) wake();
  }

  async #authenticate(
    hello: HelloFrame,
  ): Promise<{ binding: BoxBinding; credential?: string } | undefined> {
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

  #close(conn: BoxConnection, code: number, reason: string): void {
    if (conn.state === "closed") return;
    this.#forget(conn, reason);
    try {
      conn.socket.close(code, reason);
    } catch {
      // Already closed by the peer.
    }
  }

  #forget(conn: BoxConnection, reason: string): void {
    if (conn.state === "closed") return;
    conn.state = "closed";
    clearTimeout(conn.helloTimer);
    this.#all.delete(conn);
    const boxId = conn.binding?.boxId;
    if (boxId !== undefined && this.#byBox.get(boxId) === conn) {
      this.#byBox.delete(boxId);
      this.#log(`box ${boxId} disconnected: ${reason}`);
    }
    for (const [id, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new HearthError(`Box ${boxId} disconnected before answering ${id}`, {
          owner: "box",
          disposition: "retry",
          code: "box.disconnected",
        }),
      );
    }
    conn.pending.clear();
  }
}

function notConnected(boxId: BoxId): HearthError {
  return new HearthError(`Box ${boxId} is not connected`, {
    owner: "box",
    disposition: "retry",
    code: "box.not-connected",
  });
}
