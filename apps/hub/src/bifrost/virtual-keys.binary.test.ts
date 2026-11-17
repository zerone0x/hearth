/**
 * The M3 exit criteria for per-session virtual keys (PRD §11.3, decision
 * 0047) against the real Bifrost v2.5.1 binary, with a fake OpenAI-compatible
 * provider that answers every call with 100 prompt and 50 completion tokens,
 * and a local price list (0.0001 $ per prompt token, 0.0002 $ per completion
 * token: 0.02 $ a call):
 *
 * - a session's spend as the hub serves it to the UI equals the sum of the
 *   session's rows in Bifrost's request log, once the log batch is written;
 * - a session over its budget is refused with a visible message;
 * - a runner build rotates the key, a model switch `PUT`s the allowlist, an
 *   archive deactivates the key.
 *
 * Gated like `bifrost.binary.test.ts`: `HEARTH_BIFROST_BIN` names the binary;
 * HEARTH_BIFROST_TESTS=1 (CI) makes its absence a failure.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDefaultSecretStore, DEFAULT_WORKSPACE_ID, LOCAL_PRINCIPAL } from "@hearth/core";
import { type Hub, startHub } from "../server";
import { BIFROST_ADMIN_USER } from ".";

const BIN = process.env["HEARTH_BIFROST_BIN"];
if (process.env["HEARTH_BIFROST_TESTS"] === "1" && !BIN) {
  throw new Error("HEARTH_BIFROST_TESTS=1 but HEARTH_BIFROST_BIN is not set");
}

const REPO = resolve(import.meta.dir, "../../../..");
const VAULT_KEY = Buffer.alloc(32, 0x2e).toString("base64");
const PROVIDER_KEY = "sk-vk-binary-test-provider-6b01";

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

describe.skipIf(!BIN)("per-session virtual keys against the Bifrost binary", () => {
  let dir = "";
  let hub: Hub;
  let bifrost: ReturnType<typeof Bun.spawn> | undefined;
  let bifrostUrl = "";
  let provider: ReturnType<typeof Bun.serve>;
  const logs: string[] = [];

  function admin(): Record<string, string> {
    const pw = readFileSync(join(dir, "handoff", "admin_password"), "utf8");
    return {
      Authorization: `Basic ${btoa(`${BIFROST_ADMIN_USER}:${pw}`)}`,
      "Content-Type": "application/json",
    };
  }

  async function adminGet(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${bifrostUrl}${path}`, { headers: admin() });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function turn(sessionId: string, text: string): Promise<void> {
    await hub.runners?.send(LOCAL_PRINCIPAL, sessionId, text);
    const end = Date.now() + 20_000;
    while ((await hub.runners?.view(LOCAL_PRINCIPAL, sessionId))?.status === "running") {
      if (Date.now() > end) throw new Error("turn did not end");
      await Bun.sleep(50);
    }
  }

  async function events(sessionId: string) {
    return (await hub.events.read({ workspaceId: DEFAULT_WORKSPACE_ID }, sessionId, 0, 1000))
      .events;
  }

  function vkIdOf(sessionId: string): string {
    const db = new Database(join(dir, "hub.db"), { readonly: true });
    try {
      return (
        db.query("SELECT vk_id FROM session_virtual_key WHERE session_id = ?").get(sessionId) as {
          vk_id: string;
        }
      ).vk_id;
    } finally {
      db.close();
    }
  }

  async function vk(id: string): Promise<Record<string, unknown>> {
    return (await adminGet(`/api/governance/virtual-keys/${id}`))["virtual_key"] as Record<
      string,
      unknown
    >;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-vk-bin-"));
    mkdirSync(join(dir, "data"));
    provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/datasheet") {
          return Response.json({
            "gpt-4o-mini": {
              provider: "openai",
              mode: "chat",
              input_cost_per_token: 0.0001,
              output_cost_per_token: 0.0002,
            },
            "gpt-4o": {
              provider: "openai",
              mode: "chat",
              input_cost_per_token: 0.0001,
              output_cost_per_token: 0.0002,
            },
          });
        }
        if (url.pathname.startsWith("/datasheet")) return Response.json({});
        if (url.pathname.endsWith("/models")) {
          return Response.json({ object: "list", data: [{ id: "gpt-4o-mini", object: "model" }] });
        }
        const body = (await req.json()) as { model: string };
        const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
          `data: ${JSON.stringify({
            id: "c",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage === undefined ? {} : { usage }),
          })}\n\n`;
        return new Response(
          `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop", {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          })}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const fake = `http://127.0.0.1:${provider.port}`;
    const config = JSON.parse(readFileSync(join(REPO, "deploy/bifrost/config.json"), "utf8"));
    config.config_store.config.path = join(dir, "data", "config.db");
    config.logs_store.config.path = join(dir, "data", "logs.db");
    config.framework.pricing.pricing_url = `${fake}/datasheet`;
    config.framework.pricing.model_parameters_url = `${fake}/datasheet/model-parameters`;
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const port = await freePort();
    bifrostUrl = `http://127.0.0.1:${port}`;
    hub = startHub({
      dbPath: join(dir, "hub.db"),
      port: 0,
      boxPort: 0,
      log: (line) => logs.push(line),
      vault: {
        keyRef: "env:VAULT_KEY",
        keySecrets: createDefaultSecretStore({ env: { VAULT_KEY } }),
      },
      bifrost: { url: bifrostUrl, handoffDir: join(dir, "handoff"), checkEveryMs: 0 },
      runner: { config: { provider: "openai", model: "gpt-4o-mini" }, hubTempDir: dir },
    });
    await hub.bifrostReady;
    await hub.settingsReady;
    await hub.vault.create(LOCAL_PRINCIPAL, {
      name: "model-key-openai",
      kind: "model-key",
      meta: { provider: "openai" },
      fields: { value: PROVIDER_KEY },
    });
    bifrost = Bun.spawn(
      [
        "sh",
        join(REPO, "deploy/bifrost/start.sh"),
        BIN ?? "",
        "-app-dir",
        join(dir, "data"),
        "-host",
        "127.0.0.1",
        "-port",
        String(port),
      ],
      {
        cwd: dir,
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: dir,
          HEARTH_BIFROST_HANDOFF_DIR: join(dir, "handoff"),
          HEARTH_BIFROST_CONFIG: join(dir, "config.json"),
          APP_DIR: join(dir, "data"),
        },
        stdout: Bun.file(join(dir, "bifrost.log")),
        stderr: "inherit",
      },
    );
    const end = Date.now() + 60_000;
    while (
      !(await fetch(`${bifrostUrl}/health`).then(
        (r) => r.ok,
        () => false,
      ))
    ) {
      if (Date.now() > end) throw new Error("Bifrost not healthy");
      await Bun.sleep(200);
    }
    const res = await fetch(`${bifrostUrl}/api/providers`, {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ provider: "openai", network_config: { base_url: fake } }),
    });
    expect(res.status).toBe(200);
    expect((await hub.bifrost?.check())?.state).toBe("ok");
    await hub.bifrost?.syncKeys();
  }, 90_000);

  afterAll(async () => {
    // SIGTERM once took over 6 s; this process is ours, so kill it by PID.
    bifrost?.kill("SIGKILL");
    await bifrost?.exited;
    await hub?.stop();
    await provider?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("UI spend equals the request-log sum after the flush; over budget is refused with a message", async () => {
    await hub.virtualKeys.putBudget(LOCAL_PRINCIPAL, { budgetUsd: 0.03 });
    const s = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "budget" });
    // 0.02 $ a call; the check runs on the usage before a call, so the second
    // call (0.02 < 0.03) passes and the third (0.04 >= 0.03) is refused.
    await turn(s.id, "one");
    await turn(s.id, "two");
    expect((await events(s.id)).filter((e) => e.type === "runner.gateway")).toEqual([]);
    await turn(s.id, "three");
    const refused = (await events(s.id)).filter((e) => e.type === "runner.gateway");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({ status: 402, code: "budget_exceeded" });
    expect(JSON.stringify(refused[0]?.payload)).toContain("0.0400 >= 0.0300 dollars");

    // Bifrost writes its log in batches: wait for the rows, then compare.
    const id = vkIdOf(s.id);
    let rows: { cost?: unknown; status?: unknown }[] = [];
    const end = Date.now() + 30_000;
    for (;;) {
      const page = await adminGet(`/api/logs?virtual_key_ids=${id}&limit=100`);
      rows = (page["logs"] as typeof rows) ?? [];
      if (rows.filter((r) => r.status === "success").length >= 2) break;
      if (Date.now() > end) throw new Error(`log rows not written: ${JSON.stringify(rows)}`);
      await Bun.sleep(500);
    }
    const sum = rows.reduce((total, r) => total + (typeof r.cost === "number" ? r.cost : 0), 0);
    const view = await hub.virtualKeys.spend(LOCAL_PRINCIPAL, s.id);
    expect(view.gateway).toBe("bifrost");
    expect(view.budgetUsd).toBe(0.03);
    expect(view.spend?.costUsd).toBeCloseTo(sum, 9);
    expect(view.spend?.costUsd).toBeCloseTo(0.04, 9);
    expect(view.spend?.totalTokens).toBe(300);
  }, 90_000);

  test("a runner build rotates the key, a model switch PUTs the allowlist, archive deactivates it", async () => {
    await hub.virtualKeys.putBudget(LOCAL_PRINCIPAL, { budgetUsd: 5 });
    const s = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "life" });
    await turn(s.id, "one");
    const id = vkIdOf(s.id);
    const before = await vk(id);
    expect(before["allow_all_providers"]).toBe(false);
    expect(before["provider_configs"]).toMatchObject([
      { provider: "openai", allowed_models: ["gpt-4o-mini"] },
    ]);
    const firstValue = String(before["value"]);
    hub.runners?.setModel({ provider: "openai", model: "gpt-4o" });
    await turn(s.id, "two");
    expect((await events(s.id)).filter((e) => e.type === "runner.gateway")).toEqual([]);
    const after = await vk(id);
    expect(after["provider_configs"]).toMatchObject([
      { provider: "openai", allowed_models: ["gpt-4o"] },
    ]);
    expect(String(after["value"])).not.toBe(firstValue);
    const chat = (key: string, model: string) =>
      fetch(`${bifrostUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }).then(async (r) => {
        await r.text();
        return r.status;
      });
    // The rotated-out value is refused; the old model is off the allowlist.
    expect(await chat(firstValue, "openai/gpt-4o")).toBe(401);
    expect(await chat(String(after["value"]), "openai/gpt-4o-mini")).toBe(403);
    expect(await chat(String(after["value"]), "openai/gpt-4o")).toBe(200);
    await hub.sessions.archive(LOCAL_PRINCIPAL, s.id);
    expect((await vk(id))["is_active"]).toBe(false);
    expect(await chat(String(after["value"]), "openai/gpt-4o")).toBe(403);
    // No key value in any log line.
    expect(logs.join("\n")).not.toContain(firstValue);
    expect(logs.join("\n")).not.toContain(String(after["value"]));
    hub.runners?.setModel({ provider: "openai", model: "gpt-4o-mini" });
  }, 90_000);
});
