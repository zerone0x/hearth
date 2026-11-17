/**
 * A small typed client for the parts of Bifrost's admin API the hub uses
 * (decision 0046): its health and the provider keys pushed from the vault.
 * Bifrost v2.5.1 (`maximhq/bifrost`, Apache-2.0); shapes as verified against
 * the binary (docs/research/m3-models-access.md, question 4). Per-session
 * virtual keys are #157 and not here.
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

function keyBody(key: BifrostKeyInput): Record<string, unknown> {
  return { name: key.name, value: key.value, models: [...key.models], weight: 1 };
}
