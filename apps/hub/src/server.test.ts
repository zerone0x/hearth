import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { parsePort, startHub } from "./server";

describe("GET /healthz", () => {
  test("returns 200 from the app", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", protocol: "1.1" });
  });

  test("unknown routes are 404", async () => {
    const res = await createApp().request("/nope");
    expect(res.status).toBe(404);
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

  test("serves /healthz over a real socket on loopback", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-server-"));
    server = startHub({ port: 0, dbPath: join(dir, "hub.db") });
    expect(server.server.hostname).toBe("127.0.0.1");
    const res = await fetch(new URL("/healthz", server.url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);
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
