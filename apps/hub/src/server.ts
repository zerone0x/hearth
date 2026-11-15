import {
  AllowAllAuthorizer,
  type BoxId,
  type BoxProvider,
  type BoxSpec,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  type Principal,
} from "@hearth/core";
import { createApp, hostKey, LOOPBACK_HOSTS } from "./app";
import {
  type AppliedDelivery,
  BOX_SOCKET_PATH,
  type BoxConnection,
  BoxConnections,
} from "./box/connections";
import type { IssuedJoinToken } from "./box/credentials";
import {
  type BoxEgressCheck,
  type BoxEgressStatus,
  markerEgressCheck,
  requireBoxEgress,
} from "./box/egress";
import { mountSessionRoutes, SessionManager, type SessionManagerOptions } from "./session";
import {
  openDatabase,
  SqliteAuditSink,
  SqliteBoxCredentialStore,
  SqliteEventStore,
  SqliteSessionStore,
} from "./store";

export interface HubListenOptions {
  /** Interface to bind. Defaults to loopback: the hub is never public by default (PRD §10). */
  readonly hostname?: string;
  /** TCP port. 0 picks a free port (used by tests). */
  readonly port?: number;
  /**
   * Public origin behind the owner's reverse proxy (`HEARTH_PUBLIC_ORIGIN`),
   * normalized by `parsePublicOrigin`. The API answers it besides loopback
   * and the bound address (docs/DECISIONS.md, 0010).
   */
  readonly publicOrigin?: string;
}

/**
 * A `BoxProvider` that also knows where its boxes can reach the hub: the
 * address on the box's own network that the hub binds its box listener to
 * (docs/DECISIONS.md, 0012). `DockerBoxProvider` answers with the gateway of
 * the box's bridge network.
 */
export interface BoxNetworkProvider extends BoxProvider {
  /** The IP address on `boxId`'s network where the hub listens for that box. Needs `create` first. */
  hubAddress(boxId: BoxId): Promise<string>;
}

export interface HubOptions extends HubListenOptions {
  /**
   * TCP port of the box listeners (`HEARTH_BOX_PORT`). Every box listener binds
   * one box-network address on this port; the host firewall lets boxes reach
   * the host on this port only (docs/DECISIONS.md, 0012). 0 picks a free port
   * per listener (tests only).
   */
  readonly boxPort?: number;
  /** Starts boxes for `startBox`. Without one, `startBox` fails with `box.no-provider`. */
  readonly provider?: BoxNetworkProvider;
  /**
   * Whether boxes have filtered egress (`box/egress.ts`, decision 0012), read
   * on every `startBox`. Defaults to the marker that `scripts/box-firewall.sh
   * apply` writes; while it reports `unfiltered`, `startBox` is refused.
   */
  readonly boxEgress?: BoxEgressCheck;
  /** Path of the hub's SQLite database. Created and migrated on start. */
  readonly dbPath: string;
  readonly log?: (line: string) => void;
  /** Observes every applied box delivery before its ack (see `BoxConnections`). */
  readonly onApplied?: (applied: AppliedDelivery) => void;
  /** Deadline of the `echo` RPC (see `BoxConnections`). Only tests change it. */
  readonly echoDeadlineMs?: number;
  /** Image of session boxes (`HEARTH_BOX_IMAGE`). Defaults to `DEFAULT_BOX_IMAGE`. */
  readonly boxImage?: string;
  /** Session manager timings and bounds (idle time, relaunch bounds); see `SessionManagerOptions`. */
  readonly sessions?: Partial<
    Pick<
      SessionManagerOptions,
      | "idleMs"
      | "runningGraceMs"
      | "connectDeadlineMs"
      | "exitPollMs"
      | "superviseIntervalMs"
      | "maxCredentialRelaunches"
      | "maxCrashRetries"
      | "stableMs"
    >
  >;
}

/** Image of session boxes when `boxImage` is not set. */
export const DEFAULT_BOX_IMAGE = "hearth-box:local";

export const DEFAULT_HOSTNAME = "127.0.0.1";
export const DEFAULT_PORT = 8787;
/** Port of the box listeners, one per box-network address (docs/DECISIONS.md, 0012). */
export const DEFAULT_BOX_PORT = 8788;

/** Retry pacing of `listenForRunningBoxes` while the provider cannot list boxes. */
export interface AdoptRetry {
  /** First delay after a failed listing (default 1 s); doubles per attempt. */
  readonly delayMs?: number;
  /** Ceiling of the delay (default 30 s). */
  readonly maxDelayMs?: number;
}

/** What `listenForRunningBoxes` did: the boxes it listens for again, and the ones it could not. */
export interface RunningBoxes {
  readonly listening: string[];
  readonly failed: { readonly boxId: string; readonly error: unknown }[];
}

/** Addresses that bind every interface; never used for a box listener. */
const UNSPECIFIED_HOSTS = new Set(["0.0.0.0", "[::]", "[0:0:0:0:0:0:0:0]", ""]);

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
  const sessionStore = new SqliteSessionStore(db);
  const boxes = new BoxConnections({
    authorizer,
    events,
    credentials,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
    ...(options.echoDeadlineMs === undefined ? {} : { echoDeadlineMs: options.echoDeadlineMs }),
  });
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const boxEgress = options.boxEgress ?? markerEgressCheck();
  const app = createApp(
    { boxes },
    {
      allowedHosts: [...LOOPBACK_HOSTS, hostname],
      ...(options.provider === undefined ? {} : { boxEgress }),
      ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
    },
  );

  // The public listener: the UI/API only, on loopback by default (PRD §10).
  // It never upgrades to the box socket; that path is a 404 here.
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname,
      port: options.port ?? DEFAULT_PORT,
      fetch: (req) => app.fetch(req),
    });
  } catch (cause) {
    db.close();
    throw cause;
  }

  let stopped: Promise<void> | undefined;

  // A hub that starts boxes says loudly when they would not be filtered
  // (decision 0012): `unfiltered` refuses every start, `unrestricted` is the
  // owner's explicit choice but still worth a line on every start of the hub.
  if (options.provider !== undefined) {
    const status = boxEgress();
    if (status.state !== "filtered") {
      options.log?.(`WARNING: box egress ${status.state}: ${status.detail}`);
    }
  }

  // Box listeners: the box socket only, one per box-network address
  // (docs/DECISIONS.md, 0012). Nothing else is served on them, so the API and
  // its Host/Origin checks (0010) stay on the public listener.
  const boxPort = options.boxPort ?? DEFAULT_BOX_PORT;
  const boxListeners = new Map<string, Bun.Server<BoxConnection | undefined>>();
  const websocket: Bun.WebSocketHandler<BoxConnection | undefined> = {
    open(ws) {
      ws.data = boxes.open(ws);
    },
    message(ws, message) {
      if (ws.data !== undefined) boxes.message(ws.data, message);
    },
    close(ws) {
      if (ws.data === undefined) return;
      boxes.closed(ws.data);
      // Supervision (#28): a dropped box may have exited; the manager looks.
      const boxId = ws.data.binding?.boxId;
      if (boxId !== undefined) sessions.boxClosed(boxId);
    },
  };
  function listenForBoxes(address: string): string {
    if (stopped !== undefined) throw new Error("the hub is stopped");
    const key = hostKey(address);
    if (UNSPECIFIED_HOSTS.has(key)) {
      throw new Error(`a box listener binds one box-network address, not "${address}"`);
    }
    let listener = boxListeners.get(key);
    if (listener === undefined) {
      listener = Bun.serve<BoxConnection | undefined>({
        hostname: address,
        port: boxPort,
        fetch(req, srv) {
          if (new URL(req.url).pathname !== BOX_SOCKET_PATH) {
            return new Response("not found", { status: 404 });
          }
          // The upgrade carries no credential: the box authenticates in its
          // first frame, `hello`, and `authorize` runs before anything else.
          if (srv.upgrade(req, { data: undefined })) return undefined;
          return new Response("expected a WebSocket upgrade", { status: 426 });
        },
        websocket,
      });
      boxListeners.set(key, listener);
      options.log?.(`box listener on ${listener.url}`);
    }
    return boxSocketUrl(listener.url);
  }

  async function authorizeStart(principal: Principal, spec: BoxSpec): Promise<void> {
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
  }

  async function bootBox(provider: BoxProvider, spec: BoxSpec, hubUrl: string) {
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
  }

  function requireProvider(): BoxNetworkProvider {
    if (options.provider === undefined) {
      throw new HearthError("no box provider is configured", {
        owner: "hub",
        disposition: "give-up",
        code: "box.no-provider",
      });
    }
    return options.provider;
  }

  /**
   * Start a box through the configured provider (decision 0012): `authorize`,
   * refuse with `box.egress-unfiltered` unless box egress is filtered or
   * explicitly unrestricted, create the box's network and volumes, open a box listener on the hub's
   * address on that network, then boot the box with a fresh join token and
   * that listener's URL.
   */
  async function startBox(principal: Principal, spec: BoxSpec) {
    const provider = requireProvider();
    await authorizeStart(principal, spec);
    requireBoxEgress(boxEgress());
    await provider.create(spec);
    const hubUrl = listenForBoxes(await provider.hubAddress(spec.boxId));
    return await bootBox(provider, spec, hubUrl);
  }

  // The session manager (decision 0013): it alone starts, stops and relaunches
  // session boxes, through `startBox` and the provider.
  const provider = options.provider;
  const sessions = new SessionManager({
    authorizer,
    events,
    store: sessionStore,
    image: options.boxImage ?? DEFAULT_BOX_IMAGE,
    ...options.sessions,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(provider === undefined
      ? {}
      : {
          boxes: {
            providerName: provider.name,
            start: startBox,
            stop: (boxId: BoxId) => provider.stop(boxId),
            attach: (boxId: BoxId) => provider.attach(boxId),
            isConnected: (boxId: BoxId) => boxes.isConnected(boxId),
            waitForBox: (boxId: BoxId, deadlineMs: number) => boxes.waitForBox(boxId, deadlineMs),
          },
        }),
  });
  mountSessionRoutes(app, sessions);

  const scope = { workspaceId: DEFAULT_WORKSPACE_ID };
  return {
    /** The public listener: UI/API only. */
    server,
    url: server.url,
    /** The box listeners, by bound address. */
    boxListeners: boxListeners as ReadonlyMap<string, Bun.Server<BoxConnection | undefined>>,
    /**
     * Open (or reuse) a box listener on `address` and return the box socket URL
     * a box on that network dials. Refuses unspecified addresses (`0.0.0.0`,
     * `::`): box listeners are reachable only from box networks (0012).
     */
    listenForBoxes,
    authorizer,
    events,
    credentials,
    boxes,
    /** The session manager: sessions, lazy box start, hibernate, supervision (decision 0013). */
    sessions,
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
      await authorizeStart(principal, spec);
      return await bootBox(provider, spec, hubUrl);
    },
    /** Start a box through the configured provider (decision 0012); see `startBox` above. */
    startBox,
    /** The current box egress status (decision 0012); `/healthz` reports it too. */
    boxEgress(): BoxEgressStatus {
      return boxEgress();
    },
    /**
     * After a hub restart: open the box listeners of the boxes the provider
     * still runs, so they can reconnect. While the provider cannot list its
     * boxes (the Docker daemon is down) it retries with backoff until it can
     * or the hub stops. A box whose listener cannot be opened is logged and
     * reported in `failed`; the other boxes still get theirs.
     */
    async listenForRunningBoxes(retry: AdoptRetry = {}): Promise<RunningBoxes> {
      const provider = requireProvider();
      const maxDelayMs = retry.maxDelayMs ?? 30_000;
      let delayMs = retry.delayMs ?? 1_000;
      let running: Awaited<ReturnType<BoxProvider["adopt"]>>;
      for (let attempt = 1; ; attempt++) {
        try {
          running = await provider.adopt();
          break;
        } catch (error) {
          if (stopped !== undefined) return { listening: [], failed: [] };
          options.log?.(
            `could not list running boxes (attempt ${attempt}), retrying in ${delayMs} ms: ${String(error)}`,
          );
          await Bun.sleep(delayMs);
          if (stopped !== undefined) return { listening: [], failed: [] };
          delayMs = Math.min(delayMs * 2, maxDelayMs);
        }
      }
      const result: RunningBoxes = { listening: [], failed: [] };
      for (const box of running) {
        if (box.state !== "running") continue;
        try {
          listenForBoxes(await provider.hubAddress(box.boxId));
          result.listening.push(box.boxId);
        } catch (error) {
          options.log?.(`could not listen again for box ${box.boxId}: ${String(error)}`);
          result.failed.push({ boxId: box.boxId, error });
        }
      }
      return result;
    },
    /** Close every box connection, stop listening and close the database. Idempotent. */
    stop(): Promise<void> {
      if (stopped !== undefined) return stopped;
      sessions.stop();
      boxes.shutdown();
      stopped = (async () => {
        await sessions.ready.catch(() => undefined);
        await Promise.all([server, ...boxListeners.values()].map((srv) => srv.stop(true)));
        boxListeners.clear();
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

/**
 * Parses `HEARTH_PUBLIC_ORIGIN`: an http(s) origin such as
 * `https://hearth.example`, returned in the form browsers send in `Origin`.
 * Unset or empty means none. Rejects paths, queries, fragments and
 * credentials instead of silently dropping them.
 */
export function parsePublicOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const invalid = () =>
    new Error(
      `Invalid public origin "${raw}": expected http(s)://host[:port] with nothing after it`,
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    /[?#]/.test(raw)
  ) {
    throw invalid();
  }
  return url.origin;
}
