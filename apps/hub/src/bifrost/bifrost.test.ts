/**
 * The Bifrost service (decision 0046) against a fake of Bifrost's admin API:
 * secrets generated into the vault and handed off, provider keys pushed from
 * the vault and nothing else kept, health in `/healthz`, and the box egress
 * allow-list check. `bifrost.binary.test.ts` runs the same against the real
 * binary; `box-firewall.sh check` is covered here, its rules in firewall.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDefaultSecretStore, LOCAL_PRINCIPAL } from "@hearth/core";
import { type Hub, startHub } from "../server";
import {
  allowEntriesCovering,
  BIFROST_ADMIN_ENTRY,
  BIFROST_ENCRYPTION_ENTRY,
  BifrostClient,
  bifrostConfigFromEnv,
  cidrCovers,
  markerAllowList,
} from ".";

const VAULT_KEY = Buffer.alloc(32, 0x5b).toString("base64");
const OPENAI_KEY = "sk-bifrost-test-openai-3f8a1c";
const OPENAI_KEY_2 = "sk-bifrost-test-openai-rotated-91be0d";
const REPO = resolve(import.meta.dir, "../../../..");

interface FakeKey {
  id: string;
  name: string;
  value: string;
  models: string[];
}

/** Bifrost's admin API as the hub uses it: Basic auth on /api, keys per provider. */
function fakeBifrost(password: () => string | undefined) {
  const providers = new Map<string, FakeKey[]>();
  const calls: string[] = [];
  let healthy = true;
  let seq = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/health") {
        return healthy
          ? Response.json({ status: "ok" })
          : Response.json({ status: "down" }, { status: 503 });
      }
      const want = password();
      const auth = req.headers.get("authorization");
      if (want === undefined || auth !== `Basic ${btoa(`hearth:${want}`)}`) {
        return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
      }
      const parts = url.pathname.split("/").filter(Boolean); // api providers p keys id
      const body = (req.method === "GET" || req.method === "DELETE" ? {} : await req.json()) as {
        provider: string;
        name: string;
        value: string;
        models: string[];
      };
      if (parts.length === 2 && req.method === "GET") {
        return Response.json({ providers: [...providers.keys()].map((name) => ({ name })) });
      }
      if (parts.length === 2 && req.method === "POST") {
        providers.set(body.provider, []);
        return Response.json({ name: body.provider });
      }
      const keys = providers.get(parts[2] ?? "");
      if (keys === undefined)
        return Response.json({ error: { message: "no provider" } }, { status: 404 });
      if (parts.length === 4 && req.method === "GET") {
        return Response.json({
          keys: keys.map((k) => ({ ...k, value: { value: `${k.value.slice(0, 4)}****` } })),
        });
      }
      if (parts.length === 4 && req.method === "POST") {
        const key = { id: `key-${++seq}`, name: body.name, value: body.value, models: body.models };
        keys.push(key);
        return Response.json({ id: key.id, name: key.name, models: key.models });
      }
      const key = keys.find((k) => k.id === parts[4]);
      if (key === undefined)
        return Response.json({ error: { message: "no key" } }, { status: 404 });
      if (req.method === "PUT") {
        Object.assign(key, { name: body.name, value: body.value, models: body.models });
        return Response.json({ id: key.id });
      }
      if (req.method === "DELETE") {
        keys.splice(keys.indexOf(key), 1);
        return Response.json({ message: "deleted" });
      }
      return new Response("unexpected", { status: 500 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    providers,
    calls,
    setHealthy(value: boolean) {
      healthy = value;
    },
    stop: () => server.stop(true),
  };
}

let dir: string;
let hubs: Hub[];
let fakes: ReturnType<typeof fakeBifrost>[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-bifrost-"));
  hubs = [];
  fakes = [];
});
afterEach(async () => {
  for (const hub of hubs) await hub.stop();
  for (const fake of fakes) fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

function handoff(name: string): string {
  return readFileSync(join(dir, "handoff", name), "utf8");
}

function start(options: { url?: string; egressAllow?: string[]; vaultKey?: boolean } = {}) {
  const fake = fakeBifrost(() => {
    try {
      return handoff("admin_password");
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
      ...(options.vaultKey === false ? {} : { keyRef: "env:VAULT_KEY" }),
      keySecrets: createDefaultSecretStore({ env: { VAULT_KEY } }),
    },
    bifrost: {
      url: options.url ?? fake.url,
      handoffDir: join(dir, "handoff"),
      checkEveryMs: 0,
      ...(options.egressAllow === undefined
        ? {}
        : { egressAllow: () => options.egressAllow ?? [] }),
    },
  });
  hubs.push(hub);
  return { hub, fake, logs };
}

async function healthz(hub: Hub): Promise<Record<string, unknown>> {
  return (await (await fetch(`${hub.url}healthz`)).json()) as Record<string, unknown>;
}

function addOpenAiKey(hub: Hub, value = OPENAI_KEY) {
  return hub.vault.create(LOCAL_PRINCIPAL, {
    name: "model-key-openai",
    kind: "model-key",
    meta: { provider: "openai" },
    fields: { value },
  });
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

describe("Bifrost service", () => {
  test("generates the admin password and encryption key in the vault and hands them off 0440", async () => {
    const { hub, logs } = start();
    await hub.bifrostReady;
    expect(hub.vault.currentStatus.state).toBe("enabled");
    const store = (name: string) =>
      hub.vault.list(LOCAL_PRINCIPAL).then((all) => all.find((e) => e.name === name));
    const pw = await store(BIFROST_ADMIN_ENTRY);
    const enc = await store(BIFROST_ENCRYPTION_ENTRY);
    expect(pw?.kind).toBe("token");
    expect(pw?.policy).toEqual({ hosts: [], use: "hub" });
    expect(enc?.kind).toBe("token");
    // 32 random bytes, base64url; the two differ.
    expect(handoff("admin_password")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(handoff("encryption_key")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(handoff("admin_password")).not.toBe(handoff("encryption_key"));
    expect(statSync(join(dir, "handoff", "admin_password")).mode & 0o777).toBe(0o440);
    expect(statSync(join(dir, "handoff", "encryption_key")).mode & 0o777).toBe(0o440);
    expect(hub.bifrost?.status.state).toBe("ok");
    expect((await healthz(hub))["bifrost"]).toBe("ok");
    expect(logs).toContain("bifrost: ok");
    // No value in any log line.
    for (const line of logs) {
      expect(line).not.toContain(handoff("admin_password"));
      expect(line).not.toContain(handoff("encryption_key"));
    }
  });

  test("a restart reuses the same vault entries (Bifrost's store stays readable)", async () => {
    const first = start();
    await first.hub.bifrostReady;
    const pw = handoff("admin_password");
    const enc = handoff("encryption_key");
    await first.hub.stop();
    hubs = [];
    rmSync(join(dir, "handoff"), { recursive: true, force: true });
    const second = start();
    await second.hub.bifrostReady;
    expect(handoff("admin_password")).toBe(pw);
    expect(handoff("encryption_key")).toBe(enc);
  });

  test("pushes model keys from the vault, updates them on rotate and deletes keys the vault lacks", async () => {
    const { hub, fake } = start();
    await hub.bifrostReady;
    // A key typed into Bifrost by hand is not kept: the vault is the source.
    fake.providers.set("openai", [
      { id: "stray", name: "typed-in", value: "sk-typed", models: ["*"] },
    ]);
    const created = await addOpenAiKey(hub);
    await until(
      () =>
        fake.providers.get("openai")?.length === 1 &&
        fake.providers.get("openai")?.[0]?.name === "model-key-openai",
    );
    expect(fake.providers.get("openai")).toEqual([
      { id: "key-1", name: "model-key-openai", value: OPENAI_KEY, models: ["*"] },
    ]);
    await hub.vault.rotate(LOCAL_PRINCIPAL, created.id, { fields: { value: OPENAI_KEY_2 } });
    await until(() => fake.providers.get("openai")?.[0]?.value === OPENAI_KEY_2);
    await hub.vault.remove(LOCAL_PRINCIPAL, created.id);
    await until(() => fake.providers.get("openai")?.length === 0);
  });

  test("a model key whose provider Bifrost does not have is not pushed; a login or token never is", async () => {
    const { hub, fake, logs } = start();
    await hub.bifrostReady;
    await hub.vault.create(LOCAL_PRINCIPAL, {
      name: "model-key-faux",
      kind: "model-key",
      meta: { provider: "faux-http" },
      fields: { value: "sk-faux-not-pushed" },
    });
    await hub.vault.create(LOCAL_PRINCIPAL, {
      name: "site",
      kind: "login",
      policy: { origins: ["https://example.com"] },
      fields: {
        username: "bifrost-test-login-user-8c2e",
        password: "bifrost-test-p-not-pushed-41d7",
      },
    });
    // A token that names a provider is still not a model key.
    await hub.vault.create(LOCAL_PRINCIPAL, {
      name: "token-named-openai",
      kind: "token",
      meta: { provider: "openai" },
      fields: { value: "bifrost-test-token-not-pushed-6b1f" },
    });
    await hub.bifrost?.syncKeys();
    expect([...fake.providers.keys()]).toEqual([]);
    expect(logs.some((l) => l.includes("not pushed (no Bifrost provider): faux-http"))).toBe(true);
  });

  test("keys added while Bifrost is down are pushed when it comes back", async () => {
    const { hub, fake } = start();
    fake.setHealthy(false);
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("unreachable");
    expect((await healthz(hub))["bifrost"]).toBe("unreachable");
    await addOpenAiKey(hub);
    await Bun.sleep(50);
    expect(fake.providers.size).toBe(0);
    fake.setHealthy(true);
    await hub.bifrost?.check();
    // The change to ok pushes the keys; no explicit sync.
    expect(hub.bifrost?.status.state).toBe("ok");
    expect(fake.providers.get("openai")?.map((k) => k.value)).toEqual([OPENAI_KEY]);
  });

  test("a refused admin password is `unauthorized`, not ok", async () => {
    const { hub, fake } = start();
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("ok");
    // Bifrost now holds a different password than the vault.
    rmSync(join(dir, "handoff"), { recursive: true, force: true });
    expect(await hub.bifrost?.check()).toEqual({
      state: "unauthorized",
      detail: `the admin password in vault:${BIFROST_ADMIN_ENTRY} was refused`,
    });
    expect(fake.calls).toContain("GET /api/providers");
  });

  test("without the vault Bifrost gets no secrets and reports vault-disabled", async () => {
    const { hub, fake } = start({ vaultKey: false });
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("vault-disabled");
    expect((await healthz(hub))["bifrost"]).toBe("vault-disabled");
    expect(() => handoff("admin_password")).toThrow();
    expect(fake.calls).toEqual([]);
  });

  test("an egress allow list that covers Bifrost's address stops the setup before any secret", async () => {
    const { hub, fake, logs } = start({
      url: "http://172.29.249.2:8080",
      egressAllow: ["1.1.1.1/32", "172.29.0.0/16"],
    });
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("box-reachable");
    expect(logs.some((l) => l.includes("covers Bifrost's address"))).toBe(true);
    expect(await hub.vault.list(LOCAL_PRINCIPAL)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("without Bifrost configured /healthz has no bifrost field", async () => {
    const hub = startHub({ dbPath: join(dir, "plain.db"), port: 0, boxPort: 0, log: () => {} });
    hubs.push(hub);
    expect(hub.bifrost).toBeUndefined();
    expect("bifrost" in (await healthz(hub))).toBe(false);
  });
});

describe("Bifrost client", () => {
  test("never puts the password or a key value in an error", async () => {
    const fake = fakeBifrost(() => "right");
    fakes.push(fake);
    const client = new BifrostClient({ baseUrl: fake.url, password: "wrong-pw-1f2e" });
    const error = await client
      .addKey("openai", { name: "k", value: "sk-secret-value-77", models: ["*"] })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("401");
    expect(String(error)).not.toContain("wrong-pw-1f2e");
    expect(String(error)).not.toContain("sk-secret-value-77");
    expect(await client.authorized()).toBe(false);
  });

  test("health of an address with nothing listening is not ok and does not throw", async () => {
    const client = new BifrostClient({ baseUrl: "http://127.0.0.1:1", password: "x" });
    expect((await client.health()).ok).toBe(false);
  });

  test("refuses a provider name that is not a path segment", async () => {
    const client = new BifrostClient({ baseUrl: "http://127.0.0.1:1", password: "x" });
    await expect(client.keys("../governance")).rejects.toThrow("not a Bifrost provider name");
  });
});

describe("Bifrost config and box egress (decisions 0012, 0023, 0046)", () => {
  test("bifrostConfigFromEnv", () => {
    expect(bifrostConfigFromEnv({})).toBeUndefined();
    expect(bifrostConfigFromEnv({ HEARTH_BIFROST_URL: "" })).toBeUndefined();
    expect(
      bifrostConfigFromEnv({
        HEARTH_BIFROST_URL: "http://172.29.249.2:8080",
        HEARTH_BIFROST_HANDOFF_DIR: "/run/hearth-bifrost",
      }),
    ).toEqual({ url: "http://172.29.249.2:8080", handoffDir: "/run/hearth-bifrost" });
    expect(() => bifrostConfigFromEnv({ HEARTH_BIFROST_URL: "file:///etc/passwd" })).toThrow();
  });

  test("cidrCovers and allowEntriesCovering", () => {
    expect(cidrCovers("172.29.249.0/29", "172.29.249.2")).toBe(true);
    expect(cidrCovers("172.29.249.2", "172.29.249.2")).toBe(true);
    expect(cidrCovers("172.29.249.8/29", "172.29.249.2")).toBe(false);
    expect(cidrCovers("172.16.0.0/12", "172.29.249.2")).toBe(true);
    expect(cidrCovers("10.0.0.0/8", "172.29.249.2")).toBe(false);
    expect(cidrCovers("192.168.1.1/32", "192.168.1.2")).toBe(false);
    expect(
      allowEntriesCovering("http://172.29.249.2:8080", ["1.1.1.1/32", "172.29.0.0/16"]),
    ).toEqual(["172.29.0.0/16"]);
    expect(allowEntriesCovering("http://bifrost:8080", ["0.0.0.0/1"])).toEqual([]);
  });

  test("markerAllowList reads the line box-firewall.sh writes", () => {
    expect(markerAllowList("applied 2026-11-17T00:00:00Z port=8788 allow=\n")).toEqual([]);
    expect(
      markerAllowList(
        "applied 2026-11-17T00:00:00Z port=8788 allow=192.168.1.1/32,172.29.0.0/16\n",
      ),
    ).toEqual(["192.168.1.1/32", "172.29.0.0/16"]);
  });

  /** `HEARTH_BIFROST_ADDR` and the subnet as compose.yaml sets them by default. */
  function composeDefaults() {
    const compose = readFileSync(join(REPO, "deploy/compose.yaml"), "utf8");
    const addrs = [...compose.matchAll(/\$\{HEARTH_BIFROST_ADDR:-([0-9.]+)\}/g)].map((m) => m[1]);
    const subnet = /\$\{HEARTH_BIFROST_SUBNET:-([0-9./]+)\}/.exec(compose)?.[1];
    const url = /HEARTH_BIFROST_URL: http:\/\/\$\{HEARTH_BIFROST_ADDR:-([0-9.]+)\}:8080/.exec(
      compose,
    )?.[1];
    return { addrs, subnet, url };
  }

  test("compose: one Bifrost address everywhere, inside its subnet, given to the firewall and the hub", () => {
    const { addrs, subnet, url } = composeDefaults();
    // The firewall's, the hub URL's and the service's ipv4_address.
    expect(addrs.length).toBe(3);
    expect(new Set(addrs).size).toBe(1);
    expect(url).toBe(addrs[0]);
    expect(subnet).toBeDefined();
    expect(cidrCovers(subnet ?? "", addrs[0] ?? "")).toBe(true);
  });

  function check(env: Record<string, string>) {
    const run = Bun.spawnSync(["bash", join(REPO, "scripts/box-firewall.sh"), "check"], {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: run.exitCode, stderr: run.stderr.toString() };
  }

  test("box-firewall.sh refuses an allow list that covers Bifrost's compose address", () => {
    const addr = composeDefaults().addrs[0] ?? "";
    expect(check({ HEARTH_BIFROST_ADDR: addr }).code).toBe(0);
    expect(
      check({ HEARTH_BIFROST_ADDR: addr, HEARTH_BOX_EGRESS_ALLOW: "192.168.1.1/32" }).code,
    ).toBe(0);
    for (const entry of [
      addr,
      `${addr}/32`,
      "172.29.249.0/29",
      "172.29.0.0/16",
      "172.16.0.0/12",
      "128.0.0.0/1",
    ]) {
      const r = check({ HEARTH_BIFROST_ADDR: addr, HEARTH_BOX_EGRESS_ALLOW: `1.1.1.1,${entry}` });
      expect({ entry, code: r.code }).toEqual({ entry, code: 2 });
      expect(r.stderr).toContain(`covers Bifrost's address ${addr}`);
    }
  });

  test("box-firewall.sh refuses a Bifrost address the rules would not reject", () => {
    const r = check({ HEARTH_BIFROST_ADDR: "8.8.8.8" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not in a private range these rules reject");
    expect(check({ HEARTH_BIFROST_ADDR: "bifrost" }).code).toBe(2);
  });
});
