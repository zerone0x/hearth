/**
 * The hub's side of the Bifrost gateway service (PRD §6.4, decision 0046).
 *
 * - **Secrets from the vault.** Bifrost's admin password and its
 *   `encryption_key` (which encrypts the provider keys in Bifrost's own
 *   SQLite config store) are vault entries (`token`, `use: hub`), generated
 *   on the first start with the vault open. They are handed to the Bifrost
 *   container through a tmpfs volume (`HEARTH_BIFROST_HANDOFF_DIR`), never a
 *   file on disk beside Bifrost's store, so a copy of its volume alone does
 *   not give the keys.
 * - **Provider keys are pushed, never typed.** Every global `model-key` entry
 *   whose `meta.provider` Bifrost knows is pushed through the admin API; a
 *   key in Bifrost under a managed provider that is not in the vault is
 *   deleted (the vault is the source, decision 0031). Pushed at start, after
 *   Bifrost comes back, and after a key is added, rotated or deleted.
 * - **Hub-managed.** The two entries are `systemEntries` of the vault: the
 *   API refuses to rotate, re-use or delete them, since Bifrost's store cannot
 *   be read with another encryption key. An existing entry under those names
 *   that is not a global `use: hub` token is never handed over.
 * - **Health.** `GET /health` and an authorized admin call every
 *   `checkEveryMs`; each change of state is one log line, and `/healthz`
 *   reports it (`unavailable` and the state). The hub never depends on
 *   Bifrost being up: no model call uses it yet.
 * - **Never reachable from a box.** At start the hub checks that the box
 *   egress allow list (decisions 0012, 0023) does not cover Bifrost's
 *   address; `scripts/box-firewall.sh` refuses such a list as well.
 *
 * Model traffic does not go through Bifrost yet: #157 adds per-session
 * virtual keys and switches the runner (decision 0046).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_ID, SYSTEM_PRINCIPAL } from "@hearth/core";
import type { SqliteVaultStore } from "../store";
import type { HubVault } from "../vault";
import { BifrostClient } from "./client";

/** The vault entry holding Bifrost's admin password. */
export const BIFROST_ADMIN_ENTRY = "bifrost-admin-password";
/** The vault entry holding Bifrost's `encryption_key`. */
export const BIFROST_ENCRYPTION_ENTRY = "bifrost-encryption-key";
/** The vault entries the hub manages for Bifrost: never rotated, re-used or deleted through the API. */
export const BIFROST_SYSTEM_ENTRIES: readonly string[] = [
  BIFROST_ADMIN_ENTRY,
  BIFROST_ENCRYPTION_ENTRY,
];
/** The file names in the handoff directory, read by `deploy/bifrost/start.sh`. */
export const HANDOFF_FILES = {
  [BIFROST_ADMIN_ENTRY]: "admin_password",
  [BIFROST_ENCRYPTION_ENTRY]: "encryption_key",
} as const;

/**
 * pi provider names (a model key's `meta.provider`) to Bifrost provider names.
 * A provider not listed here is not pushed (one log line per sync).
 */
export const BIFROST_PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  google: "gemini",
  groq: "groq",
  mistral: "mistral",
  openai: "openai",
  openrouter: "openrouter",
};

export type BifrostState =
  | "starting"
  | "vault-disabled"
  | "secrets-unusable"
  | "unreachable"
  | "unauthorized"
  | "box-reachable"
  | "ok";

export interface BifrostStatus {
  readonly state: BifrostState;
  readonly detail: string;
}

export interface BifrostConfig {
  /** `HEARTH_BIFROST_URL`: Bifrost's address on its internal network. */
  readonly url: string;
  /** `HEARTH_BIFROST_HANDOFF_DIR`: the tmpfs directory Bifrost reads its secrets from. */
  readonly handoffDir?: string;
}

export interface BifrostServiceOptions extends BifrostConfig {
  readonly vault: HubVault;
  readonly vaultStore: SqliteVaultStore;
  readonly log: (line: string) => void;
  /** The box egress allow list (CIDRs) the firewall applied, if known (0023). */
  readonly egressAllow?: () => readonly string[];
  readonly fetch?: typeof fetch;
  /** Health check period. Default 30 s; 0 turns the periodic check off (tests). */
  readonly checkEveryMs?: number;
}

/** `HEARTH_BIFROST_URL` and `HEARTH_BIFROST_HANDOFF_DIR`; undefined when Bifrost is not configured. */
export function bifrostConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): BifrostConfig | undefined {
  const url = env["HEARTH_BIFROST_URL"];
  if (url === undefined || url === "") return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`HEARTH_BIFROST_URL must be an http(s) URL, got "${url}"`);
  }
  const handoffDir = env["HEARTH_BIFROST_HANDOFF_DIR"];
  return { url, ...(handoffDir ? { handoffDir } : {}) };
}

function ipv4ToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) return undefined;
  let n = 0;
  for (const part of m.slice(1)) {
    const octet = Number(part);
    if (octet > 255) return undefined;
    n = n * 256 + octet;
  }
  return n;
}

/** Whether IPv4 `ip` lies in `cidr` (`a.b.c.d/n` or a bare address). */
export function cidrCovers(cidr: string, ip: string): boolean {
  const [net, prefixText = "32"] = cidr.split("/");
  const prefix = Number(prefixText);
  const a = ipv4ToInt(ip);
  const b = net === undefined ? undefined : ipv4ToInt(net);
  if (a === undefined || b === undefined || !Number.isInteger(prefix)) return false;
  if (prefix <= 0) return true;
  if (prefix > 32) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(a / size) === Math.floor(b / size);
}

/**
 * The allow entries that would let a box reach Bifrost at `url`. A host name
 * (not an IPv4 literal) cannot be checked here and yields none; the compose
 * install uses a fixed address, which `box-firewall.sh` checks as well.
 */
export function allowEntriesCovering(url: string, allow: readonly string[]): string[] {
  const host = new URL(url).hostname;
  if (ipv4ToInt(host) === undefined) return [];
  return allow.filter((entry) => cidrCovers(entry.trim(), host));
}

/** The `allow=` list of the firewall marker (`scripts/box-firewall.sh`), or none. */
export function markerAllowList(text: string): string[] {
  const m = /(?:^|\s)allow=(\S*)/.exec(text);
  if (m === null || m[1] === undefined || m[1] === "") return [];
  return m[1].split(",").filter((entry) => entry !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class BifrostService {
  readonly #o: BifrostServiceOptions;
  #status: BifrostStatus = { state: "starting", detail: "not checked yet" };
  #client: BifrostClient | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #syncing: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(options: BifrostServiceOptions) {
    this.#o = options;
  }

  get status(): BifrostStatus {
    return this.#status;
  }

  /**
   * Once the vault opened: the secrets, the handoff, the first check and the
   * first key push. Never throws: a failure is a state and a log line.
   */
  async start(): Promise<void> {
    const covering = allowEntriesCovering(this.#o.url, this.#o.egressAllow?.() ?? []);
    if (covering.length > 0) {
      this.#set(
        "box-reachable",
        `the box egress allow list (${covering.join(",")}) covers Bifrost's address; remove it from HEARTH_BOX_EGRESS_ALLOW and apply the firewall again`,
      );
      return;
    }
    if (this.#o.vault.currentStatus.state !== "enabled") {
      this.#set("vault-disabled", "Bifrost's admin password and encryption key live in the vault");
      return;
    }
    let password: string;
    try {
      password = await this.#secret(BIFROST_ADMIN_ENTRY);
      const encryptionKey = await this.#secret(BIFROST_ENCRYPTION_ENTRY);
      if (this.#o.handoffDir !== undefined) {
        writeHandoff(this.#o.handoffDir, {
          [HANDOFF_FILES[BIFROST_ADMIN_ENTRY]]: password,
          [HANDOFF_FILES[BIFROST_ENCRYPTION_ENTRY]]: encryptionKey,
        });
      }
    } catch (error) {
      this.#set("secrets-unusable", `could not prepare Bifrost's secrets: ${String(error)}`);
      return;
    }
    this.#client = new BifrostClient({
      baseUrl: this.#o.url,
      password,
      ...(this.#o.fetch === undefined ? {} : { fetch: this.#o.fetch }),
    });
    await this.check();
    const every = this.#o.checkEveryMs ?? 30_000;
    if (every > 0 && !this.#stopped) {
      this.#timer = setInterval(() => void this.check(), every);
      this.#timer.unref?.();
    }
  }

  /** One health check; a change to `ok` pushes the keys. */
  async check(): Promise<BifrostStatus> {
    const client = this.#client;
    if (client === undefined || this.#stopped) return this.#status;
    const health = await client.health();
    if (!health.ok) {
      this.#set("unreachable", health.detail);
      return this.#status;
    }
    let authorized: boolean;
    try {
      authorized = await client.authorized();
    } catch (error) {
      this.#set("unreachable", error instanceof Error ? error.message : String(error));
      return this.#status;
    }
    if (!authorized) {
      this.#set("unauthorized", `the admin password in vault:${BIFROST_ADMIN_ENTRY} was refused`);
      return this.#status;
    }
    const was = this.#status.state;
    this.#set("ok", "ok");
    if (was !== "ok") await this.syncKeys();
    return this.#status;
  }

  /** A vault entry was added, rotated or deleted: push the model keys again. */
  entryChanged(name: string): void {
    if (name === BIFROST_ADMIN_ENTRY || name === BIFROST_ENCRYPTION_ENTRY) {
      this.#o.log(
        `bifrost: vault:${name} changed; Bifrost keeps the old value until it is set up again (decision 0046)`,
      );
      return;
    }
    const row = this.#o.vaultStore.byName(DEFAULT_WORKSPACE_ID, name);
    if (row !== undefined && row.kind !== "model-key") return;
    if (this.#status.state === "ok") void this.syncKeys();
  }

  /** Push every global model key to Bifrost and drop the keys the vault no longer has. */
  syncKeys(): Promise<void> {
    const next = this.#syncing.then(() => this.#sync());
    this.#syncing = next.catch(() => undefined);
    return next;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  async #sync(): Promise<void> {
    const client = this.#client;
    if (client === undefined || this.#stopped) return;
    try {
      const wanted = new Map<string, string[]>();
      const skipped = new Set<string>();
      for (const row of this.#o.vaultStore.list(DEFAULT_WORKSPACE_ID)) {
        if (row.kind !== "model-key" || row.scopeSessionId !== null) continue;
        const meta: unknown = JSON.parse(row.metaJson);
        const provider = isRecord(meta) ? meta["provider"] : undefined;
        if (typeof provider !== "string") continue;
        const target = BIFROST_PROVIDERS[provider];
        if (target === undefined) {
          skipped.add(provider);
          continue;
        }
        wanted.set(target, [...(wanted.get(target) ?? []), row.name]);
      }
      const configured = new Set(await client.providers());
      const managed = new Set(Object.values(BIFROST_PROVIDERS));
      let pushed = 0;
      let removed = 0;
      for (const provider of managed) {
        const names = wanted.get(provider) ?? [];
        if (!configured.has(provider)) {
          if (names.length === 0) continue;
          await client.addProvider(provider);
        }
        const existing = await client.keys(provider);
        for (const key of existing) {
          if (!names.includes(key.name)) {
            await client.deleteKey(provider, key.id);
            removed++;
          }
        }
        for (const name of names) {
          const value = await this.#o.vault.readForHub(name, undefined, `vault:${name}`);
          const input = { name, value, models: ["*"] };
          const current = existing.find((k) => k.name === name);
          if (current === undefined) await client.addKey(provider, input);
          else await client.updateKey(provider, current.id, input);
          pushed++;
        }
      }
      const extra =
        skipped.size === 0
          ? ""
          : `; not pushed (no Bifrost provider): ${[...skipped].sort().join(", ")}`;
      this.#o.log(
        `bifrost: provider keys pushed from the vault (${pushed} set, ${removed} removed)${extra}`,
      );
    } catch (error) {
      this.#o.log(
        `bifrost: could not push the provider keys: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The entry's value; generated (32 random bytes, base64url) and stored on
   * first use. An existing entry is used only when it is what the hub made: a
   * global `token` with `use: hub`. Anything else (an entry made by hand
   * under this name before Bifrost was configured, or a `box-env` token) is
   * refused, never handed to Bifrost.
   */
  async #secret(name: string): Promise<string> {
    const row = this.#o.vaultStore.byName(DEFAULT_WORKSPACE_ID, name);
    if (row !== undefined) {
      const policy: unknown = JSON.parse(row.policyJson);
      const use = isRecord(policy) ? policy["use"] : undefined;
      if (row.kind !== "token" || use !== "hub" || row.scopeSessionId !== null) {
        throw new Error(
          `vault:${name} is not a global token with use hub (kind ${row.kind}, use ${String(use)}); delete it so the hub can generate it`,
        );
      }
    } else {
      await this.#o.vault.create(SYSTEM_PRINCIPAL, {
        name,
        kind: "token",
        policy: { use: "hub" },
        meta: { label: "generated for the Bifrost gateway (decision 0046)" },
        fields: { value: randomBytes(32).toString("base64url") },
      });
    }
    return this.#o.vault.readForHub(name, undefined, `vault:${name}`);
  }

  #set(state: BifrostState, detail: string): void {
    const changed = state !== this.#status.state || detail !== this.#status.detail;
    this.#status = { state, detail };
    if (changed) this.#o.log(state === "ok" ? "bifrost: ok" : `bifrost: ${state} (${detail})`);
  }
}

/**
 * Write each file into `dir` atomically, mode 0440: the hub runs as root and
 * Bifrost as uid 1000 in group 0, so group read is what Bifrost needs.
 */
export function writeHandoff(dir: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  for (const [name, value] of Object.entries(files)) {
    const tmp = join(dir, `.${name}.tmp`);
    rmSync(tmp, { force: true });
    writeFileSync(tmp, value, { mode: 0o440 });
    chmodSync(tmp, 0o440);
    renameSync(tmp, join(dir, name));
  }
}
