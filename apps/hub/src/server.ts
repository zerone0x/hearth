import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import {
  AllowAllAuthorizer,
  type BoxId,
  type BoxProvider,
  type BoxSpec,
  createDefaultSecretStore,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  type Principal,
  type SecretRef,
  type SecretStore,
  VaultSecretResolver,
} from "@hearth/core";
import { createApp, hostKey, LOOPBACK_HOSTS } from "./app";
import { AuthService } from "./auth";
import {
  type AppliedDelivery,
  BOX_SOCKET_PATH,
  type BoxConnection,
  BoxConnections,
  type BoxConnectionsOptions,
} from "./box/connections";
import type { IssuedJoinToken } from "./box/credentials";
import {
  type BoxEgressCheck,
  type BoxEgressStatus,
  markerEgressCheck,
  requireBoxEgress,
} from "./box/egress";
import { ToolRpcClient } from "./box/tool-rpc";
import {
  DESKTOP_CLOSE,
  DesktopBridge,
  DesktopLocks,
  type DesktopSocketData,
  mountDesktopLockRoutes,
  mountDesktopRoute,
  type Upgrader,
} from "./desktop";
import { mountBlobRoutes, SessionBlobs } from "./obs/blobs";
import { mountTrajectoryRoutes, Trajectories } from "./obs/routes";
import { HUB_VERSION } from "./obs/version";
import { mountRunnerRoutes, SessionRunners, type SessionRunnersOptions } from "./runner";
import { mountSessionRoutes, SessionManager, type SessionManagerOptions } from "./session";
import {
  openDatabase,
  SqliteAuditSink,
  SqliteBlobStore,
  SqliteBoxCredentialStore,
  SqliteEventStore,
  SqliteLoginStore,
  SqliteSessionStore,
  SqliteVaultStore,
} from "./store";
import { HubVault, mountVaultRoutes } from "./vault";

/** `req.url` as a URL, or undefined when it is not absolute (an empty or malformed Host). */
function parseUrl(req: Request): URL | undefined {
  try {
    return new URL(req.url);
  } catch {
    return undefined;
  }
}

/** The one path the request guard exempts from the Host check (decision 0010). */
const HEALTHZ_PATH = "/healthz";

/**
 * A request whose `req.url` did not parse (`http://<Host><target>` with a
 * Host such as ":80" or "[::1"), rebuilt on a fixed placeholder host, when
 * its path is `/healthz`; undefined otherwise. The Host header is kept as
 * sent. `/healthz` takes no input and the request guard exempts it from the
 * Host check (decision 0010), so it answers whatever the Host, as it did
 * before issue #48; every other path keeps the refusal. A relative `req.url`
 * (an empty Host) never reached `/healthz` before either: it stays refused.
 */
function healthzOnPlaceholder(req: Request): Request | undefined {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(req.url);
  if (authority === null) return undefined;
  const target = req.url.slice(authority[0].length);
  const rawPath = target.split(/[?#]/, 1)[0] ?? "";
  let path: string;
  try {
    path = decodeURI(rawPath);
  } catch {
    return undefined;
  }
  if (path !== HEALTHZ_PATH) return undefined;
  return new Request(new URL(target, "http://hub.invalid").href, req);
}

function refusal(
  status: 400 | 404 | 411 | 413 | 421 | 426,
  code: string,
  message: string,
): Response {
  return Response.json({ ok: false, error: { code, owner: "user", message } }, { status });
}

/**
 * Largest request body the public listener accepts, in bytes (issue #105,
 * decision 0034): a message prompt plus labels is a few KiB, so 1 MiB leaves
 * ample room and still keeps a signed-in caller from parsing huge JSON.
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** The largest value Bun accepts for `maxRequestBodySize` (an unsigned 32-bit integer). */
const BUN_MAX_BODY_BYTES = 0xffff_ffff;

/**
 * The 413 or 411 answer for a request whose declared body is over `limit`
 * (or has no declared length), undefined when the request may go on. It reads
 * headers only, never the body.
 */
function bodyLimitRefusal(req: Request, limit: number): Response | undefined {
  if (req.headers.has("transfer-encoding")) {
    return closing(
      refusal(411, "request.length-required", "a request body needs a Content-Length"),
    );
  }
  const declared = req.headers.get("content-length");
  if (declared === null) return undefined;
  // Repeated Content-Length headers arrive joined ("10, 10") and are not digits.
  const length = /^\d+$/.test(declared.trim()) ? Number(declared.trim()) : Number.NaN;
  if (Number.isNaN(length) || length > limit) {
    return closing(refusal(413, "request.body-too-large", `the body is over ${limit} bytes`));
  }
  return undefined;
}

/** Ends the connection after a body refusal, so Bun does not drain the declared body. */
function closing(res: Response): Response {
  res.headers.set("connection", "close");
  return res;
}

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
  /** Largest request body of the public listener in bytes. Defaults to `DEFAULT_MAX_BODY_BYTES`. */
  readonly maxBodyBytes?: number;
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
  /** Built web UI to serve on the public listener (`apps/web/dist`, decision 0017). */
  readonly webRoot?: string;
  readonly log?: (line: string) => void;
  /**
   * The hub-side pi runner (#43, decision 0015): model, key reference,
   * deny-list, extension allowlist. Without it the message routes are not served.
   */
  readonly runner?: Omit<
    SessionRunnersOptions,
    "authorizer" | "events" | "sessions" | "tools" | "secrets" | "desktopLocks"
  > & {
    /** The runner's SecretStore. Default: the hub's own (`env:`, `file:`, `vault:`). */
    readonly secrets?: SecretStore;
  };
  /**
   * The vault (decision 0031): the key references and the store that resolves
   * them (`env:` / `file:` only). Without a key reference the vault is
   * disabled (`key-missing`); the hub runs on.
   */
  readonly vault?: {
    readonly keyRef?: SecretRef;
    readonly nextKeyRef?: SecretRef;
    /** Resolves the key references. Default `createDefaultSecretStore()`. */
    readonly keySecrets?: SecretStore;
  };
  /** Observes every applied box delivery before its ack (see `BoxConnections`). */
  readonly onApplied?: (applied: AppliedDelivery) => void;
  /** Deadline of the `echo` RPC (see `BoxConnections`). Only tests change it. */
  readonly echoDeadlineMs?: number;
  /** The hub's heartbeat on box connections (see `BoxConnections`, decision 0028). Tests change it. */
  readonly heartbeat?: BoxConnectionsOptions["heartbeat"];
  /** Image of session boxes (`HEARTH_BOX_IMAGE`). Defaults to `DEFAULT_BOX_IMAGE`. */
  readonly boxImage?: string;
  /** Lease of the desktop lock (decision 0033). Defaults to `DESKTOP_LOCK_TTL_MS`; tests change it. */
  readonly desktopLockTtlMs?: number;
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
  const blobs = new SqliteBlobStore(db);
  const credentials = new SqliteBoxCredentialStore(db);
  const sessionStore = new SqliteSessionStore(db);
  // The vault (decision 0031): opened in the background; a `vault:` resolve
  // waits for it. A missing or wrong key disables it and nothing else.
  const vault = new HubVault({
    store: new SqliteVaultStore(db),
    authorizer,
    audit,
    keySecrets: options.vault?.keySecrets ?? createDefaultSecretStore(),
    ...(options.vault?.keyRef === undefined ? {} : { keyRef: options.vault.keyRef }),
    ...(options.vault?.nextKeyRef === undefined ? {} : { nextKeyRef: options.vault.nextKeyRef }),
    // Its state goes to the hub's log; a hub without one (tests) stays quiet.
    log: options.log ?? (() => {}),
  });
  const vaultReady = vault.open();
  /** The hub's SecretStore: `env:`, `file:` and `vault:` (E7). */
  const secrets = createDefaultSecretStore({ resolvers: [new VaultSecretResolver(vault)] });
  const boxes = new BoxConnections({
    authorizer,
    events,
    credentials,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
    ...(options.echoDeadlineMs === undefined ? {} : { echoDeadlineMs: options.echoDeadlineMs }),
    ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
  });
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const boxEgress = options.boxEgress ?? markerEgressCheck();
  // The local login (decision 0014). Until the owner sets a password, the
  // setup token is logged: only whoever reads the hub's output can claim it.
  const auth = new AuthService({ store: new SqliteLoginStore(db) });
  const setupToken = auth.setupToken();
  if (setupToken !== undefined) {
    options.log?.(`first run: set the owner password with setup token ${setupToken}`);
  }
  const app = createApp(
    { boxes, auth },
    {
      allowedHosts: [...LOOPBACK_HOSTS, hostname],
      ...(options.provider === undefined ? {} : { boxEgress }),
      ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    },
  );

  // The public listener: the UI/API only, on loopback by default (PRD §10).
  // It never upgrades to the box socket; that path is a 404 here.
  // Its only WebSocket is the desktop of a session (decision 0016), accepted
  // by the route after the request and session guards ran.
  let server: Bun.Server<DesktopSocketData>;
  let desktop: DesktopBridge | undefined;
  try {
    server = Bun.serve<DesktopSocketData>({
      hostname,
      port: options.port ?? DEFAULT_PORT,
      // Bun answers an oversized Content-Length with a bare 413 before `fetch`
      // runs. The limit is checked below instead, so the answer is the JSON
      // envelope; Bun's own cap is raised to its maximum on purpose. Box
      // listeners and the desktop socket keep their own settings.
      maxRequestBodySize: BUN_MAX_BODY_BYTES,
      fetch: (req, srv) => {
        // The body limit (decision 0034) runs first: it reads headers only,
        // so an oversized request is refused before the request guard (0010),
        // the session guard and `authorize`, and learns nothing from them.
        const tooLarge = bodyLimitRefusal(req, maxBodyBytes);
        if (tooLarge !== undefined) return tooLarge;
        // A Host the HTTP layer cannot turn into a URL (an empty one) makes
        // `req.url` relative and every later `new URL` throw: answer it as the
        // request guard would (decision 0010) instead of a 500 (issue #48).
        // `/healthz` is exempt from the Host check, so it is still served.
        if (parseUrl(req) === undefined) {
          const healthz = healthzOnPlaceholder(req);
          if (healthz !== undefined) return app.fetch(healthz, srv);
          return refusal(421, "request.foreign-host", "the Host header is missing or malformed");
        }
        return app.fetch(req, srv);
      },
      websocket: {
        open(ws) {
          if (desktop === undefined) return ws.close(DESKTOP_CLOSE.shutdown, "not ready");
          const viewer = desktop.attach(ws, ws.data.ticket);
          if (viewer !== undefined) ws.data.viewer = viewer;
        },
        message(ws, message) {
          if (ws.data.viewer !== undefined) desktop?.message(ws.data.viewer, message);
        },
        drain(ws) {
          if (ws.data.viewer !== undefined) desktop?.flush(ws.data.viewer);
        },
        close(ws) {
          if (ws.data.viewer !== undefined) desktop?.closed(ws.data.viewer);
        },
      },
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
          const url = parseUrl(req);
          if (url === undefined) {
            return refusal(
              400,
              "request.invalid-url",
              "the request URL or Host header is malformed",
            );
          }
          if (url.pathname !== BOX_SOCKET_PATH) {
            return refusal(404, "request.not-found", "not found");
          }
          // The upgrade carries no credential: the box authenticates in its
          // first frame, `hello`, and `authorize` runs before anything else.
          if (srv.upgrade(req, { data: undefined })) return undefined;
          return refusal(426, "request.upgrade-required", "expected a WebSocket upgrade");
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
  // Trajectories and outcome labels (decision 0021): served with or without a runner.
  mountTrajectoryRoutes(
    app,
    new Trajectories({
      authorizer,
      events,
      sessions,
      versions: { pi: PI_VERSION, hub: HUB_VERSION },
    }),
  );
  // Screenshots and other images by hash (decision 0037).
  mountBlobRoutes(app, new SessionBlobs({ authorizer, blobs, sessions }));

  // The desktop lock (decision 0033): who may type on a session's desktop.
  // Made before the runners: their browser tools check it (decision 0035).
  const desktopLocks = new DesktopLocks({
    authorizer,
    sessions,
    events,
    ...(options.desktopLockTtlMs === undefined ? {} : { ttlMs: options.desktopLockTtlMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  // The runner (decision 0015): one pi session per hub session, tools routed
  // to the session's box through the tool RPC.
  // Only with a runner: the client claims every `tool_` rpc answer, so a second
  // client on the same connections (tests) would lose its answers to this one.
  const toolRpc =
    options.runner === undefined
      ? undefined
      : new ToolRpcClient({
          boxes,
          ...(options.log === undefined ? {} : { log: options.log }),
        });
  const runners =
    options.runner === undefined
      ? undefined
      : new SessionRunners({
          ...options.runner,
          secrets: options.runner.secrets ?? secrets,
          authorizer,
          events,
          blobs,
          sessions: {
            ensureBox: (sessionId) => sessions.ensureBox(sessionId),
            get: (principal, sessionId) => sessions.get(principal, sessionId),
            fail: (sessionId, reason) => sessions.fail(sessionId, reason),
          },
          tools: toolRpc as ToolRpcClient,
          desktopLocks,
          // browser_fill resolves logins through the vault (decision 0039).
          vault,
          ...(options.log === undefined ? {} : { log: options.log }),
        });
  if (runners !== undefined) mountRunnerRoutes(app, runners);
  mountVaultRoutes(app, vault);
  mountDesktopLockRoutes(app, desktopLocks);
  // The desktop stream (decision 0016): behind the login guard, owner only.
  desktop = new DesktopBridge({
    boxes,
    sessions,
    authorizer,
    locks: desktopLocks,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  mountDesktopRoute(app, desktop, auth, (c) => c.env as Upgrader | undefined);

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
    /** The local login: owner password and login sessions (decision 0014). */
    auth,
    /** The vault (decision 0031) and its first open. */
    vault,
    vaultReady,
    /** The hub's SecretStore: `env:`, `file:` and `vault:`. */
    secrets,
    /** The session manager: sessions, lazy box start, hibernate, supervision (decision 0013). */
    sessions,
    /** The pi runners (decision 0015), when `runner` is configured. */
    runners,
    /**
     * The desktop lock (decision 0033). Agent desktop and browser tools call
     * `desktopLocks.isDesktopLocked(sessionId)` or `assertUnlocked(sessionId)`
     * before they act (docs/runner.md).
     */
    desktopLocks,
    /** The tool RPC client the runners use, when `runner` is configured. */
    toolRpc,
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
      toolRpc?.close();
      void runners?.close();
      desktop?.shutdown();
      desktopLocks.shutdown();
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
