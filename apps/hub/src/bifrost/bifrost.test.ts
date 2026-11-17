/**
 * The Bifrost service (decision 0046) against a fake of Bifrost's admin API:
 * secrets generated into the vault and handed off, provider keys pushed from
 * the vault and nothing else kept, health in `/healthz`, and the box egress
 * allow-list check. `bifrost.binary.test.ts` runs the same against the real
 * binary; `box-firewall.sh check` is covered here, its rules in firewall.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createDefaultSecretStore,
  HearthError,
  LOCAL_PRINCIPAL,
  SYSTEM_PRINCIPAL,
} from "@hearth/core";
import { egressAllowFromMarker } from "../main";
import { type Hub, startHub } from "../server";
import {
  allowEntriesCovering,
  BIFROST_ADMIN_ENTRY,
  BIFROST_ENCRYPTION_ENTRY,
  BIFROST_SYSTEM_ENTRIES,
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
    expect(await healthz(hub)).toMatchObject({ bifrost: "ok", bifrostState: "ok" });
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
    expect(await healthz(hub)).toMatchObject({
      status: "ok",
      bifrost: "unavailable",
      bifrostState: "unreachable",
    });
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
    expect(await healthz(hub)).toMatchObject({
      bifrost: "unavailable",
      bifrostState: "vault-disabled",
    });
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
    expect(await healthz(hub)).toMatchObject({
      status: "ok",
      bifrost: "unavailable",
      bifrostState: "box-reachable",
    });
    expect(logs.some((l) => l.includes("covers Bifrost's address"))).toBe(true);
    expect(await hub.vault.list(LOCAL_PRINCIPAL)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("a session-scoped model key is never pushed: only global keys go to Bifrost", async () => {
    const { hub, fake } = start();
    await hub.bifrostReady;
    const session = await hub.sessions.create(LOCAL_PRINCIPAL, { title: "scoped" });
    await hub.vault.create(LOCAL_PRINCIPAL, {
      name: "model-key-openai-session",
      kind: "model-key",
      scope: { sessionId: session.id },
      meta: { provider: "openai" },
      fields: { value: "sk-bifrost-test-session-scoped-77d1" },
    });
    await hub.bifrost?.syncKeys();
    expect([...fake.providers.keys()]).toEqual([]);
    await addOpenAiKey(hub);
    await hub.bifrost?.syncKeys();
    expect(fake.providers.get("openai")?.map((k) => k.name)).toEqual(["model-key-openai"]);
  });

  test("the start reads the firewall marker's allow list and refuses a list that covers Bifrost", async () => {
    const marker = join(dir, "box-egress.applied");
    writeFileSync(
      marker,
      "applied 2026-11-17T00:00:00Z port=8788 allow=1.1.1.1/32,172.29.249.0/29\n",
    );
    expect(egressAllowFromMarker(marker)).toEqual(["1.1.1.1/32", "172.29.249.0/29"]);
    expect(egressAllowFromMarker(join(dir, "no-marker"))).toEqual([]);
    const { hub, fake } = start({
      url: "http://172.29.249.2:8080",
      egressAllow: egressAllowFromMarker(marker),
    });
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("box-reachable");
    expect(fake.calls).toEqual([]);
  });

  async function refusal(call: Promise<unknown>): Promise<string> {
    try {
      await call;
    } catch (error) {
      if (error instanceof HearthError) return `${error.code}: ${error.message}`;
      throw error;
    }
    return "not refused";
  }

  test("Bifrost's two vault entries are the hub's: no rotate, use change, delete or hand-made copy", async () => {
    const { hub, logs } = start();
    await hub.bifrostReady;
    const pw = handoff("admin_password");
    const enc = handoff("encryption_key");
    const listed = (await hub.vault.list(LOCAL_PRINCIPAL)).filter((e) =>
      BIFROST_SYSTEM_ENTRIES.includes(e.name),
    );
    expect(listed.map((e) => [e.name, e.system]).sort()).toEqual([
      [BIFROST_ADMIN_ENTRY, true],
      [BIFROST_ENCRYPTION_ENTRY, true],
    ]);
    for (const entry of listed) {
      for (const call of [
        hub.vault.rotate(LOCAL_PRINCIPAL, entry.id, { fields: { value: "x".repeat(43) } }),
        hub.vault.rotate(LOCAL_PRINCIPAL, entry.id, {
          fields: { value: "x".repeat(43) },
          use: "box-env",
        }),
        hub.vault.remove(LOCAL_PRINCIPAL, entry.id),
      ]) {
        const refused = await refusal(call);
        expect(refused).toStartWith(`secret.system-managed: ${entry.name} is managed by the hub`);
      }
    }
    // Nothing changed: same entries, same version, same values handed over.
    const after = (await hub.vault.list(LOCAL_PRINCIPAL)).filter((e) =>
      BIFROST_SYSTEM_ENTRIES.includes(e.name),
    );
    expect(after.map((e) => [e.name, e.version, e.policy])).toEqual(
      listed.map((e) => [e.name, 1, { hosts: [], use: "hub" }]),
    );
    expect(logs.some((l) => l.includes("rotated") || l.includes("deleted"))).toBe(false);
    rmSync(join(dir, "handoff"), { recursive: true, force: true });
    await hub.stop();
    hubs = [];
    const again = start();
    await again.hub.bifrostReady;
    expect(handoff("admin_password")).toBe(pw);
    expect(handoff("encryption_key")).toBe(enc);
    // A user cannot create one under a reserved name either.
    const plain = startHub({
      dbPath: join(dir, "other.db"),
      port: 0,
      boxPort: 0,
      log: () => {},
      vault: {
        keyRef: "env:VAULT_KEY",
        keySecrets: createDefaultSecretStore({ env: { VAULT_KEY } }),
      },
    });
    hubs.push(plain);
    await plain.vaultReady;
    expect(
      await refusal(
        plain.vault.create(LOCAL_PRINCIPAL, {
          name: BIFROST_ENCRYPTION_ENTRY,
          kind: "token",
          fields: { value: "owner-typed-encryption-key" },
        }),
      ),
    ).toStartWith(`secret.system-managed: ${BIFROST_ENCRYPTION_ENTRY} is managed by the hub`);
  });

  test("an existing entry under a Bifrost name that is not a hub token is refused, not handed over", async () => {
    // Made before Bifrost was configured (only the hub may create one now): a box-env token.
    const before = startHub({
      dbPath: join(dir, "hub.db"),
      port: 0,
      boxPort: 0,
      log: () => {},
      vault: {
        keyRef: "env:VAULT_KEY",
        keySecrets: createDefaultSecretStore({ env: { VAULT_KEY } }),
      },
    });
    await before.vaultReady;
    const made = await before.vault.create(SYSTEM_PRINCIPAL, {
      name: BIFROST_ENCRYPTION_ENTRY,
      kind: "token",
      policy: { use: "box-env" },
      fields: { value: "owner-typed-box-env-value-1d3f" },
    });
    await before.stop();
    const { hub, fake, logs } = start();
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("secrets-unusable");
    expect(hub.bifrost?.status.detail).toContain(
      `vault:${BIFROST_ENCRYPTION_ENTRY} is not a global token with use hub`,
    );
    expect(await healthz(hub)).toMatchObject({
      bifrost: "unavailable",
      bifrostState: "secrets-unusable",
    });
    expect(() => handoff("encryption_key")).toThrow();
    expect(fake.calls).toEqual([]);
    expect(logs.join("\n")).not.toContain("owner-typed-box-env-value-1d3f");
    // It is not the hub's, so the owner may delete it; the next start makes the hub's own.
    const view = (await hub.vault.list(LOCAL_PRINCIPAL)).find((e) => e.id === made.id);
    expect(view?.system).toBe(false);
    await hub.vault.remove(LOCAL_PRINCIPAL, made.id);
    await hub.stop();
    hubs = [];
    const again = start();
    await again.hub.bifrostReady;
    expect(again.hub.bifrost?.status.state).toBe("ok");
    expect(handoff("encryption_key")).not.toBe("owner-typed-box-env-value-1d3f");
  });

  // #157, from the #159 verification: the refusal checks the scope too.
  test("a session-scoped `use: hub` token under a Bifrost name (pre-0046 data) is refused, not handed over", async () => {
    const before = startHub({
      dbPath: join(dir, "hub.db"),
      port: 0,
      boxPort: 0,
      log: () => {},
      vault: {
        keyRef: "env:VAULT_KEY",
        keySecrets: createDefaultSecretStore({ env: { VAULT_KEY } }),
      },
    });
    await before.vaultReady;
    const session = await before.sessions.create(LOCAL_PRINCIPAL, { title: "old" });
    await before.vault.create(SYSTEM_PRINCIPAL, {
      name: BIFROST_ADMIN_ENTRY,
      kind: "token",
      policy: { use: "hub" },
      scope: { sessionId: session.id },
      fields: { value: "session-scoped-hub-token-value-5e2a" },
    });
    await before.stop();
    const { hub, fake, logs } = start();
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("secrets-unusable");
    expect(hub.bifrost?.status.detail).toContain(
      `vault:${BIFROST_ADMIN_ENTRY} is not a global token with use hub`,
    );
    expect(() => handoff("admin_password")).toThrow();
    expect(fake.calls).toEqual([]);
    expect(logs.join("\n")).not.toContain("session-scoped-hub-token-value-5e2a");
  });

  test("the hub's own first creation of its two entries is not logged as a change", async () => {
    const { hub, logs } = start();
    await hub.bifrostReady;
    expect(hub.bifrost?.status.state).toBe("ok");
    expect(logs.filter((l) => l.includes("Bifrost keeps the old value"))).toEqual([]);
    // A later change still is (an entry's value changing under Bifrost).
    hub.bifrost?.entryChanged(BIFROST_ADMIN_ENTRY);
    expect(logs.filter((l) => l.includes("Bifrost keeps the old value"))).toHaveLength(1);
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

  test("compose: the hub does not depend on Bifrost (a model call waits for it, decision 0047)", () => {
    const compose = Bun.YAML.parse(readFileSync(join(REPO, "deploy/compose.yaml"), "utf8")) as {
      services: Record<string, { depends_on?: Record<string, unknown> }>;
    };
    expect(compose.services["bifrost"]).toBeDefined();
    expect(Object.keys(compose.services["hub"]?.depends_on ?? {}).sort()).toEqual([
      "box-firewall",
      "box-image",
    ]);
  });

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
