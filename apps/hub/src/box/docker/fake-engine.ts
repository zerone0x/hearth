/**
 * Test support: an in-memory fake of the Docker Engine API endpoints the
 * provider uses, served over a unix socket in a temporary directory. It records
 * every request so tests can assert on the labels and limits sent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RecordedRequest {
  readonly method: string;
  /** Path without the version prefix. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface FakeContainer {
  Id: string;
  Name: string;
  Created: string;
  State: { Status: string };
  Config: { Image: string; Labels: Record<string, string>; Env: string[] };
  HostConfig: Record<string, unknown>;
}

export interface FakeVolume {
  Name: string;
  CreatedAt: string;
  Labels: Record<string, string>;
}

export interface FakeNetwork {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  Options: Record<string, string>;
  Internal: boolean;
}

type Override = (req: RecordedRequest) => Response | undefined;

const json = (status: number, body: unknown) => Response.json(body, { status });
const message = (status: number, text: string) => json(status, { message: text });

export class FakeDockerEngine {
  readonly dir: string;
  readonly socketPath: string;
  readonly requests: RecordedRequest[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, FakeVolume>();
  readonly networks = new Map<string, FakeNetwork>();
  /** Image reference to its labels. */
  readonly images = new Map<string, Record<string, string>>();
  /** Images a pull can fetch, with their labels. */
  readonly registry = new Map<string, Record<string, string>>();
  /** Answer a request before the fake does; return `undefined` to fall through. */
  override: Override | undefined;
  readonly #server: ReturnType<typeof Bun.serve>;
  #seq = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "hearth-fake-docker-"));
    this.socketPath = join(this.dir, "docker.sock");
    this.#server = Bun.serve({ unix: this.socketPath, fetch: (r) => this.#handle(r) });
  }

  close(): void {
    this.#server.stop(true);
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Requests matching a method and a path pattern. */
  calls(method: string, path: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && path.test(r.path));
  }

  #container(ref: string): FakeContainer | undefined {
    for (const c of this.containers.values()) if (c.Id === ref || c.Name === ref) return c;
    return undefined;
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const version = url.pathname.match(/^\/v[0-9.]+/)?.[0] ?? "";
    const path = url.pathname.slice(version.length);
    const text = await request.text();
    const rec: RecordedRequest = {
      method: request.method,
      path,
      query: url.searchParams,
      body: text ? JSON.parse(text) : undefined,
    };
    this.requests.push(rec);
    if (version === "") return message(400, "no API version");
    const overridden = this.override?.(rec);
    if (overridden !== undefined) return overridden;
    return this.#route(rec);
  }

  #route(rec: RecordedRequest): Response {
    const { method, path, query } = rec;
    const body = (rec.body ?? {}) as Record<string, unknown>;
    const imageMatch = path.match(/^\/images\/(.+)\/json$/);
    const containerMatch = path.match(/^\/containers\/([^/]+)(\/json|\/start|\/stop)?$/);
    const volumeMatch = path.match(/^\/volumes\/([^/]+)$/);
    const networkMatch = path.match(/^\/networks\/([^/]+)$/);

    // Images.
    if (method === "GET" && imageMatch) {
      const m = imageMatch;
      const labels = this.images.get(m[1] as string);
      return labels === undefined
        ? message(404, `No such image: ${m[1]}`)
        : json(200, { Id: `sha256:${m[1]}`, Config: { Labels: labels } });
    }
    if (method === "POST" && path === "/images/create") {
      const ref = query.get("fromImage") ?? "";
      const labels = this.registry.get(ref);
      if (labels === undefined) {
        return new Response(
          `${JSON.stringify({ status: "Pulling" })}\n${JSON.stringify({ error: `manifest unknown: ${ref}` })}\n`,
        );
      }
      this.images.set(ref, labels);
      return new Response(`${JSON.stringify({ status: `Downloaded ${ref}` })}\n`);
    }

    // Containers.
    if (method === "GET" && path === "/containers/json") {
      const wanted = labelFilters(query);
      return json(
        200,
        [...this.containers.values()]
          .filter((c) => wanted.every(([k, v]) => c.Config.Labels[k] === v))
          .map((c) => ({ Id: c.Id, Names: [`/${c.Name}`], Labels: c.Config.Labels })),
      );
    }
    if (method === "POST" && path === "/containers/create") {
      const name = query.get("name") ?? "";
      if (this.#container(name))
        return message(409, `Conflict. The container name "/${name}" is already in use`);
      const image = String(body["Image"]);
      if (!this.images.has(image)) return message(404, `No such image: ${image}`);
      const host = (body["HostConfig"] ?? {}) as Record<string, unknown>;
      const network = String(host["NetworkMode"]);
      if (!this.networks.has(network)) return message(404, `network ${network} not found`);
      for (const mount of (host["Mounts"] ?? []) as { Source: string }[]) {
        if (!this.volumes.has(mount.Source)) {
          this.volumes.set(mount.Source, {
            Name: mount.Source,
            CreatedAt: new Date().toISOString(),
            Labels: {},
          });
        }
      }
      const id = `c${++this.#seq}`.padEnd(12, "0");
      this.containers.set(id, {
        Id: id,
        Name: name,
        Created: new Date().toISOString(),
        State: { Status: "created" },
        Config: {
          Image: image,
          Labels: (body["Labels"] ?? {}) as Record<string, string>,
          Env: (body["Env"] ?? []) as string[],
        },
        HostConfig: host,
      });
      return json(201, { Id: id, Warnings: [] });
    }
    if (containerMatch) {
      const m = containerMatch;
      const c = this.#container(m[1] as string);
      if (!c) return message(404, `No such container: ${m[1]}`);
      const action = m[2];
      if (method === "GET" && action === "/json") return json(200, c);
      if (method === "POST" && action === "/start") {
        if (c.State.Status === "running") return new Response(null, { status: 304 });
        c.State.Status = "running";
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && action === "/stop") {
        if (c.State.Status !== "running") return new Response(null, { status: 304 });
        c.State.Status = "exited";
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE" && action === undefined) {
        if (c.State.Status === "running" && query.get("force") !== "true") {
          return message(409, "cannot remove a running container");
        }
        this.containers.delete(c.Id);
        return new Response(null, { status: 204 });
      }
    }

    // Volumes.
    if (method === "GET" && path === "/volumes") {
      const wanted = labelFilters(query);
      return json(200, {
        Volumes: [...this.volumes.values()].filter((v) =>
          wanted.every(([k, val]) => v.Labels[k] === val),
        ),
        Warnings: null,
      });
    }
    if (method === "POST" && path === "/volumes/create") {
      const name = String(body["Name"]);
      let v = this.volumes.get(name);
      if (!v) {
        v = {
          Name: name,
          CreatedAt: new Date().toISOString(),
          Labels: (body["Labels"] ?? {}) as Record<string, string>,
        };
        this.volumes.set(name, v);
      }
      return json(201, v);
    }
    if (volumeMatch) {
      const m = volumeMatch;
      const v = this.volumes.get(m[1] as string);
      if (!v) return message(404, `get ${m[1]}: no such volume`);
      if (method === "GET") return json(200, v);
      if (method === "DELETE") {
        const used = [...this.containers.values()].some((c) =>
          ((c.HostConfig["Mounts"] ?? []) as { Source: string }[]).some((x) => x.Source === v.Name),
        );
        if (used) return message(409, "volume is in use");
        this.volumes.delete(v.Name);
        return new Response(null, { status: 204 });
      }
    }

    // Networks.
    if (method === "POST" && path === "/networks/create") {
      const name = String(body["Name"]);
      if ([...this.networks.values()].some((n) => n.Name === name)) {
        return message(409, `network with name ${name} already exists`);
      }
      const id = `n${++this.#seq}`.padEnd(12, "0");
      this.networks.set(name, {
        Id: id,
        Name: name,
        Labels: (body["Labels"] ?? {}) as Record<string, string>,
        Options: (body["Options"] ?? {}) as Record<string, string>,
        Internal: Boolean(body["Internal"]),
      });
      return json(201, { Id: id, Warning: "" });
    }
    if (networkMatch) {
      const m = networkMatch;
      const n = [...this.networks.values()].find((x) => x.Name === m[1] || x.Id === m[1]);
      if (!n) return message(404, `network ${m[1]} not found`);
      if (method === "GET") return json(200, n);
      if (method === "DELETE") {
        this.networks.delete(n.Name);
        return new Response(null, { status: 204 });
      }
    }
    return message(404, `fake docker: no route for ${method} ${path}`);
  }
}

function labelFilters(query: URLSearchParams): [string, string][] {
  const raw = query.get("filters");
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { label?: string[] };
  return (parsed.label ?? []).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  });
}
