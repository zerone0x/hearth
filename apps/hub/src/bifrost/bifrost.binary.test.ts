/**
 * The Bifrost service against the real Bifrost v2.5.1 binary (decision 0046),
 * started by `deploy/bifrost/start.sh` with `deploy/bifrost/config.json` as
 * the compose install uses them; only the data paths and the pricing URLs
 * (pointed at the fake provider, so the test needs no internet) differ. A fake
 * OpenAI-compatible provider records the key each model call carries.
 *
 * `HEARTH_BIFROST_BIN` names the binary (`scripts/fetch-bifrost.sh` downloads
 * it by checksum); without it the suite is skipped, and HEARTH_BIFROST_TESTS=1
 * (CI) makes that a failure instead.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDefaultSecretStore, LOCAL_PRINCIPAL } from "@hearth/core";
import { type Hub, startHub } from "../server";
import { BIFROST_ADMIN_USER } from ".";

const BIN = process.env["HEARTH_BIFROST_BIN"];
if (process.env["HEARTH_BIFROST_TESTS"] === "1" && !BIN) {
  throw new Error("HEARTH_BIFROST_TESTS=1 but HEARTH_BIFROST_BIN is not set");
}

const REPO = resolve(import.meta.dir, "../../../..");
const VAULT_KEY = Buffer.alloc(32, 0x7d).toString("base64");
const KEY_1 = "sk-bifrost-binary-test-first-a41c";
const KEY_2 = "sk-bifrost-binary-test-rotated-c90e";

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

describe.skipIf(!BIN)("Bifrost service against the Bifrost binary", () => {
  let dir = "";
  let hub: Hub;
  let bifrost: ReturnType<typeof Bun.spawn> | undefined;
  let bifrostUrl = "";
  let bifrostPort = 0;
  const seen: string[] = [];
  let provider: ReturnType<typeof Bun.serve>;
  let entryId = "";

  function startBifrost(): void {
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
        String(bifrostPort),
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
  }

  async function stopBifrost(): Promise<void> {
    // SIGTERM once took over 6 s; this process is ours, so kill it by PID.
    bifrost?.kill("SIGKILL");
    await bifrost?.exited;
    bifrost = undefined;
  }

  async function healthy(): Promise<void> {
    const end = Date.now() + 60_000;
    for (;;) {
      const ok = await fetch(`${bifrostUrl}/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return;
      if (Date.now() > end) {
        throw new Error(
          `Bifrost not healthy:\n${readFileSync(join(dir, "bifrost.log"), "utf8").slice(-2000)}`,
        );
      }
      await Bun.sleep(200);
    }
  }

  function admin(password: string) {
    return { Authorization: `Basic ${btoa(`${BIFROST_ADMIN_USER}:${password}`)}` };
  }

  const handoff = (name: string) => readFileSync(join(dir, "handoff", name), "utf8");

  async function chat(vk: string): Promise<number> {
    const res = await fetch(`${bifrostUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${vk}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await res.text();
    return res.status;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-bifrost-bin-"));
    mkdirSync(join(dir, "data"));
    provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname} ${req.headers.get("authorization") ?? ""}`);
        if (url.pathname.startsWith("/datasheet")) return Response.json({});
        if (url.pathname.endsWith("/models")) {
          return Response.json({ object: "list", data: [{ id: "gpt-4o-mini", object: "model" }] });
        }
        return Response.json({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "gpt-4o-mini",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const fake = `http://127.0.0.1:${provider.port}`;
    // The committed config, with this run's paths and a local pricing source.
    const config = JSON.parse(readFileSync(join(REPO, "deploy/bifrost/config.json"), "utf8"));
    config.config_store.config.path = join(dir, "data", "config.db");
    config.logs_store.config.path = join(dir, "data", "logs.db");
    config.framework.pricing.pricing_url = `${fake}/datasheet`;
    config.framework.pricing.model_parameters_url = `${fake}/datasheet/model-parameters`;
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));

    bifrostPort = await freePort();
    bifrostUrl = `http://127.0.0.1:${bifrostPort}`;
    hub = startHub({
      dbPath: join(dir, "hub.db"),
      port: 0,
      boxPort: 0,
      log: () => {},
      vault: {
        keyRef: "env:VAULT_KEY",
        keySecrets: createDefaultSecretStore({ env: { VAULT_KEY } }),
      },
      bifrost: { url: bifrostUrl, handoffDir: join(dir, "handoff"), checkEveryMs: 0 },
    });
    // The hub hands over the secrets before Bifrost runs; start.sh waits for them.
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("unreachable");
    entryId = (
      await hub.vault.create(LOCAL_PRINCIPAL, {
        name: "model-key-openai",
        kind: "model-key",
        meta: { provider: "openai" },
        fields: { value: KEY_1 },
      })
    ).id;
    startBifrost();
    await healthy();
    // The owner's provider endpoint (here the fake), set before the first push.
    const res = await fetch(`${bifrostUrl}/api/providers`, {
      method: "POST",
      headers: { ...admin(handoff("admin_password")), "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", network_config: { base_url: fake } }),
    });
    expect(res.status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await stopBifrost();
    await hub?.stop();
    await provider?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("admin API: the vault's password works, none or another is 401; /health needs none", async () => {
    expect((await fetch(`${bifrostUrl}/api/providers`)).status).toBe(401);
    expect((await fetch(`${bifrostUrl}/api/providers`, { headers: admin("wrong") })).status).toBe(
      401,
    );
    expect(
      (await fetch(`${bifrostUrl}/api/providers`, { headers: admin(handoff("admin_password")) }))
        .status,
    ).toBe(200);
  });

  test("the hub's check is ok and pushes the vault's model key; Bifrost shows it masked", async () => {
    expect(await hub.bifrost?.check()).toEqual({ state: "ok", detail: "ok" });
    const body = (await (await fetch(`${hub.url}healthz`)).json()) as Record<string, unknown>;
    expect(body["bifrost"]).toBe("ok");
    await hub.bifrost?.syncKeys();
    const keys = (await (
      await fetch(`${bifrostUrl}/api/providers/openai/keys`, {
        headers: admin(handoff("admin_password")),
      })
    ).json()) as { keys: { name: string; value: { value: string } }[] };
    expect(keys.keys.map((k) => k.name)).toEqual(["model-key-openai"]);
    expect(keys.keys[0]?.value.value).not.toContain(KEY_1);
  });

  test("a model call through a virtual key reaches the provider with the vault's key", async () => {
    const created = (await (
      await fetch(`${bifrostUrl}/api/governance/virtual-keys`, {
        method: "POST",
        headers: { ...admin(handoff("admin_password")), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "binary-test",
          provider_configs: [
            { provider: "openai", allowed_models: ["gpt-4o-mini"], key_ids: ["*"] },
          ],
          is_active: true,
        }),
      })
    ).json()) as { virtual_key: { value: string } };
    const vk = created.virtual_key.value;
    expect(await chat(vk)).toBe(200);
    expect(seen.filter((s) => s.startsWith("POST /v1/chat/completions"))).toEqual([
      `POST /v1/chat/completions Bearer ${KEY_1}`,
    ]);
    // The key is stored encrypted with the vault's encryption key, not in plain text.
    for (const file of ["config.db", "config.db-wal"]) {
      const bytes = readFileSync(join(dir, "data", file), { flag: "r" });
      expect(bytes.includes(KEY_1)).toBe(false);
    }

    // A restart reads the store with the same key from the vault; a rotation is pushed.
    await stopBifrost();
    startBifrost();
    await healthy();
    expect((await hub.bifrost?.check())?.state).toBe("ok");
    await hub.vault.rotate(LOCAL_PRINCIPAL, entryId, { fields: { value: KEY_2 } });
    await hub.bifrost?.syncKeys();
    seen.length = 0;
    expect(await chat(vk)).toBe(200);
    expect(seen.filter((s) => s.startsWith("POST /v1/chat/completions"))).toEqual([
      `POST /v1/chat/completions Bearer ${KEY_2}`,
    ]);

    // Deleted from the vault: deleted from Bifrost, and the call has no key.
    await hub.vault.remove(LOCAL_PRINCIPAL, entryId);
    await hub.bifrost?.syncKeys();
    seen.length = 0;
    expect(await chat(vk)).not.toBe(200);
    expect(seen.filter((s) => s.startsWith("POST /v1/chat/completions"))).toEqual([]);
  }, 90_000);
});
