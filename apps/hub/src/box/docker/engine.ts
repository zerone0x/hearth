/**
 * A minimal Docker Engine API client over the daemon's unix socket (decision 0007).
 *
 * No `docker` CLI, no SDK: the provider needs about fifteen endpoints, and plain
 * `fetch` with Bun's `unix` option speaks HTTP to the socket directly. Every
 * request has its own named deadline (PRD §8.1 principle 8).
 */

import { HearthError } from "@hearth/core";

/** A response from the daemon with a status code the caller did not expect. */
export class DockerApiError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(endpoint: string, status: number, message: string) {
    super(`docker ${endpoint}: ${status} ${message}`);
    this.name = "DockerApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

export interface DockerResponse {
  readonly status: number;
  /** Parsed JSON body, or `undefined` for an empty or non-JSON body. */
  readonly body: unknown;
  /** The raw body text. */
  readonly text: string;
}

export interface DockerRequest {
  readonly method: "GET" | "POST" | "DELETE";
  /** Path below the version prefix, e.g. `/containers/abc/json`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  /** The statuses this call handles itself; any other status throws `DockerApiError`. */
  readonly ok: readonly number[];
  /** Deadline for this request in milliseconds, named by the caller. */
  readonly timeoutMs: number;
  /** What the request is for, used in errors (`container.create`, `volume.remove`, …). */
  readonly endpoint: string;
}

export interface DockerEngineOptions {
  readonly socketPath: string;
  /** Engine API version, e.g. `1.44`. Requests go to `/v<version>/…`. */
  readonly apiVersion: string;
}

/**
 * Connection failures mean the hub cannot reach its own backend, so they are
 * `hub`-owned (PRD §8.1 principle 2). A missing or refusing socket may come back
 * (the daemon restarting); a permission error will not fix itself.
 */
function classifyTransportError(endpoint: string, error: unknown): HearthError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new HearthError(`docker ${endpoint}: the daemon did not answer in time`, {
      owner: "hub",
      disposition: "retry",
      code: "docker.timeout",
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new HearthError(`docker ${endpoint}: permission denied on the Docker socket`, {
      owner: "hub",
      disposition: "give-up",
      code: "docker.permission-denied",
      cause: error,
    });
  }
  return new HearthError(`docker ${endpoint}: cannot reach the Docker daemon (${code || name})`, {
    owner: "hub",
    disposition: "retry",
    code: "docker.unreachable",
    cause: error,
  });
}

export class DockerEngine {
  readonly #socketPath: string;
  readonly #prefix: string;

  constructor(options: DockerEngineOptions) {
    this.#socketPath = options.socketPath;
    this.#prefix = `/v${options.apiVersion}`;
  }

  async request(req: DockerRequest): Promise<DockerResponse> {
    const url = new URL(`http://docker${this.#prefix}${req.path}`);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const init: RequestInit & { unix: string } = {
      method: req.method,
      unix: this.#socketPath,
      signal: AbortSignal.timeout(req.timeoutMs),
    };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      init.headers = { "content-type": "application/json" };
    }
    let status: number;
    let text: string;
    try {
      const res = await fetch(url, init);
      status = res.status;
      text = await res.text();
    } catch (error) {
      throw classifyTransportError(req.endpoint, error);
    }
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    if (!req.ok.includes(status)) {
      throw new DockerApiError(req.endpoint, status, errorMessage(body, text));
    }
    return { status, body, text };
  }
}

/** The daemon's `{ "message": … }` error text, or the raw body. */
export function errorMessage(body: unknown, text: string): string {
  if (typeof body === "object" && body !== null && "message" in body) {
    return String((body as { message: unknown }).message);
  }
  return text.slice(0, 500);
}
