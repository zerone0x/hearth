import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoxInfo,
  type BoxState,
  HearthError,
  type JsonValue,
  LOCAL_PRINCIPAL,
} from "@hearth/core";
import { type AppOptions, createApp } from "./app";
import { AuthService, SESSION_COOKIE } from "./auth";
import { BOX_SOCKET_PATH, type BoxConnections } from "./box/connections";
import {
  type BoxEgressCheck,
  boxEgressFromEnv,
  DEFAULT_BOX_EGRESS_MARKER,
  markerEgressCheck,
  UNRESTRICTED_EGRESS,
} from "./box/egress";
import { HUB_VERSION } from "./obs/version";
import { BOX_ENV, type BoxNetworkProvider, parsePort, parsePublicOrigin, startHub } from "./server";
import { openDatabase, SqliteLoginStore } from "./store";

const FILTERED: BoxEgressCheck = () => ({ state: "filtered", detail: "test" });
const spec = { boxId: "bx", workspaceId: "ws_default", sessionId: "se", image: "img" };

function boxInfo(boxId: string, state: BoxState = "running"): BoxInfo {
  return {
    boxId,
    workspaceId: "ws_default",
    sessionId: "se",
    state,
    image: "img",
    volumeRef: "v",
    labels: {},
    createdAt: 0,
  };
}

/** A provider whose boxes listen on loopback; `calls` records create, hubAddress and start. */
function stubProvider(
  calls: string[],
  overrides: Partial<BoxNetworkProvider> = {},
): BoxNetworkProvider {
  return {
    name: "stub",
    create: async (s) => {
      calls.push("create");
      return boxInfo(s.boxId);
    },
    hubAddress: async (boxId) => {
      calls.push(`hubAddress ${boxId}`);
      return "127.0.0.1";
    },
    start: async (s) => {
      calls.push("start");
      return boxInfo(s.boxId);
    },
    stop: async () => "stopped",
    destroy: async () => "destroyed",
    snapshot: async () => ({ kind: "not-supported" }),
    attach: async (boxId) => boxInfo(boxId),
    adopt: async () => [boxInfo("bx")],
    ...overrides,
  };
}

describe("GET /healthz", () => {
  test("returns 200 from the app", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", protocol: "1.2", version: HUB_VERSION });
  });

  test("every other route, known or not, needs a session (decision 0014)", async () => {
    const res = await createApp().request("/nope");
    expect(res.status).toBe(401);
  });
});

/** Something that answers `request` like a Hono app. */
interface Requester {
  request(input: string | Request, init?: RequestInit): Response | Promise<Response>;
}

/**
 * An app whose `echo` answers its params and records the calls that got past
 * the guard. Its `request` sends a live session cookie unless the request
 * already has a `cookie` header: these tests are about the request guard.
 */
function guardedApp(options?: AppOptions): { app: Requester; calls: JsonValue[] } {
  const calls: JsonValue[] = [];
  const boxes = {
    echo: async (_principal: unknown, _boxId: string, params: JsonValue) => {
      calls.push(params);
      return params;
    },
  } as unknown as BoxConnections;
  const auth = new AuthService({ store: new SqliteLoginStore(openDatabase(":memory:")) });
  const cookie = `${SESSION_COOKIE}=${auth.issueSession(LOCAL_PRINCIPAL).token}`;
  const app = createApp({ boxes, auth }, options);
  return {
    app: {
      request(input, init) {
        const req =
          typeof input === "string"
            ? new Request(`http://localhost${input}`, init)
            : new Request(input, init);
        if (!req.headers.has("cookie")) req.headers.set("cookie", cookie);
        return app.request(req);
      },
    },
    calls,
  };
}

/** POST /v1/boxes/box_1/echo with a JSON body; `headers` override the defaults. */
async function echo(app: Requester, headers: Record<string, string>): Promise<Response> {
  return await app.request("/v1/boxes/box_1/echo", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: '{"x":1}',
  });
}

describe("request guard (decision 0010)", () => {
  test("a same-origin JSON call from the loopback UI passes", async () => {
    const { app, calls } = guardedApp();
    const cases: Record<string, string>[] = [
      {},
      { host: "localhost:8787", origin: "http://localhost:8787" },
      { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "sec-fetch-site": "same-origin" },
      { host: "[::1]:8787", origin: "http://[::1]:8787" },
      { host: "LOCALHOST:8787" },
      { host: "127.0.0.1", "sec-fetch-site": "none" },
      { "content-type": "application/json; charset=utf-8" },
      { "content-type": "Application/JSON" },
    ];
    for (const headers of cases) {
      const res = await echo(app, headers);
      expect({ headers, status: res.status }).toEqual({ headers, status: 200 });
      expect(await res.json()).toEqual({ ok: true, result: { x: 1 } });
    }
    expect(calls).toHaveLength(cases.length);
  });

  test("a foreign Host gets 421 before the handler runs (DNS rebinding)", async () => {
    const { app, calls } = guardedApp();
    for (const host of [
      "attacker.example",
      "attacker.example:8787",
      "localhost.attacker.example:8787",
      "127.0.0.1.nip.io:8787",
      "evil@127.0.0.1:8787",
      "127.0.0.1:8787/x",
      "localhost.:8787",
      "",
    ]) {
      const res = await echo(app, { host });
      expect({ host, status: res.status }).toEqual({ host, status: 421 });
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { code: "request.foreign-host" },
      });
    }
    expect(calls).toHaveLength(0);
  });

  test("proxy headers never stand in for Host (X-Forwarded-*, Forwarded)", async () => {
    const { app, calls } = guardedApp();
    for (const [name, loopback, foreign] of [
      ["x-forwarded-host", "127.0.0.1", "attacker.example"],
      ["x-forwarded-for", "127.0.0.1", "203.0.113.7"],
      ["forwarded", "host=127.0.0.1", "host=attacker.example"],
    ] as const) {
      const spoofed = await echo(app, { host: "attacker.example", [name]: loopback });
      expect({ name, status: spoofed.status }).toEqual({ name, status: 421 });
      const ignored = await echo(app, { host: "127.0.0.1", [name]: foreign });
      expect({ name, status: ignored.status }).toEqual({ name, status: 200 });
    }
    expect(calls).toHaveLength(3);
  });

  test("a cross-origin Origin gets 403 before the handler runs (CSRF)", async () => {
    const { app, calls } = guardedApp();
    for (const origin of [
      "https://evil.example",
      "null",
      "http://localhost:3000",
      "https://localhost:8787",
      "http://127.0.0.1:8787",
    ]) {
      const res = await echo(app, { host: "localhost:8787", origin });
      expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { code: "request.cross-origin" },
      });
    }
    expect(calls).toHaveLength(0);
  });

  test("Sec-Fetch-Site cross-site or same-site without an Origin gets 403", async () => {
    const { app, calls } = guardedApp();
    for (const site of ["cross-site", "same-site", "Cross-Site"]) {
      const res = await echo(app, { "sec-fetch-site": site });
      expect({ site, status: res.status }).toEqual({ site, status: 403 });
    }
    expect(calls).toHaveLength(0);
  });

  test("a body that is not declared JSON gets 415, even if it parses as JSON", async () => {
    const { app, calls } = guardedApp();
    for (const type of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/jsonp",
      "",
    ]) {
      const res = await echo(app, { "content-type": type });
      expect({ type, status: res.status }).toEqual({ type, status: 415 });
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { code: "request.unsupported-media-type" },
      });
    }
    // No Content-Type at all (`Request` adds text/plain for a string body, so drop it).
    const bare = new Request("http://localhost/v1/boxes/box_1/echo", {
      method: "POST",
      body: "{}",
    });
    bare.headers.delete("content-type");
    expect((await app.request(bare)).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  test("the configured public origin passes, behind a Host-preserving or rewriting proxy", async () => {
    const { app, calls } = guardedApp({ publicOrigin: "https://hearth.example" });
    const cases: Record<string, string>[] = [
      { host: "hearth.example", origin: "https://hearth.example" },
      { host: "127.0.0.1:8787", origin: "https://hearth.example" },
      { host: "hearth.example" },
    ];
    for (const headers of cases) {
      const res = await echo(app, headers);
      expect({ headers, status: res.status }).toEqual({ headers, status: 200 });
    }
    expect((await echo(app, { origin: "https://evil.example" })).status).toBe(403);
    expect((await echo(app, { origin: "http://hearth.example" })).status).toBe(403);
    expect((await echo(app, { host: "attacker.example" })).status).toBe(421);
    expect(calls).toHaveLength(cases.length);

    // Without the option, the same origin and host are foreign.
    const plain = guardedApp().app;
    expect((await echo(plain, { origin: "https://hearth.example" })).status).toBe(403);
    expect((await echo(plain, { host: "hearth.example" })).status).toBe(421);
  });

  test("the guard checks Host, then Origin, then the content type", async () => {
    const { app } = guardedApp();
    const all = {
      host: "attacker.example",
      origin: "https://evil.example",
      "content-type": "text/plain",
    };
    expect((await echo(app, all)).status).toBe(421);
    expect((await echo(app, { ...all, host: "localhost" })).status).toBe(403);
    expect(
      (await echo(app, { ...all, host: "localhost", origin: "http://localhost" })).status,
    ).toBe(415);
  });

  test("/healthz is left alone", async () => {
    const { app } = guardedApp();
    const res = await app.request("/healthz", {
      headers: {
        host: "attacker.example",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(res.status).toBe(200);
  });
});

describe("startHub", () => {
  let server: ReturnType<typeof startHub> | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function start(options: { hostname?: string; publicOrigin?: string } = {}) {
    dir = mkdtempSync(join(tmpdir(), "hearth-server-"));
    server = startHub({ port: 0, dbPath: join(dir, "hub.db"), ...options });
    return server;
  }

  /** A `cookie` header with a fresh login session on `hub`. */
  function signedIn(hub: ReturnType<typeof startHub>): { cookie: string } {
    return { cookie: `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}` };
  }

  test("the session API (decision 0013) is behind the login (decision 0014)", async () => {
    const hub = start();
    const routes: [string, string][] = [
      ["POST", "/v1/sessions"],
      ["GET", "/v1/sessions"],
      ["GET", "/v1/sessions/ses_none"],
      ["POST", "/v1/sessions/ses_none/archive"],
    ];
    const call = (method: string, path: string, headers: Record<string, string> = {}) =>
      fetch(new URL(path, hub.url), {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
        signal: AbortSignal.timeout(5_000),
      });
    for (const [method, path] of routes) {
      const res = await call(method, path);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "auth.required" } });
    }
    expect(await hub.sessions.list(LOCAL_PRINCIPAL)).toHaveLength(0);
    // With a login session the same routes reach the session manager.
    const session = signedIn(hub);
    expect((await call("GET", "/v1/sessions", session)).status).toBe(200);
    expect((await call("GET", "/v1/sessions/ses_none", session)).status).toBe(404);
  });

  test("serves /healthz over a real socket on loopback", async () => {
    const hub = start();
    expect(hub.server.hostname).toBe("127.0.0.1");
    const res = await fetch(new URL("/healthz", hub.url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);
  });

  test("the auditor's probes are refused over a real socket", async () => {
    const hub = start({ publicOrigin: "https://hearth.example" });
    const session = signedIn(hub);
    const post = (headers: Record<string, string>) =>
      fetch(new URL("/v1/boxes/box_none/echo", hub.url), {
        method: "POST",
        headers: { "content-type": "application/json", ...session, ...headers },
        body: JSON.stringify({ x: 1 }),
        signal: AbortSignal.timeout(5_000),
      });

    expect((await post({ host: "attacker.example" })).status).toBe(421);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ "content-type": "text/plain" })).status).toBe(415);

    // Allowed calls get past the guard to the handler: no box is connected, so 409.
    const allowed: Record<string, string>[] = [
      {},
      { origin: `http://${hub.url.host}` },
      { origin: "https://hearth.example" },
      { host: "hearth.example", origin: "https://hearth.example" },
    ];
    for (const headers of allowed) {
      const res = await post(headers);
      expect({ headers, status: res.status }).toEqual({ headers, status: 409 });
      expect(await res.json()).toMatchObject({ error: { code: "box.not-connected" } });
    }
  });

  test("the bound address is an allowed Host", async () => {
    const hub = start({ hostname: "0.0.0.0" });
    const res = await fetch(new URL("/v1/boxes/box_none/echo", hub.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: `0.0.0.0:${hub.url.port}`,
        ...signedIn(hub),
      },
      body: "1",
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(409);
  });

  test("/healthz ignores Host and Origin", async () => {
    const hub = start();
    const foreign = { host: "attacker.example", origin: "https://evil.example" };
    const health = await fetch(new URL("/healthz", hub.url), {
      headers: foreign,
      signal: AbortSignal.timeout(5_000),
    });
    expect(health.status).toBe(200);
  });

  test("the public listener does not serve the box socket", async () => {
    const hub = start();
    // Through the guard to the app: never the upgrade handler (426). Without a
    // session that is 401 (decision 0014), with one the app's 404.
    const socket = await fetch(new URL(BOX_SOCKET_PATH, hub.url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(socket.status).toBe(401);
    const signedInSocket = await fetch(new URL(BOX_SOCKET_PATH, hub.url), {
      headers: signedIn(hub),
      signal: AbortSignal.timeout(5_000),
    });
    expect(signedInSocket.status).toBe(404);
    const opened = await new Promise<string>((resolve) => {
      const ws = new WebSocket(new URL(BOX_SOCKET_PATH, hub.url.href.replace("http", "ws")));
      ws.onopen = () => {
        ws.close();
        resolve("open");
      };
      ws.onerror = () => resolve("refused");
    });
    expect(opened).toBe("refused");
  });

  test("a box listener serves the box socket and nothing else, whatever Host and Origin", async () => {
    const hub = start();
    const url = new URL(hub.listenForBoxes("127.0.0.1").replace("ws", "http"));
    expect(url.port).not.toBe(hub.url.port);
    expect(hub.listenForBoxes("127.0.0.1")).toBe(url.href.replace("http", "ws"));
    const foreign = { host: "attacker.example", origin: "https://evil.example" };
    const socket = await fetch(url, { headers: foreign, signal: AbortSignal.timeout(5_000) });
    expect(socket.status).toBe(426);
    for (const path of ["/healthz", "/v1/boxes/box_none/echo"]) {
      const res = await fetch(new URL(path, url), {
        method: path === "/healthz" ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(path === "/healthz" ? {} : { body: "{}" }),
        signal: AbortSignal.timeout(5_000),
      });
      expect(res.status).toBe(404);
    }
  });

  test("box listeners never bind every interface", () => {
    const hub = start();
    for (const any of ["0.0.0.0", "::", "[::]", ""]) {
      expect(() => hub.listenForBoxes(any)).toThrow("box-network address");
    }
    expect(hub.boxListeners.size).toBe(0);
  });

  test("by default the hub has no box listener and the public listener is loopback", () => {
    const hub = start();
    expect(hub.server.hostname).toBe("127.0.0.1");
    expect(hub.boxListeners.size).toBe(0);
  });

  test("startBox creates the box, listens on its hub address, then boots it with that URL", async () => {
    const calls: string[] = [];
    let bootEnv: Readonly<Record<string, string>> = {};
    const provider = stubProvider(calls, {
      start: async (spec, boot) => {
        calls.push("start");
        bootEnv = boot.env;
        return boxInfo(spec.boxId);
      },
    });
    dir = mkdtempSync(join(tmpdir(), "hearth-server-"));
    server = startHub({
      port: 0,
      boxPort: 0,
      provider,
      boxEgress: FILTERED,
      dbPath: join(dir, "hub.db"),
    });
    await server.startBox(LOCAL_PRINCIPAL, spec);
    expect(calls).toEqual(["create", "hubAddress bx", "start"]);
    const listener = server.boxListeners.get("127.0.0.1");
    expect(listener).toBeDefined();
    expect(bootEnv[BOX_ENV.hubUrl]).toBe(`ws://127.0.0.1:${listener?.port}${BOX_SOCKET_PATH}`);
    expect(bootEnv[BOX_ENV.joinToken]).toMatch(/^hjt_/);
    expect(await server.listenForRunningBoxes()).toEqual({ listening: ["bx"], failed: [] });
    expect(server.boxListeners.size).toBe(1);
  });

  test("startBox without a provider fails as the hub's", async () => {
    const hub = start();
    await expect(hub.startBox(LOCAL_PRINCIPAL, spec)).rejects.toMatchObject({
      code: "box.no-provider",
      owner: "hub",
    });
  });
});

describe("box egress gate (decision 0012)", () => {
  let server: ReturnType<typeof startHub> | undefined;
  let dir = "";
  let lines: string[] = [];
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function start(boxEgress: BoxEgressCheck | undefined, calls: string[] = []) {
    dir = mkdtempSync(join(tmpdir(), "hearth-egress-"));
    lines = [];
    server = startHub({
      port: 0,
      boxPort: 0,
      provider: stubProvider(calls),
      ...(boxEgress === undefined ? {} : { boxEgress }),
      dbPath: join(dir, "hub.db"),
      log: (line) => lines.push(line),
    });
    return server;
  }

  async function healthEgress(hub: ReturnType<typeof startHub>): Promise<unknown> {
    const res = await fetch(new URL("/healthz", hub.url), { signal: AbortSignal.timeout(5_000) });
    return ((await res.json()) as { boxEgress?: unknown }).boxEgress;
  }

  test("without the firewall marker startBox is refused as the box's, before anything starts", async () => {
    const calls: string[] = [];
    const hub = start(markerEgressCheck("/nonexistent/hearth/box-egress.applied"), calls);
    expect(lines.some((l) => l.startsWith("WARNING: box egress unfiltered"))).toBe(true);
    const refused = hub.startBox(LOCAL_PRINCIPAL, spec);
    await expect(refused).rejects.toBeInstanceOf(HearthError);
    await expect(refused).rejects.toMatchObject({
      code: "box.egress-unfiltered",
      owner: "box",
      disposition: "give-up",
    });
    await expect(refused).rejects.toThrow("box-firewall.sh apply");
    expect(calls).toEqual([]);
    expect(hub.boxListeners.size).toBe(0);
    expect(hub.boxEgress().state).toBe("unfiltered");
    expect(await healthEgress(hub)).toBe("unfiltered");
  });

  test("with the marker startBox works, and the marker is read on every start", async () => {
    const calls: string[] = [];
    const markerDir = mkdtempSync(join(tmpdir(), "hearth-marker-"));
    try {
      const marker = join(markerDir, "box-egress.applied");
      // The test user stands in for root as the marker's owner (decision 0023).
      const hub = start(markerEgressCheck(marker, { owner: process.getuid?.() ?? 0 }), calls);
      await expect(hub.startBox(LOCAL_PRINCIPAL, spec)).rejects.toMatchObject({
        code: "box.egress-unfiltered",
      });
      writeFileSync(marker, "applied\n");
      await hub.startBox(LOCAL_PRINCIPAL, spec);
      expect(calls).toEqual(["create", "hubAddress bx", "start"]);
      expect(hub.boxEgress().state).toBe("filtered");
      expect(await healthEgress(hub)).toBe("filtered");
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });

  test("a hub that finds the marker at start logs no warning", () => {
    start(FILTERED);
    expect(lines.filter((l) => l.startsWith("WARNING"))).toEqual([]);
  });

  test("HEARTH_BOX_EGRESS=unrestricted starts boxes and says so on start", async () => {
    const calls: string[] = [];
    const hub = start(boxEgressFromEnv({ HEARTH_BOX_EGRESS: "unrestricted" }), calls);
    expect(lines.filter((l) => l.startsWith("WARNING"))).toEqual([
      `WARNING: box egress unrestricted: ${UNRESTRICTED_EGRESS().detail}`,
    ]);
    await hub.startBox(LOCAL_PRINCIPAL, spec);
    expect(calls).toEqual(["create", "hubAddress bx", "start"]);
    expect(await healthEgress(hub)).toBe("unrestricted");
  });

  test("by default the hub checks the marker under /run", () => {
    const hub = start(undefined);
    const expected = existsSync(DEFAULT_BOX_EGRESS_MARKER) ? "filtered" : "unfiltered";
    expect(hub.boxEgress().state).toBe(expected);
  });

  test("a hub without a provider reports no egress state", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-egress-"));
    server = startHub({ port: 0, dbPath: join(dir, "hub.db") });
    expect(await healthEgress(server)).toBeUndefined();
  });
});

describe("boxEgressFromEnv", () => {
  test("defaults to the marker under /run; HEARTH_BOX_EGRESS_MARKER moves it", () => {
    const missing = boxEgressFromEnv({ HEARTH_BOX_EGRESS_MARKER: "/nonexistent/marker" })();
    expect(missing.state).toBe("unfiltered");
    expect(missing.detail).toContain("/nonexistent/marker");
    expect(boxEgressFromEnv({ HEARTH_BOX_EGRESS: "filtered" })().detail).toContain(
      DEFAULT_BOX_EGRESS_MARKER,
    );
    expect(boxEgressFromEnv({})().detail).toContain(DEFAULT_BOX_EGRESS_MARKER);
  });

  test("unrestricted is the explicit opt-out; anything else is refused", () => {
    expect(boxEgressFromEnv({ HEARTH_BOX_EGRESS: "unrestricted" })().state).toBe("unrestricted");
    expect(() => boxEgressFromEnv({ HEARTH_BOX_EGRESS: "off" })).toThrow("HEARTH_BOX_EGRESS");
  });
});

describe("listenForRunningBoxes", () => {
  let server: ReturnType<typeof startHub> | undefined;
  let dir = "";
  let lines: string[] = [];
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function start(provider: BoxNetworkProvider) {
    dir = mkdtempSync(join(tmpdir(), "hearth-adopt-"));
    lines = [];
    server = startHub({
      port: 0,
      boxPort: 0,
      provider,
      boxEgress: FILTERED,
      dbPath: join(dir, "hub.db"),
      log: (line) => lines.push(line),
    });
    return server;
  }

  test("a fresh hub opens the listener of every running box, and only of running boxes", async () => {
    const calls: string[] = [];
    const hub = start(
      stubProvider(calls, {
        adopt: async () => [boxInfo("up"), boxInfo("down", "stopped"), boxInfo("gone", "exited")],
      }),
    );
    expect(hub.boxListeners.size).toBe(0);
    expect(await hub.listenForRunningBoxes()).toEqual({ listening: ["up"], failed: [] });
    expect(calls).toEqual(["hubAddress up"]);
    expect([...hub.boxListeners.keys()]).toEqual(["127.0.0.1"]);
  });

  test("one box that fails does not keep the others from their listeners", async () => {
    const calls: string[] = [];
    const broken = new Error("network hearth-box-a does not exist");
    const hub = start(
      stubProvider(calls, {
        adopt: async () => [boxInfo("a"), boxInfo("b")],
        hubAddress: async (boxId) => {
          calls.push(`hubAddress ${boxId}`);
          if (boxId === "a") throw broken;
          return "127.0.0.1";
        },
      }),
    );
    expect(await hub.listenForRunningBoxes()).toEqual({
      listening: ["b"],
      failed: [{ boxId: "a", error: broken }],
    });
    expect(hub.boxListeners.size).toBe(1);
    expect(lines).toContain(`could not listen again for box a: ${String(broken)}`);
  });

  test("retries with backoff while the provider cannot list its boxes", async () => {
    let attempts = 0;
    const hub = start(
      stubProvider([], {
        adopt: async () => {
          attempts++;
          if (attempts < 3) throw new Error("connect ENOENT /var/run/docker.sock");
          return [boxInfo("bx")];
        },
      }),
    );
    expect(await hub.listenForRunningBoxes({ delayMs: 1, maxDelayMs: 2 })).toEqual({
      listening: ["bx"],
      failed: [],
    });
    expect(attempts).toBe(3);
    expect(lines.filter((l) => l.startsWith("could not list running boxes"))).toEqual([
      "could not list running boxes (attempt 1), retrying in 1 ms: Error: connect ENOENT /var/run/docker.sock",
      "could not list running boxes (attempt 2), retrying in 2 ms: Error: connect ENOENT /var/run/docker.sock",
    ]);
  });

  test("stops retrying once the hub stops", async () => {
    const hub = start(
      stubProvider([], {
        adopt: async () => {
          throw new Error("daemon down");
        },
      }),
    );
    const pending = hub.listenForRunningBoxes({ delayMs: 5 });
    await Bun.sleep(20);
    await hub.stop();
    expect(await pending).toEqual({ listening: [], failed: [] });
  });
});

describe("parsePort", () => {
  test("falls back when unset or empty", () => {
    expect(parsePort(undefined)).toBe(8787);
    expect(parsePort("")).toBe(8787);
  });

  test("accepts valid ports", () => {
    expect(parsePort("0")).toBe(0);
    expect(parsePort("3000")).toBe(3000);
  });

  test("rejects garbage instead of falling back", () => {
    for (const bad of ["abc", "-1", "65536", "80.5"]) {
      expect(() => parsePort(bad)).toThrow(`Invalid port "${bad}"`);
    }
  });
});

describe("parsePublicOrigin", () => {
  test("unset or empty means no public origin", () => {
    expect(parsePublicOrigin(undefined)).toBeUndefined();
    expect(parsePublicOrigin("")).toBeUndefined();
  });

  test("returns the origin the way browsers send it", () => {
    expect(parsePublicOrigin("https://hearth.example")).toBe("https://hearth.example");
    expect(parsePublicOrigin("https://Hearth.Example/")).toBe("https://hearth.example");
    expect(parsePublicOrigin("https://hearth.example:443")).toBe("https://hearth.example");
    expect(parsePublicOrigin("http://10.0.0.5:8080")).toBe("http://10.0.0.5:8080");
  });

  test("rejects anything that is not a bare http(s) origin", () => {
    for (const bad of [
      "hearth.example",
      "ftp://hearth.example",
      "https://hearth.example/app",
      "https://hearth.example/?x=1",
      "https://hearth.example/#top",
      "https://user:pw@hearth.example",
      "https://user@hearth.example",
      "*",
    ]) {
      expect(() => parsePublicOrigin(bad)).toThrow(`Invalid public origin "${bad}"`);
    }
  });
});
