/**
 * Per-session virtual keys (decision 0047) against a fake of Bifrost's
 * governance and inference API: create on the first runner build, rotate on
 * every later one, `PUT` on a model switch, deactivate on archive, delete;
 * the allowlist is never empty and never "all providers"; the value never
 * reaches the store, the audit log, the event log or a log line; a 402 ends
 * the turn with a visible `runner.gateway` event. `bifrost.binary.test.ts`
 * runs the exit criteria against the real binary.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultSecretStore,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  LOCAL_PRINCIPAL,
} from "@hearth/core";
import { gatewayRefusal } from "../runner/runner";
import { type Hub, startHub } from "../server";
import { BifrostClient, checkAllowlist, DEFAULT_SESSION_BUDGET_USD, virtualKeyBody } from ".";

const VAULT_KEY = Buffer.alloc(32, 0x3c).toString("base64");

interface FakeVk {
  id: string;
  value: string;
  active: boolean;
  body: Record<string, unknown>;
}

/** Bifrost's admin, governance and OpenAI-compatible API, as far as the hub uses them. */
function fakeGateway(password: () => string | undefined) {
  const vks = new Map<string, FakeVk>();
  const bodies: { method: string; path: string; body: unknown }[] = [];
  const completions: { authorization: string | null; model: string }[] = [];
  let refuse: number | undefined;
  let seq = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
      const body: unknown = text === "" ? undefined : JSON.parse(text);
      if (url.pathname === "/v1/chat/completions") {
        const auth = req.headers.get("authorization");
        const vk = [...vks.values()].find((k) => auth === `Bearer ${k.value}`);
        completions.push({ authorization: auth, model: (body as { model: string }).model });
        if (vk === undefined || !vk.active) {
          return Response.json({ error: { message: "invalid virtual key" } }, { status: 401 });
        }
        if (refuse !== undefined) {
          return Response.json(
            { message: "Budget exceeded: vk budget exceeded: 0.0900 >= 0.0500 dollars" },
            { status: refuse },
          );
        }
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(
          `${chunk({ role: "assistant", content: "hello" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const want = password();
      if (
        want === undefined ||
        req.headers.get("authorization") !== `Basic ${btoa(`hearth:${want}`)}`
      ) {
        return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
      }
      bodies.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/api/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/logs/stats") {
        const id = url.searchParams.get("virtual_key_ids");
        return Response.json({
          total_requests: id === null ? 9 : 3,
          prompt_tokens: 300,
          completion_tokens: 150,
          total_tokens: 450,
          total_cost: id === null ? 0.27 : 0.09,
        });
      }
      const parts = url.pathname.split("/").filter(Boolean); // api governance virtual-keys id rotate
      if (parts[2] !== "virtual-keys") return new Response("unexpected", { status: 500 });
      if (parts.length === 3 && req.method === "POST") {
        const vk = {
          id: `vk-${++seq}`,
          value: `sk-bf-fake-${seq}-${crypto.randomUUID()}`,
          active: true,
          body: body as Record<string, unknown>,
        };
        vks.set(vk.id, vk);
        return Response.json({ virtual_key: { id: vk.id, value: vk.value } });
      }
      const vk = vks.get(parts[3] ?? "");
      if (vk === undefined)
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      if (parts[4] === "rotate" && req.method === "POST") {
        vk.value = `sk-bf-fake-rotated-${crypto.randomUUID()}`;
        return Response.json({ virtual_key: { id: vk.id, value: vk.value } });
      }
      if (req.method === "PUT") {
        const b = body as Record<string, unknown>;
        if (typeof b["is_active"] === "boolean") vk.active = b["is_active"];
        vk.body = { ...vk.body, ...b };
        return Response.json({ virtual_key: { id: vk.id } });
      }
      if (req.method === "DELETE") {
        vks.delete(vk.id);
        return Response.json({ message: "deleted" });
      }
      return new Response("unexpected", { status: 500 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    vks,
    bodies,
    completions,
    refuseWith(status: number | undefined) {
      refuse = status;
    },
    stop: () => server.stop(true),
  };
}

let dir: string;
let hubs: Hub[];
let fakes: ReturnType<typeof fakeGateway>[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-vk-"));
  hubs = [];
  fakes = [];
});
afterEach(async () => {
  for (const hub of hubs) await hub.stop();
  for (const fake of fakes) fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

function start(options: { provider?: string; model?: string } = {}) {
  const fake = fakeGateway(() => {
    try {
      return readFileSync(join(dir, "handoff", "admin_password"), "utf8");
    } catch {
      return undefined;
    }
  });
  fakes.push(fake);
  const logs: string[] = [];
  const hub = startHub({
    dbPath: join(dir, "hub.db"),
    port: 0,
    boxPort: 0,
    log: (line) => logs.push(line),
    vault: {
      keyRef: "env:VAULT_KEY",
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY } }),
    },
    bifrost: { url: fake.url, handoffDir: join(dir, "handoff"), checkEveryMs: 0 },
    runner: {
      config: { provider: options.provider ?? "openai", model: options.model ?? "gpt-4o-mini" },
      hubTempDir: dir,
    },
  });
  hubs.push(hub);
  return { hub, fake, logs };
}

function db(): Database {
  return new Database(join(dir, "hub.db"), { readonly: true });
}

function auditActions(prefix: string): { action: string; detail: string }[] {
  const d = db();
  try {
    return d
      .query<{ action: string; detail: string }, [string]>(
        "SELECT action, detail_json AS detail FROM audit WHERE action LIKE ? AND allowed IS NULL ORDER BY id",
      )
      .all(`${prefix}%`);
  } finally {
    d.close();
  }
}

/** Every stored byte the hub keeps: the SQLite files. */
function storedText(): string {
  return readdirSync(dir)
    .filter((f) => f.startsWith("hub.db"))
    .map((f) => readFileSync(join(dir, f)).toString("latin1"))
    .join("\n");
}

async function turn(hub: Hub, sessionId: string, text: string): Promise<void> {
  const runners = hub.runners;
  if (runners === undefined) throw new Error("no runners");
  await runners.send(LOCAL_PRINCIPAL, sessionId, text);
  const end = Date.now() + 10_000;
  for (;;) {
    const view = await runners.view(LOCAL_PRINCIPAL, sessionId);
    if (view.status !== "running") return;
    if (Date.now() > end) throw new Error("turn did not end");
    await Bun.sleep(20);
  }
}

async function eventsOf(hub: Hub, sessionId: string) {
  return (await hub.events.read({ workspaceId: DEFAULT_WORKSPACE_ID }, sessionId, 0, 1000)).events;
}

describe("the allowlist and the VK body", () => {
  test("an empty allowlist is refused (empty means none), and nothing is sent", async () => {
    expect(() => checkAllowlist([])).toThrow(HearthError);
    expect(() => checkAllowlist(["*"])).toThrow(HearthError);
    expect(() => checkAllowlist([""])).toThrow(HearthError);
    expect(checkAllowlist(["gpt-4o-mini", "gpt-4o-mini"])).toEqual(["gpt-4o-mini"]);
    const seen: string[] = [];
    const client = new BifrostClient({
      baseUrl: "http://127.0.0.1:9",
      password: "pw",
      fetch: (async (input: string) => {
        seen.push(String(input));
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    await expect(
      client.createVirtualKey({ name: "s", provider: "openai", models: [], budgetUsd: 1 }),
    ).rejects.toMatchObject({ code: "bifrost.empty-allowlist" });
    await expect(
      client.updateVirtualKey("vk-1", { provider: "openai", models: [] }),
    ).rejects.toMatchObject({
      code: "bifrost.empty-allowlist",
    });
    expect(seen).toEqual([]);
  });

  test("no VK body sets allow_all_providers; the allowlist is the one model", () => {
    const body = virtualKeyBody({
      name: "s",
      provider: "openai",
      models: ["gpt-4o-mini"],
      budgetUsd: 2,
    });
    expect(body["allow_all_providers"]).toBe(false);
    expect(body["provider_configs"]).toEqual([
      { provider: "openai", allowed_models: ["gpt-4o-mini"], key_ids: ["*"] },
    ]);
    expect(body["budgets"]).toEqual([{ max_limit: 2, reset_duration: "1Y" }]);
    expect(() => virtualKeyBody({ provider: "openai", models: ["m"], budgetUsd: 0 })).toThrow();
  });

  test("gatewayRefusal reads the HTTP status, not Bifrost's labels", () => {
    expect(gatewayRefusal('402: {"message":"Budget exceeded: 0.09 >= 0.05 dollars"}')).toEqual({
      status: 402,
      code: "budget_exceeded",
      message:
        "This session reached its model budget (Budget exceeded: 0.09 >= 0.05 dollars). Raise the session budget in Settings to continue.",
    });
    expect(gatewayRefusal('429: {"error":{"message":"slow down"}}')?.code).toBe("rate_limited");
    // A label without the status is not a refusal; another status is not either.
    expect(gatewayRefusal("policy_rate_limited budget_exceeded")).toBeUndefined();
    expect(gatewayRefusal('403: {"message":"model blocked"}')).toBeUndefined();
    expect(gatewayRefusal(undefined)).toBeUndefined();
  });
});

describe("per-session virtual keys", () => {
  test("first build creates the key, later builds rotate it; only the id is stored; all audited", async () => {
    const { hub, fake, logs } = start();
    await hub.bifrostReady;
    await hub.settingsReady;
    const s = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "a" });
    await turn(hub, s.id, "hi");
    expect(fake.vks.size).toBe(1);
    const vk = [...fake.vks.values()][0] as FakeVk;
    expect(vk.body).toMatchObject({
      name: `session-${s.id}`,
      allow_all_providers: false,
      provider_configs: [{ provider: "openai", allowed_models: ["gpt-4o-mini"], key_ids: ["*"] }],
      budgets: [{ max_limit: DEFAULT_SESSION_BUDGET_USD, reset_duration: "1Y" }],
      rate_limit: { request_max_limit: 120, request_reset_duration: "1m" },
    });
    expect(fake.completions.at(-1)).toEqual({
      authorization: `Bearer ${vk.value}`,
      model: "openai/gpt-4o-mini",
    });
    const first = vk.value;

    // A runner build after a model switch: PUT the allowlist, then rotate.
    hub.runners?.setModel({ provider: "openai", model: "gpt-4o" });
    await turn(hub, s.id, "again");
    expect(fake.vks.size).toBe(1);
    expect(vk.value).not.toBe(first);
    expect(vk.body["provider_configs"]).toEqual([
      { provider: "openai", allowed_models: ["gpt-4o"], key_ids: ["*"] },
    ]);
    expect(fake.completions.at(-1)).toEqual({
      authorization: `Bearer ${vk.value}`,
      model: "openai/gpt-4o",
    });
    expect(auditActions("bifrost.vk.").map((r) => r.action)).toEqual([
      "bifrost.vk.create",
      "bifrost.vk.update",
      "bifrost.vk.rotate",
    ]);

    // The value is nowhere the hub keeps or writes: not the DB, events, logs or the run dir.
    const stored = storedText();
    const all = await eventsOf(hub, s.id);
    expect(all.filter((e) => e.type === "runner.usage").length).toBe(2);
    const events = JSON.stringify(all);
    for (const value of [first, vk.value]) {
      expect(stored).not.toContain(value);
      expect(events).not.toContain(value);
      expect(logs.join("\n")).not.toContain(value);
    }
    const d = db();
    try {
      expect(
        d.query("SELECT vk_id, provider, model, budget_usd, active FROM session_virtual_key").all(),
      ).toEqual([{ vk_id: vk.id, provider: "openai", model: "gpt-4o", budget_usd: 5, active: 1 }]);
    } finally {
      d.close();
    }
    // The redaction registry has it: a stray echo is redacted.
    expect(hub.runners?.redact(`key ${vk.value}`)).not.toContain(vk.value);
  });

  test("archive deactivates the key; remove deletes it; both audited", async () => {
    const { hub, fake } = start();
    await hub.bifrostReady;
    await hub.settingsReady;
    const s = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "a" });
    await turn(hub, s.id, "hi");
    const vk = [...fake.vks.values()][0] as FakeVk;
    await hub.sessions.archive(LOCAL_PRINCIPAL, s.id);
    expect(vk.active).toBe(false);
    expect(
      fake.bodies.some(
        (b) => b.method === "PUT" && JSON.stringify(b.body) === '{"is_active":false}',
      ),
    ).toBe(true);
    await hub.virtualKeys.remove(s.id);
    expect(fake.vks.size).toBe(0);
    expect(auditActions("bifrost.vk.").map((r) => r.action)).toEqual([
      "bifrost.vk.create",
      "bifrost.vk.deactivate",
      "bifrost.vk.delete",
    ]);
  });

  test("a 402 from the gateway ends the turn with a visible runner.gateway event", async () => {
    const { hub, fake } = start();
    await hub.bifrostReady;
    await hub.settingsReady;
    const s = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "a" });
    fake.refuseWith(402);
    await turn(hub, s.id, "hi");
    const gateway = (await eventsOf(hub, s.id)).filter((e) => e.type === "runner.gateway");
    expect(gateway).toHaveLength(1);
    expect(gateway[0]?.payload).toMatchObject({ status: 402, code: "budget_exceeded" });
    expect(JSON.stringify(gateway[0]?.payload)).toContain("0.0900 >= 0.0500 dollars");
    // The session is not failed: a raised budget lets the next turn run.
    fake.refuseWith(undefined);
    await turn(hub, s.id, "again");
    expect((await eventsOf(hub, s.id)).filter((e) => e.type === "runner.gateway")).toHaveLength(1);
  });

  test("Bifrost configured but not ok: the message is refused, never sent around it", async () => {
    const { hub, fake } = start();
    await hub.bifrostReady;
    await hub.settingsReady;
    fake.stop();
    await hub.bifrost?.check();
    expect(hub.bifrost?.status.state).toBe("unreachable");
    const s = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "a" });
    await expect(hub.runners?.send(LOCAL_PRINCIPAL, s.id, "hi")).rejects.toMatchObject({
      code: "runner.gateway-unavailable",
    });
  });

  test("a provider Bifrost does not serve stays direct: no key is made", async () => {
    const { hub, fake, logs } = start({ provider: "faux-none", model: "x" });
    await hub.bifrostReady;
    await hub.settingsReady;
    const route = await hub.virtualKeys.route("se_any", { provider: "faux-none", model: "x" });
    expect(route).toBeUndefined();
    expect(fake.vks.size).toBe(0);
    expect(logs.join("\n")).toContain("provider faux-none is not served by Bifrost");
  });

  test("spend and the session budget through the API", async () => {
    const { hub, fake } = start();
    await hub.bifrostReady;
    await hub.settingsReady;
    const s = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "a" });
    expect(await hub.virtualKeys.spend(LOCAL_PRINCIPAL, s.id)).toMatchObject({
      gateway: "none",
      spend: null,
    });
    await turn(hub, s.id, "hi");
    expect(await hub.virtualKeys.spend(LOCAL_PRINCIPAL, s.id)).toMatchObject({
      gateway: "bifrost",
      budgetUsd: 5,
      active: true,
      flushSeconds: 10,
      spend: { requests: 3, totalTokens: 450, costUsd: 0.09 },
    });
    await expect(hub.virtualKeys.spend(LOCAL_PRINCIPAL, "se_unknown")).rejects.toMatchObject({
      code: "session.not-found",
    });
    await expect(
      hub.virtualKeys.putBudget(LOCAL_PRINCIPAL, { budgetUsd: 0 }),
    ).rejects.toMatchObject({
      code: "request.invalid",
    });
    const saved = await hub.virtualKeys.putBudget(LOCAL_PRINCIPAL, { budgetUsd: 12.5 });
    expect(saved).toMatchObject({ budgetUsd: 12.5, source: "settings", total: { costUsd: 0.27 } });
    // Applied to the active key now.
    const vk = [...fake.vks.values()][0] as FakeVk;
    expect(vk.body["budgets"]).toEqual([{ max_limit: 12.5, reset_duration: "1Y" }]);
    expect(auditActions("settings.session_budget").map((r) => JSON.parse(r.detail))).toEqual([
      { budget_usd: 12.5, previous: 5, previous_source: "default" },
    ]);
  });
});
