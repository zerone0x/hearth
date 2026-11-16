/**
 * Browser ↔ box desktop bridge (PRD §8.2, §8.3, §11.1 item 4; decision 0016).
 *
 * Each viewer is one browser WebSocket bridged to one hub-opened `vnc` stream
 * (even id, decision 0002) on the session's box connection. RFB from the box
 * goes to the browser as is; RFB from the browser goes through the input
 * filter (`rfb.ts`) first, which passes key and pointer input only while the
 * viewer's principal holds the session's desktop lock (`lock.ts`, decision
 * 0033). When a viewer closes and its principal has no other viewer of the
 * session open, a lock that principal holds is released.
 *
 * Bounds, so a slow browser cannot grow hub memory without limit:
 * - Box → browser: RFB is pull-based, the server sends an update only for a
 *   `FramebufferUpdateRequest`. While the browser socket has more than
 *   `VIEWER_HIGH_WATER_BYTES` queued, the bridge holds the viewer's requests
 *   back, so the box stops sending updates. Should the queue still pass
 *   `VIEWER_LIMIT_BYTES`, the viewer is closed (4408).
 * - Browser → box: held messages are capped at `TO_BOX_LIMIT_BYTES`; a viewer
 *   that keeps sending past it is closed as a protocol violation (1008).
 *
 * A viewer is closed when the box connection ends (box exit, hibernate,
 * archive, hub shutdown), when the box closes the stream, and when the login
 * it was opened with is no longer valid (checked on every browser message and
 * every `REAUTH_INTERVAL_MS`).
 */

import {
  type Authorizer,
  type BoxId,
  HearthError,
  type Principal,
  type SessionId,
} from "@hearth/core";
import type { StreamCloseFrame, StreamDataFrame } from "@hearth/protocol";
import type { BoxConnectionListener, BoxConnections } from "../box/connections";
import type { SessionManager } from "../session";
import type { DesktopLocks } from "./lock";
import { RfbInputFilter, RfbViolation } from "./rfb";

/** Browser socket queue above which the viewer's requests are held back. */
export const VIEWER_HIGH_WATER_BYTES = 1024 * 1024;
/** Browser socket queue at which the viewer is closed as too slow. */
export const VIEWER_LIMIT_BYTES = 16 * 1024 * 1024;
/** Filtered browser bytes held for the box; more closes the viewer. */
export const TO_BOX_LIMIT_BYTES = 64 * 1024;
/** How often a viewer's login is checked again. */
export const REAUTH_INTERVAL_MS = 5_000;
/** How often held requests are retried while the browser socket drains. */
export const HOLD_POLL_MS = 20;
/** Viewers of one session at once. */
export const MAX_VIEWERS_PER_SESSION = 4;

/** WebSocket close codes the desktop endpoint uses. */
export const DESKTOP_CLOSE = {
  /** The hub is shutting down. */
  shutdown: 1001,
  /** The browser sent RFB the view-only filter refuses, or too much of it. */
  protocol: 1008,
  /** The login the viewer opened with was signed out or expired. */
  revoked: 4401,
  /** The browser did not keep up with the desktop. */
  slowViewer: 4408,
  /** The box's desktop stream ended: the box exited, stopped or closed it. */
  boxGone: 4410,
  /** Too many viewers of this session. */
  tooMany: 4429,
} as const;

/** The browser socket operations the bridge needs; Bun's `ServerWebSocket` has them. */
export interface ViewerSocket {
  send(data: Uint8Array): unknown;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

/** What `prepare` found; the route passes it to the upgrade, `attach` uses it. */
export interface ViewerTicket {
  readonly principal: Principal;
  readonly sessionId: SessionId;
  readonly boxId: BoxId;
  /** The principal of the viewer's login now, or undefined once it is revoked. */
  readonly authenticate: () => Principal | undefined;
}

export interface DesktopBridgeOptions {
  readonly boxes: Pick<BoxConnections, "listen" | "sendStream">;
  readonly sessions: Pick<SessionManager, "get" | "ensureBox" | "scope">;
  readonly authorizer: Authorizer;
  /** The desktop lock; without it every viewer is view-only. */
  readonly locks?: Pick<DesktopLocks, "allowsInput" | "viewerLeft">;
  readonly log?: (line: string) => void;
  readonly highWaterBytes?: number;
  readonly limitBytes?: number;
  readonly toBoxLimitBytes?: number;
  readonly reauthIntervalMs?: number;
}

export class Viewer {
  readonly ticket: ViewerTicket;
  readonly socket: ViewerSocket;
  readonly streamId: number;
  readonly filter: RfbInputFilter;
  /** Next `seq` to the box, and the next one expected from it. */
  sendSeq = 0;
  recvSeq = 0;
  readonly held: Uint8Array[] = [];
  heldBytes = 0;
  holdTimer: ReturnType<typeof setInterval> | undefined;
  reauthTimer: ReturnType<typeof setInterval> | undefined;
  closed = false;

  constructor(
    ticket: ViewerTicket,
    socket: ViewerSocket,
    streamId: number,
    allowInput?: () => boolean,
  ) {
    this.ticket = ticket;
    this.socket = socket;
    this.streamId = streamId;
    this.filter = new RfbInputFilter(allowInput);
  }
}

export class DesktopBridge {
  readonly #options: DesktopBridgeOptions;
  readonly #log: (line: string) => void;
  /** Open viewers by box, then by stream id. */
  readonly #byBox = new Map<BoxId, Map<number, Viewer>>();
  readonly #unlisten: () => void;
  readonly #high: number;
  readonly #limit: number;
  readonly #toBoxLimit: number;
  #nextId = 0;
  #shutDown = false;

  constructor(options: DesktopBridgeOptions) {
    this.#options = options;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#high = options.highWaterBytes ?? VIEWER_HIGH_WATER_BYTES;
    this.#limit = options.limitBytes ?? VIEWER_LIMIT_BYTES;
    this.#toBoxLimit = options.toBoxLimitBytes ?? TO_BOX_LIMIT_BYTES;
    const listener: BoxConnectionListener = {
      stream: (boxId, frame) => this.#fromBox(boxId, frame),
      disconnected: (boxId) => {
        for (const viewer of [...(this.#byBox.get(boxId)?.values() ?? [])]) {
          this.#close(viewer, DESKTOP_CLOSE.boxGone, "the box disconnected", false);
        }
      },
    };
    this.#unlisten = options.boxes.listen(listener);
  }

  /** Open viewers of `boxId`. */
  viewers(boxId: BoxId): number {
    return this.#byBox.get(boxId)?.size ?? 0;
  }

  /**
   * Checks that `principal` may watch `sessionId`'s desktop and gets its box
   * running, before the browser's upgrade is accepted. `authorize`
   * (`desktop.view`) comes first; the session must exist and be readable
   * (`session.read`). The box lease is released at once: watching does not
   * keep a box awake, so a session still hibernates on schedule and its
   * viewers are closed when it does.
   */
  async prepare(
    principal: Principal,
    sessionId: SessionId,
    authenticate: () => Principal | undefined,
  ): Promise<ViewerTicket> {
    if (this.#shutDown) throw unavailable("the hub is shutting down");
    // The session's workspace, not the caller's: a caller of another
    // workspace is denied and audited as such (#61).
    const decision = await this.#options.authorizer.authorize(principal, "desktop.view", {
      workspaceId: this.#options.sessions.scope.workspaceId,
      type: "session",
      id: sessionId,
    });
    if (!decision.allowed) {
      throw new HearthError(`desktop.view denied: ${decision.reason}`, {
        owner: "user",
        disposition: "give-up",
        code: "authz.denied",
      });
    }
    await this.#options.sessions.get(principal, sessionId);
    const lease = await this.#options.sessions.ensureBox(sessionId, principal);
    lease.release();
    return { principal, sessionId, boxId: lease.boxId, authenticate };
  }

  /** The browser's upgrade completed: open the box stream. Returns the viewer, or undefined when it was closed at once. */
  attach(socket: ViewerSocket, ticket: ViewerTicket): Viewer | undefined {
    if (this.#shutDown) {
      socket.close(DESKTOP_CLOSE.shutdown, "the hub is shutting down");
      return undefined;
    }
    const streams = this.#byBox.get(ticket.boxId) ?? new Map<number, Viewer>();
    if (streams.size >= MAX_VIEWERS_PER_SESSION) {
      socket.close(DESKTOP_CLOSE.tooMany, "too many viewers of this desktop");
      return undefined;
    }
    const locks = this.#options.locks;
    const viewer = new Viewer(
      ticket,
      socket,
      this.#allocate(streams),
      locks === undefined
        ? undefined
        : () => locks.allowsInput(ticket.sessionId, ticket.principal.id),
    );
    if (
      !this.#options.boxes.sendStream(ticket.boxId, {
        type: "stream.open",
        streamId: viewer.streamId,
        kind: "vnc",
      })
    ) {
      socket.close(DESKTOP_CLOSE.boxGone, "the box is not connected");
      return undefined;
    }
    streams.set(viewer.streamId, viewer);
    this.#byBox.set(ticket.boxId, streams);
    viewer.reauthTimer = setInterval(
      () => this.#reauth(viewer),
      this.#options.reauthIntervalMs ?? REAUTH_INTERVAL_MS,
    );
    this.#log(
      `desktop: session ${ticket.sessionId} viewer opened stream ${viewer.streamId} on box ${ticket.boxId}`,
    );
    return viewer;
  }

  /** A browser message: filter it and send what remains to the box. */
  message(viewer: Viewer, data: string | Uint8Array): void {
    if (viewer.closed || !this.#reauth(viewer)) return;
    if (typeof data === "string") {
      this.#close(viewer, DESKTOP_CLOSE.protocol, "RFB travels in binary messages");
      return;
    }
    let forward: Uint8Array;
    try {
      forward = viewer.filter.push(data);
    } catch (error) {
      if (!(error instanceof RfbViolation)) throw error;
      this.#close(viewer, DESKTOP_CLOSE.protocol, error.message);
      return;
    }
    if (forward.byteLength === 0) return;
    viewer.held.push(forward);
    viewer.heldBytes += forward.byteLength;
    if (viewer.heldBytes > this.#toBoxLimit) {
      this.#close(viewer, DESKTOP_CLOSE.protocol, "the viewer sent too much while held");
      return;
    }
    this.flush(viewer);
  }

  /**
   * Sends held browser bytes to the box unless the browser socket is above
   * the high water mark; then retries on a timer. The server's `drain` calls it too.
   */
  flush(viewer: Viewer): void {
    if (viewer.closed) return;
    if (viewer.socket.getBufferedAmount() > this.#high) {
      viewer.holdTimer ??= setInterval(() => this.flush(viewer), HOLD_POLL_MS);
      return;
    }
    clearInterval(viewer.holdTimer);
    viewer.holdTimer = undefined;
    while (viewer.held.length > 0) {
      const data = viewer.held.shift() as Uint8Array;
      viewer.heldBytes -= data.byteLength;
      const sent = this.#options.boxes.sendStream(viewer.ticket.boxId, {
        type: "stream.data",
        streamId: viewer.streamId,
        seq: viewer.sendSeq,
        data,
      });
      if (!sent) {
        this.#close(viewer, DESKTOP_CLOSE.boxGone, "the box disconnected", false);
        return;
      }
      viewer.sendSeq = (viewer.sendSeq + 1) >>> 0;
    }
  }

  /** The browser closed its socket. */
  closed(viewer: Viewer): void {
    this.#close(viewer, undefined, "the viewer left");
  }

  /** Close every viewer and refuse new ones. */
  shutdown(): void {
    this.#shutDown = true;
    for (const streams of [...this.#byBox.values()]) {
      for (const viewer of [...streams.values()]) {
        this.#close(viewer, DESKTOP_CLOSE.shutdown, "the hub is shutting down");
      }
    }
    this.#unlisten();
  }

  #fromBox(boxId: BoxId, frame: StreamDataFrame | StreamCloseFrame): boolean {
    const viewer = this.#byBox.get(boxId)?.get(frame.streamId);
    if (viewer === undefined) return false;
    if (frame.type === "stream.close") {
      const why = frame.message === undefined ? frame.reason : `${frame.reason}: ${frame.message}`;
      this.#close(viewer, DESKTOP_CLOSE.boxGone, `the desktop stream ended (${why})`, false);
      return true;
    }
    if (frame.seq !== viewer.recvSeq) {
      this.#close(viewer, DESKTOP_CLOSE.boxGone, `stream out of order (seq ${frame.seq})`);
      return true;
    }
    viewer.recvSeq = (viewer.recvSeq + 1) >>> 0;
    if (viewer.socket.getBufferedAmount() + frame.data.byteLength > this.#limit) {
      this.#close(viewer, DESKTOP_CLOSE.slowViewer, "the viewer is not keeping up");
      return true;
    }
    viewer.socket.send(frame.data);
    return true;
  }

  /** Checks the viewer's login; closes the viewer and returns false once it is revoked. */
  #reauth(viewer: Viewer): boolean {
    if (viewer.closed) return false;
    const now = viewer.ticket.authenticate();
    if (now !== undefined && now.id === viewer.ticket.principal.id) return true;
    this.#close(viewer, DESKTOP_CLOSE.revoked, "the login was revoked");
    return false;
  }

  /** Whether `principalId` still has a viewer of `sessionId` open. */
  #watching(sessionId: SessionId, principalId: string): boolean {
    for (const streams of this.#byBox.values()) {
      for (const viewer of streams.values()) {
        if (viewer.ticket.sessionId === sessionId && viewer.ticket.principal.id === principalId) {
          return true;
        }
      }
    }
    return false;
  }

  /** Next free even stream id on this box (decision 0002: the hub opens even ids). */
  #allocate(streams: Map<number, Viewer>): number {
    for (;;) {
      this.#nextId = (this.#nextId + 2) % 2 ** 32;
      if (!streams.has(this.#nextId)) return this.#nextId;
    }
  }

  /**
   * Forget the viewer, tell the box (unless the box ended the stream or is
   * gone), and close the browser socket with `code` (none when it closed).
   */
  #close(viewer: Viewer, code: number | undefined, reason: string, tellBox = true): void {
    if (viewer.closed) return;
    viewer.closed = true;
    clearInterval(viewer.holdTimer);
    clearInterval(viewer.reauthTimer);
    viewer.held.length = 0;
    viewer.heldBytes = 0;
    const streams = this.#byBox.get(viewer.ticket.boxId);
    streams?.delete(viewer.streamId);
    if (streams?.size === 0) this.#byBox.delete(viewer.ticket.boxId);
    if (tellBox) {
      this.#options.boxes.sendStream(viewer.ticket.boxId, {
        type: "stream.close",
        streamId: viewer.streamId,
        reason: code === DESKTOP_CLOSE.revoked ? "revoked" : "cancelled",
        message: reason,
      });
    }
    this.#log(
      `desktop: session ${viewer.ticket.sessionId} stream ${viewer.streamId} closed: ${reason}`,
    );
    if (!this.#watching(viewer.ticket.sessionId, viewer.ticket.principal.id)) {
      void this.#options.locks?.viewerLeft(viewer.ticket.sessionId, viewer.ticket.principal.id);
    }
    if (code === undefined) return;
    try {
      viewer.socket.close(code, closeReason(reason));
    } catch {
      // Already closed by the browser.
    }
  }
}

/** A WebSocket close reason is at most 123 UTF-8 bytes. */
export function closeReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason);
  if (bytes.byteLength <= 123) return reason;
  return new TextDecoder().decode(bytes.subarray(0, 120)).replace(/\uFFFD$/, "");
}

function unavailable(message: string): HearthError {
  return new HearthError(message, {
    owner: "hub",
    disposition: "retry",
    code: "desktop.unavailable",
  });
}
