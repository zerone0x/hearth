import {
  AllowAllAuthorizer,
  type BoxProvider,
  type BoxSpec,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  type Principal,
} from "@hearth/core";
import { createApp } from "./app";
import {
  type AppliedDelivery,
  BOX_SOCKET_PATH,
  type BoxConnection,
  BoxConnections,
} from "./box/connections";
import type { IssuedJoinToken } from "./box/credentials";
import { openDatabase, SqliteAuditSink, SqliteBoxCredentialStore, SqliteEventStore } from "./store";

export interface HubListenOptions {
  /** Interface to bind. Defaults to loopback: the hub is never public by default (PRD §10). */
  readonly hostname?: string;
  /** TCP port. 0 picks a free port (used by tests). */
  readonly port?: number;
}

export interface HubOptions extends HubListenOptions {
  /** Path of the hub's SQLite database. Created and migrated on start. */
  readonly dbPath: string;
  readonly log?: (line: string) => void;
  /** Observes every applied box delivery before its ack (see `BoxConnections`). */
  readonly onApplied?: (applied: AppliedDelivery) => void;
}

export const DEFAULT_HOSTNAME = "127.0.0.1";
export const DEFAULT_PORT = 8787;

/** Environment variables `launchBox` passes to the box-agent for one boot. */
export const BOX_ENV = {
  hubUrl: "HEARTH_HUB_URL",
  boxId: "HEARTH_BOX_ID",
  joinToken: "HEARTH_JOIN_TOKEN",
} as const;

/** The WebSocket URL a box dials, for a hub reachable at `base` (http or https). */
export function boxSocketUrl(base: string | URL): string {
  const url = new URL(BOX_SOCKET_PATH, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Starts the hub: opens the store, wires the audit sink, authorizer and box endpoint, and listens. */
export function startHub(options: HubOptions) {
  const db = openDatabase(options.dbPath);
  const audit = new SqliteAuditSink(db);
  const authorizer = new AllowAllAuthorizer({ audit });
  const events = new SqliteEventStore(db);
  const credentials = new SqliteBoxCredentialStore(db);
  const boxes = new BoxConnections({
    authorizer,
    events,
    credentials,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
  });
  const app = createApp({ boxes });

  let server: Bun.Server<BoxConnection | undefined>;
  try {
    server = Bun.serve<BoxConnection | undefined>({
      hostname: options.hostname ?? DEFAULT_HOSTNAME,
      port: options.port ?? DEFAULT_PORT,
      fetch(req, srv) {
        if (new URL(req.url).pathname === BOX_SOCKET_PATH) {
          // The upgrade carries no credential: the box authenticates in its
          // first frame, `hello`, and `authorize` runs before anything else.
          if (srv.upgrade(req, { data: undefined })) return undefined;
          return new Response("expected a WebSocket upgrade", { status: 426 });
        }
        return app.fetch(req);
      },
      websocket: {
        open(ws) {
          ws.data = boxes.open(ws);
        },
        message(ws, message) {
          if (ws.data !== undefined) boxes.message(ws.data, message);
        },
        close(ws) {
          if (ws.data !== undefined) boxes.closed(ws.data);
        },
      },
    });
  } catch (cause) {
    db.close();
    throw cause;
  }

  let stopped: Promise<void> | undefined;
  const scope = { workspaceId: DEFAULT_WORKSPACE_ID };
  return {
    server,
    url: server.url,
    /** The URL a box on this host dials. */
    boxSocketUrl: boxSocketUrl(server.url),
    authorizer,
    events,
    credentials,
    boxes,
    /** Mint a one-time join token for `boxId`, bound to `sessionId`. */
    issueJoinToken(boxId: string, sessionId: string, ttlMs?: number): Promise<IssuedJoinToken> {
      return credentials.issueJoinToken(scope, boxId, sessionId, ttlMs);
    },
    /**
     * Start a box through `provider` with a fresh join token in its boot
     * environment. Calls `authorize` first. `hubUrl` is the box socket URL as
     * the box sees it (for a container, not the hub's own loopback address).
     */
    async launchBox(principal: Principal, provider: BoxProvider, spec: BoxSpec, hubUrl: string) {
      const decision = await authorizer.authorize(principal, "box.start", {
        workspaceId: spec.workspaceId,
        type: "box",
        id: spec.boxId,
      });
      if (!decision.allowed) {
        throw new HearthError(`box.start denied: ${decision.reason}`, {
          owner: "user",
          disposition: "give-up",
          code: "authz.denied",
        });
      }
      const { token } = await credentials.issueJoinToken(
        { workspaceId: spec.workspaceId },
        spec.boxId,
        spec.sessionId,
      );
      return await provider.start(spec, {
        env: {
          [BOX_ENV.hubUrl]: hubUrl,
          [BOX_ENV.boxId]: spec.boxId,
          [BOX_ENV.joinToken]: token,
        },
      });
    },
    /** Close every box connection, stop listening and close the database. Idempotent. */
    stop(): Promise<void> {
      if (stopped !== undefined) return stopped;
      boxes.shutdown();
      stopped = (async () => {
        await server.stop(true);
        db.close();
      })();
      return stopped;
    },
  };
}

export type Hub = ReturnType<typeof startHub>;

/**
 * Parses a port from configuration. Rejects anything that is not an integer in
 * 0..65535 instead of silently falling back.
 */
export function parsePort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${raw}": expected an integer from 0 to 65535`);
  }
  return port;
}
