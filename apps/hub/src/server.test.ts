import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@hearth/core";
import { type AppOptions, createApp } from "./app";
import { BOX_SOCKET_PATH, type BoxConnections } from "./box/connections";
import { parsePort, parsePublicOrigin, startHub } from "./server";

describe("GET /healthz", () => {
  test("returns 200 from the app", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", protocol: "1.0" });
  });

  test("unknown routes are 404", async () => {
    const res = await createApp().request("/nope");
    expect(res.status).toBe(404);
  });
});

/** An app whose `echo` answers its params and records the calls that got past the guard. */
function guardedApp(options?: AppOptions) {
  const calls: JsonValue[] = [];
  const boxes = {
    echo: async (_principal: unknown, _boxId: string, params: JsonValue) => {
      calls.push(params);
      return params;
    },
  } as unknown as BoxConnections;
  return { app: createApp({ boxes }, options), calls };
}

/** POST /v1/boxes/box_1/echo with a JSON body; `headers` override the defaults. */
async function echo(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
): Promise<Response> {
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
    const post = (headers: Record<string, string>) =>
      fetch(new URL("/v1/boxes/box_none/echo", hub.url), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
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
      headers: { "content-type": "application/json", host: `0.0.0.0:${hub.url.port}` },
      body: "1",
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(409);
  });

  test("/healthz and the box socket path ignore Host and Origin", async () => {
    const hub = start();
    const foreign = { host: "attacker.example", origin: "https://evil.example" };
    const health = await fetch(new URL("/healthz", hub.url), {
      headers: foreign,
      signal: AbortSignal.timeout(5_000),
    });
    expect(health.status).toBe(200);
    // A plain GET on the socket path still reaches the upgrade handler (426), not the guard.
    const socket = await fetch(new URL(BOX_SOCKET_PATH, hub.url), {
      headers: foreign,
      signal: AbortSignal.timeout(5_000),
    });
    expect(socket.status).toBe(426);
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
