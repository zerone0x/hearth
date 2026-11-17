/**
 * A small typed client for the parts of Bifrost's admin API the hub uses
 * (decision 0046): its health and the provider keys pushed from the vault.
 * Bifrost v2.5.1 (`maximhq/bifrost`, Apache-2.0); shapes as verified against
 * the binary (docs/research/m3-models-access.md, question 4), and the
 * per-session virtual keys and their spend (#157, decision 0047).
 *
 * The admin password is sent as HTTP Basic auth on every `/api` call; it is
 * never logged and never part of an error message.
 */

import { HearthError } from "@hearth/core";

/** Bifrost's admin user name in Hearth's config (`deploy/bifrost/config.json`). */
export const BIFROST_ADMIN_USER = "hearth";

/** A provider key as Bifrost lists it: the value comes back masked (`sk-f****-123`). */
export interface BifrostKey {
  readonly id: string;
  readonly name: string;
  readonly models: readonly string[];
}

/** What the hub sends for one key. `models: ["*"]`: an empty list supports no model. */
export interface BifrostKeyInput {
  readonly name: string;
  readonly value: string;
  readonly models: readonly string[];
}

export interface BifrostHealth {
  readonly ok: boolean;
  /** `ok`, or why not: an HTTP status or a connection error, without secrets. */
  readonly detail: string;
}

export interface BifrostClientOptions {
  /** Bifrost's base URL, e.g. `http://172.29.249.2:8080`. */
  readonly baseUrl: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
  /** Per request. Default 10 s. */
  readonly timeoutMs?: number;
}

/**
 * A per-session virtual key as the hub asks for it (decision 0047). The model
 * allowlist is explicit and never empty: Bifrost reads an empty list
 * differently from PRD §6.4 ("empty means none"), so the client refuses one
 * before anything is sent. No key ever sets `allow_all_providers`.
 */
export interface VirtualKeyInput {
  readonly name: string;
  /** The Bifrost provider, e.g. `openai`. */
  readonly provider: string;
  /** Model ids as Bifrost names them for that provider, e.g. `gpt-4o-mini`. */
  readonly models: readonly string[];
  /** The budget in US dollars, over `BUDGET_RESET` (a lifetime for a session). */
  readonly budgetUsd: number;
}

/** A virtual key Bifrost made or rotated: the value lives only in the caller's memory. */
export interface IssuedVirtualKey {
  readonly id: string;
  readonly value: string;
}

/** Bifrost's request-log totals for one virtual key (`GET /api/logs/stats`). */
export interface VirtualKeyStats {
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/** The budget window of a session's key: long enough to be the session's lifetime. */
export const BUDGET_RESET = "1Y";
/** Requests per minute a session's key allows (Bifrost answers 429 above it). */
export const SESSION_RATE_LIMIT = { requests: 120, reset: "1m" } as const;

/** The checked allowlist: non-empty, model ids only (no `*`), no duplicates. */
export function checkAllowlist(models: readonly unknown[]): string[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw new HearthError("a virtual key needs at least one allowed model (empty means none)", {
      owner: "hub",
      disposition: "give-up",
      code: "bifrost.empty-allowlist",
    });
  }
  for (const m of models) {
    if (typeof m !== "string" || m.trim() === "" || m.includes("*")) {
      throw new HearthError(`not a model id for an allowlist: ${JSON.stringify(m)}`, {
        owner: "hub",
        disposition: "give-up",
        code: "bifrost.bad-allowlist",
      });
    }
  }
  return [...new Set(models as string[])];
}

function checkBudget(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new HearthError(`a session budget must be a positive amount, got ${usd}`, {
      owner: "hub",
      disposition: "give-up",
      code: "bifrost.bad-budget",
    });
  }
  return usd;
}

/** The body Bifrost gets for a key's provider config: always `allow_all_providers: false`. */
export function virtualKeyBody(
  input: Pick<VirtualKeyInput, "provider" | "models"> & Partial<VirtualKeyInput>,
): Record<string, unknown> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    provider_configs: [
      {
        provider: checkProvider(input.provider),
        allowed_models: checkAllowlist(input.models),
        key_ids: ["*"],
      },
    ],
    allow_all_providers: false,
    ...(input.budgetUsd === undefined
      ? {}
      : { budgets: [{ max_limit: checkBudget(input.budgetUsd), reset_duration: BUDGET_RESET }] }),
  };
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function issuedOf(body: unknown): IssuedVirtualKey | undefined {
  const vk = isRecord(body) ? body["virtual_key"] : undefined;
  if (!isRecord(vk) || typeof vk["id"] !== "string" || typeof vk["value"] !== "string") {
    return undefined;
  }
  return { id: vk["id"], value: vk["value"] };
}

/** A provider name as Bifrost takes it in a path. */
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(code: string, message: string): HearthError {
  return new HearthError(message, { owner: "gateway", disposition: "retry", code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keyOf(value: unknown): BifrostKey | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, models } = value;
  if (typeof id !== "string" || typeof name !== "string") return undefined;
  return {
    id,
    name,
    models: Array.isArray(models) ? models.filter((m): m is string => typeof m === "string") : [],
  };
}

export class BifrostClient {
  readonly #base: string;
  readonly #auth: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: BifrostClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Bifrost URL must be http(s), got ${url.protocol}`);
    }
    this.#base = url.origin;
    this.#auth = `Basic ${Buffer.from(`${BIFROST_ADMIN_USER}:${options.password}`).toString("base64")}`;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** `GET /health` (no auth). Never throws. */
  async health(): Promise<BifrostHealth> {
    try {
      const res = await this.#fetch(`${this.#base}/health`, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const body: unknown = await res.json().catch(() => undefined);
      if (res.ok && isRecord(body) && body["status"] === "ok") return { ok: true, detail: "ok" };
      return { ok: false, detail: `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.name : "error" };
    }
  }

  /** Whether the admin password is accepted (`GET /api/providers` is not 401). */
  async authorized(): Promise<boolean> {
    const res = await this.#call("GET", "/api/providers", undefined, [200, 401]);
    return res.status === 200;
  }

  /** The providers Bifrost has configured, by name. */
  async providers(): Promise<string[]> {
    const body = (await this.#call("GET", "/api/providers")).body;
    const list = isRecord(body) && Array.isArray(body["providers"]) ? body["providers"] : [];
    return list.flatMap((p) => (isRecord(p) && typeof p["name"] === "string" ? [p["name"]] : []));
  }

  /** `POST /api/providers`: add a provider with no keys (they are pushed one by one). */
  async addProvider(provider: string): Promise<void> {
    await this.#call("POST", "/api/providers", { provider: checkProvider(provider) });
  }

  async keys(provider: string): Promise<BifrostKey[]> {
    const body = (await this.#call("GET", `/api/providers/${checkProvider(provider)}/keys`)).body;
    const list = isRecord(body) && Array.isArray(body["keys"]) ? body["keys"] : [];
    return list.flatMap((k) => keyOf(k) ?? []);
  }

  async addKey(provider: string, key: BifrostKeyInput): Promise<BifrostKey> {
    const body = (
      await this.#call("POST", `/api/providers/${checkProvider(provider)}/keys`, keyBody(key))
    ).body;
    const created = keyOf(body);
    if (created === undefined) throw fail("bifrost.bad-answer", "Bifrost answered no key id");
    return created;
  }

  async updateKey(provider: string, id: string, key: BifrostKeyInput): Promise<void> {
    await this.#call(
      "PUT",
      `/api/providers/${checkProvider(provider)}/keys/${encodeURIComponent(id)}`,
      keyBody(key),
    );
  }

  async deleteKey(provider: string, id: string): Promise<void> {
    await this.#call(
      "DELETE",
      `/api/providers/${checkProvider(provider)}/keys/${encodeURIComponent(id)}`,
    );
  }

  /** `POST /api/governance/virtual-keys`: allowlist, budget and rate limit; never all providers. */
  async createVirtualKey(input: VirtualKeyInput): Promise<IssuedVirtualKey> {
    const body = {
      ...virtualKeyBody(input),
      rate_limit: {
        request_max_limit: SESSION_RATE_LIMIT.requests,
        request_reset_duration: SESSION_RATE_LIMIT.reset,
      },
      is_active: true,
    };
    const issued = issuedOf((await this.#call("POST", "/api/governance/virtual-keys", body)).body);
    if (issued === undefined) throw fail("bifrost.bad-answer", "Bifrost answered no virtual key");
    return issued;
  }

  /** `PUT /api/governance/virtual-keys/{id}`: a model switch (allowlist) and the budget. */
  async updateVirtualKey(
    id: string,
    input: Pick<VirtualKeyInput, "provider" | "models"> & { budgetUsd?: number },
  ): Promise<void> {
    await this.#call("PUT", vkPath(id), virtualKeyBody(input));
  }

  /** `PUT …/{id} {is_active}`: an inactive key is refused (403) on every model call. */
  async setVirtualKeyActive(id: string, active: boolean): Promise<void> {
    await this.#call("PUT", vkPath(id), { is_active: active });
  }

  /** `POST …/{id}/rotate`: a new value; the old one is refused at once. */
  async rotateVirtualKey(id: string): Promise<IssuedVirtualKey> {
    const issued = issuedOf((await this.#call("POST", `${vkPath(id)}/rotate`)).body);
    if (issued === undefined) throw fail("bifrost.bad-answer", "Bifrost answered no virtual key");
    return issued;
  }

  /** `DELETE …/{id}`; a key already gone is not an error. Its log rows stay. */
  async deleteVirtualKey(id: string): Promise<void> {
    await this.#call("DELETE", vkPath(id), undefined, [200, 404]);
  }

  /**
   * Request-log totals for `id`, or for every key when `id` is undefined.
   * Bifrost writes log rows in batches (about 5 s), so a call that just ended
   * may not be counted yet.
   */
  async stats(id?: string): Promise<VirtualKeyStats> {
    const query = id === undefined ? "" : `?virtual_key_ids=${encodeURIComponent(id)}`;
    const body = (await this.#call("GET", `/api/logs/stats${query}`)).body;
    const b = isRecord(body) ? body : {};
    return {
      requests: numberOf(b["total_requests"]),
      promptTokens: numberOf(b["prompt_tokens"]),
      completionTokens: numberOf(b["completion_tokens"]),
      totalTokens: numberOf(b["total_tokens"]),
      costUsd: numberOf(b["total_cost"]),
    };
  }

  async #call(
    method: string,
    path: string,
    body?: unknown,
    accept: readonly number[] = [200],
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          Authorization: this.#auth,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const why = error instanceof Error ? error.name : "error";
      throw fail("bifrost.unreachable", `Bifrost ${method} ${path}: ${why}`);
    }
    const parsed: unknown = await res.json().catch(() => undefined);
    if (!accept.includes(res.status)) {
      // Bifrost's own message, never the request (it may hold a key value).
      const message =
        isRecord(parsed) &&
        isRecord(parsed["error"]) &&
        typeof parsed["error"]["message"] === "string"
          ? `: ${parsed["error"]["message"].slice(0, 200)}`
          : "";
      throw fail(
        res.status === 401 ? "bifrost.unauthorized" : "bifrost.http",
        `Bifrost ${method} ${path} answered ${res.status}${message}`,
      );
    }
    return { status: res.status, body: parsed };
  }
}

function checkProvider(provider: string): string {
  if (!PROVIDER.test(provider)) throw new Error(`not a Bifrost provider name: ${provider}`);
  return provider;
}

function vkPath(id: string): string {
  return `/api/governance/virtual-keys/${encodeURIComponent(id)}`;
}

function keyBody(key: BifrostKeyInput): Record<string, unknown> {
  return { name: key.name, value: key.value, models: [...key.models], weight: 1 };
}
