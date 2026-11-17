/**
 * Hub-side observability fixes from the review of #82 (decision 0021): log
 * levels, components and ids on hub lines; a build-time hub version; secrets
 * registered at startup so the CLI and the API redact a key an older build
 * stored raw; telemetry shutdown that never hangs or rejects; turn labels
 * that must name a turn of the session.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PRINCIPAL, Logger, type SecretStore } from "@hearth/core";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import { Hono } from "hono";
import type { HubEnv } from "../auth";
import { registerStartupSecrets } from "../main";
import { openDatabase, SqliteEventStore } from "../store";
import { dumpTrajectory } from "../trajectory-cli";
import { hubLines, lineFields, lineLevel } from "./hub-log";
import { redactHub } from "./redaction";
import { mountTrajectoryRoutes, Trajectories } from "./routes";
import { Telemetry } from "./telemetry";
import { gitShaOf, HUB_VERSION, hubVersion } from "./version";

const dirs: string[] = [];
const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-hub-obs-"));
  dirs.push(dir);
  return dir;
}

/** A SecretStore that knows `values` by reference and fails on any other. */
function store(values: Record<string, string>): SecretStore {
  return {
    resolve: async (ref: string) => {
      const value = values[ref];
      if (value === undefined) throw new Error(`no secret at ${ref}`);
      return { reveal: () => value };
    },
  } as unknown as SecretStore;
}

describe("hub log lines: level, component and ids", () => {
  test("the lines the hub writes get the right level", () => {
    // server.ts, decision 0012: an unfiltered box egress is a warning.
    expect(lineLevel("WARNING: box egress unfiltered: the firewall marker is missing")).toBe(
      "warn",
    );
    // Docker failures reach the log through the session manager and the server.
    expect(
      lineLevel("session se_1: could not stop box bx_1: connect ENOENT /var/run/docker.sock"),
    ).toBe("error");
    expect(lineLevel("session se_1: relaunch failed: docker: no such image")).toBe("error");
    expect(
      lineLevel(
        "could not list running boxes (attempt 2), retrying in 2000 ms: Error: ECONNREFUSED",
      ),
    ).toBe("error");
    expect(lineLevel("box bx_1: join token rejected (expired)")).toBe("warn");
    expect(lineLevel("box bx_1: ignored unexpected hello frame")).toBe("warn");
    expect(lineLevel("box listener on http://172.18.0.1:8788")).toBe("info");
    expect(lineLevel("first run: set the owner password with setup token hst_abc123")).toBe("info");
    // Bifrost (decision 0046).
    expect(lineLevel("bifrost: ok")).toBe("info");
    expect(lineLevel("bifrost: unreachable (HTTP 503)")).toBe("warn");
    expect(lineLevel("bifrost: vault-disabled (the secrets live in the vault)")).toBe("warn");
    expect(lineLevel("bifrost: unauthorized (the admin password was refused)")).toBe("error");
    expect(lineLevel("bifrost: box-reachable (the allow list covers it)")).toBe("error");
    expect(lineLevel("bifrost: could not push the provider keys: HTTP 500")).toBe("error");
    expect(lineFields("bifrost: ok")).toEqual({ component: "bifrost" });
  });

  test("component and ids come from the line", () => {
    expect(lineFields("session se_9: hibernate failed: x")).toEqual({
      component: "session",
      session_id: "se_9",
    });
    expect(lineFields("session se_9: could not stop box bx_9: gone")).toEqual({
      component: "session",
      session_id: "se_9",
      box_id: "bx_9",
    });
    expect(lineFields("tool rpc: could not cancel r1: box bx_2 is gone")).toMatchObject({
      component: "tool-rpc",
      box_id: "bx_2",
    });
    expect(lineFields("WARNING: box egress unrestricted: owner's choice")).toEqual({
      component: "box",
    });
    expect(lineFields("session se_3: tracer: boom in turn_7")).toMatchObject({
      component: "runner",
      session_id: "se_3",
      turn_id: "turn_7",
    });
    expect(lineFields("first run: set the owner password with setup token hst_x")).toEqual({
      component: "auth",
    });
    expect(lineFields("something else")).toEqual({ component: "hub" });
  });

  test("through the logger: a JSON line with the text unchanged (the install greps the setup token)", () => {
    const out: string[] = [];
    const log = hubLines(new Logger({ component: "hub", sink: (l) => out.push(l) }));
    log("first run: set the owner password with setup token hst_AbC-123_x");
    log("WARNING: box egress unfiltered: no marker");
    log("session se_1: could not stop box bx_1: docker down");
    const [token, warn, err] = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(token).toMatchObject({
      level: "info",
      component: "auth",
      msg: "first run: set the owner password with setup token hst_AbC-123_x",
    });
    expect(warn).toMatchObject({ level: "warn", component: "box" });
    expect(err).toMatchObject({
      level: "error",
      component: "session",
      session_id: "se_1",
      box_id: "bx_1",
    });
  });
});

describe("hub version", () => {
  test("a build-time HEARTH_VERSION wins, then the git commit, then package.json", () => {
    expect(hubVersion({ HEARTH_VERSION: "v1.2.3-abc" }, "0.0.0", () => "deadbeef1234")).toBe(
      "v1.2.3-abc",
    );
    expect(hubVersion({ HEARTH_VERSION: " " }, "0.0.0", () => "deadbeef1234")).toBe(
      "0.0.0+gdeadbeef1234",
    );
    expect(hubVersion({}, "0.0.0", () => undefined)).toBe("0.0.0");
  });

  test("from this checkout: the commit is in the version, and none outside a checkout", () => {
    const sha = gitShaOf(import.meta.dir);
    const fromEnv = process.env["HEARTH_VERSION"];
    if ((fromEnv === undefined || fromEnv === "") && sha !== undefined) {
      expect(sha).toMatch(/^[0-9a-f]{12}$/);
      expect(HUB_VERSION).toBe(`0.0.0+g${sha}`);
    }
    expect(gitShaOf(tempDir())).toBeUndefined();
  });
});

describe("secrets known from startup (a key stored raw by an older build)", () => {
  async function legacyDb(key: string): Promise<string> {
    const path = join(tempDir(), "hub.db");
    const db = openDatabase(path);
    // What builds before #80 stored: the prompt as typed.
    await new SqliteEventStore(db).append({ workspaceId: "ws_default" }, "se_legacy", {
      type: "message.user",
      payload: { text: `here is my key ${key} please use it` },
    });
    db.close();
    return path;
  }

  test("the trajectory CLI resolves HEARTH_MODEL_KEY_REF and redacts the raw key", async () => {
    const key = "AIzaSyD-LEGACYKEY0123456789abcdefCLI";
    const path = await legacyDb(key);
    const warnings: string[] = [];
    const out = await dumpTrajectory(path, "se_legacy", {
      secrets: store({ "env:MODEL_KEY": key }),
      keyRefs: ["env:MODEL_KEY", "env:MISSING"],
      warn: (m) => warnings.push(m),
    });
    expect(out).toContain("here is my key [redacted] please use it");
    expect(out).not.toContain(key);
    // A reference that does not resolve is reported, and the rest still applies.
    expect(warnings).toEqual([expect.stringContaining("env:MISSING")]);
  });

  test("the API after a restart: secrets registered at startup redact the stored raw key", async () => {
    const key = "AIzaSyD-LEGACYKEY0123456789abcdefAPI";
    const path = await legacyDb(key);
    // A fresh process has registered nothing yet.
    expect(redactHub(key)).toBe(key);
    // What main.ts runs before the hub starts: the configured model key.
    const warned: string[] = [];
    const log = { warn: (m: string) => warned.push(m) };
    await registerStartupSecrets(store({ "file:/k": key }), undefined, log);
    expect(redactHub(key)).toBe(key);
    await registerStartupSecrets(store({ "file:/k": key }), { apiKeyRef: "file:/k" }, log);
    expect(redactHub(key)).toBe("[redacted]");
    await registerStartupSecrets(store({}), { apiKeyRef: "file:/gone" }, log);
    expect(warned).toEqual([expect.stringContaining("file:/gone")]);
    const db = openDatabase(path);
    closers.push(() => db.close());
    const app = new Hono<HubEnv>();
    app.use(async (c, next) => {
      c.set("principal", LOCAL_PRINCIPAL);
      await next();
    });
    mountTrajectoryRoutes(
      app,
      new Trajectories({
        authorizer: { authorize: async () => ({ allowed: true, policy: "test" }) },
        events: new SqliteEventStore(db),
        sessions: { get: async () => ({}) },
        versions: { pi: "p", hub: "h" },
      }),
    );
    const body = await (await app.request("/v1/sessions/se_legacy/trajectory")).text();
    expect(body).toContain("here is my key [redacted]");
    expect(body).not.toContain(key);
  });
});

describe("main.ts registers the model key before it serves", () => {
  function freePort(): number {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = s.port as number;
    s.stop(true);
    return port;
  }

  test("the hub process resolves HEARTH_MODEL_KEY_REF for redaction before it listens", async () => {
    const dir = tempDir();
    const ref = `file:${join(dir, "missing-key")}`;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "main.ts")], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? dir,
        HEARTH_DATA_DIR: join(dir, "data"),
        HEARTH_PORT: String(freePort()),
        HEARTH_BOX_PORT: String(freePort()),
        HEARTH_MODEL: "m",
        HEARTH_MODEL_PROVIDER: "anthropic",
        HEARTH_MODEL_KEY_REF: ref,
        // No Docker needed: the hub logs the failed box listing and keeps serving.
        HEARTH_DOCKER_SOCKET: join(dir, "no-docker.sock"),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    closers.push(() => proc.kill());
    // A missing key file is a warning (redaction of the rest still applies), so
    // the attempt to register it shows in the log, before the listening line.
    const lines: string[] = [];
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    const deadline = Date.now() + 20_000;
    let buffered = "";
    // One read stays pending until it resolves. Racing a fresh reader.read()
    // against a timer each turn drops the chunk of the read that lost the race,
    // which under load loses the warning line.
    let pending: ReturnType<typeof reader.read> | undefined;
    while (!lines.some((l) => l.includes("listening on")) && Date.now() < deadline) {
      pending ??= reader.read();
      const next = await Promise.race([pending, Bun.sleep(1_000).then(() => undefined)]);
      if (next === undefined) continue;
      pending = undefined;
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      lines.push(...parts);
    }
    proc.kill();
    const listening = lines.findIndex((l) => l.includes("listening on"));
    const registered = lines.findIndex((l) => l.includes(`could not resolve ${ref} for redaction`));
    expect(listening).toBeGreaterThan(-1);
    expect(registered).toBeGreaterThan(-1);
    expect(registered).toBeLessThan(listening);
    // startHub logs the setup token before it binds (Bun.serve), and the data
    // directory is new, so this line always comes: the key must be registered
    // before the hub can answer anything, not only before "listening on".
    const serving = lines.findIndex((l) => l.includes("set the owner password with setup token"));
    expect(serving).toBeGreaterThan(-1);
    expect(registered).toBeLessThan(serving);
  }, 30_000);
});

describe("AGENTS.md in the trajectory (runner.context, stored as read)", () => {
  test("the API and the CLI redact a registered key before the 16 KiB cut", async () => {
    const key = "AIzaSyD-CONTEXTKEY0123456789abcdefCTX";
    await registerStartupSecrets(
      store({ "file:/c": key }),
      { apiKeyRef: "file:/c" },
      {
        warn: () => {},
      },
    );
    // The key across the cut, still over the cap after redaction.
    const content = `${"a".repeat(16 * 1024 - 10)}${key}${"b".repeat(100)}`;
    const path = join(tempDir(), "hub.db");
    const db = openDatabase(path);
    await new SqliteEventStore(db).append({ workspaceId: "ws_default" }, "se_ctx", {
      type: "runner.context",
      payload: { files: [{ path: "/workspace/AGENTS.md", content }] },
    });
    db.close();
    const head = `${"a".repeat(16 * 1024 - 10)}[redacted]`;
    const noPrefix = (out: string) => {
      for (let n = 4; n <= key.length; n++) expect(out).not.toContain(key.slice(0, n));
    };
    const cli = await dumpTrajectory(path, "se_ctx", { secrets: store({}), keyRefs: [] });
    const fromCli = cli
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r["kind"] === "context");
    expect(fromCli).toMatchObject({
      files: [{ path: "/workspace/AGENTS.md", content: { text: head, truncated: true } }],
    });
    noPrefix(cli);
    const reopened = openDatabase(path);
    closers.push(() => reopened.close());
    const app = new Hono<HubEnv>();
    app.use(async (c, next) => {
      c.set("principal", LOCAL_PRINCIPAL);
      await next();
    });
    mountTrajectoryRoutes(
      app,
      new Trajectories({
        authorizer: { authorize: async () => ({ allowed: true, policy: "test" }) },
        events: new SqliteEventStore(reopened),
        sessions: { get: async () => ({}) },
        versions: { pi: "p", hub: "h" },
      }),
    );
    const body = await (await app.request("/v1/sessions/se_ctx/trajectory")).text();
    expect(body).toContain(`"text":"${head}"`);
    noPrefix(body);
  });
});

describe("telemetry shutdown", () => {
  test("a collector that is down: shutdown resolves, says so, and does not reject", async () => {
    const gone = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const url = `http://127.0.0.1:${gone.port}/v1/traces`;
    await gone.stop(true);
    const t = new Telemetry({ spanExporter: new OTLPTraceExporter({ url }) });
    t.endSpan(t.startSpan("s", {}));
    const started = performance.now();
    const result = await t.shutdown(1_000);
    expect(result.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("a collector that hangs: shutdown gives up after its timeout", async () => {
    const hang = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    closers.push(() => hang.stop(true));
    const t = new Telemetry({
      spanExporter: new OTLPTraceExporter({ url: `http://127.0.0.1:${hang.port}/v1/traces` }),
    });
    t.endSpan(t.startSpan("s", {}));
    const started = performance.now();
    const result = await t.shutdown(300);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("300 ms") });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("an exporter whose shutdown fails at once: shutdown resolves with the error, not the timeout", async () => {
    const exporter: SpanExporter = {
      export: (_spans, done) => done({ code: ExportResultCode.SUCCESS }),
      shutdown: () => Promise.reject(new Error("exporter broke")),
      forceFlush: () => Promise.resolve(),
    };
    const t = new Telemetry({ spanExporter: exporter });
    t.endSpan(t.startSpan("s", {}));
    const started = performance.now();
    // Resolves (never rejects), says why, and well before the timeout.
    const result = await t.shutdown(5_000);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("exporter broke") });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("nothing to export: shutdown is ok", async () => {
    expect(await new Telemetry().shutdown()).toEqual({ ok: true });
  });
});
