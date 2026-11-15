import { HearthError, type JsonValue, LOCAL_PRINCIPAL } from "@hearth/core";
import { formatVersion, PROTOCOL_VERSION } from "@hearth/protocol";
import { Hono } from "hono";
import type { BoxConnections } from "./box/connections";

export interface AppDeps {
  readonly boxes: BoxConnections;
}

/** Host names that always reach a loopback hub (docs/DECISIONS.md, 0010). */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export interface AppOptions {
  /**
   * Host names (without port) the API answers to. Defaults to `LOOPBACK_HOSTS`;
   * `startHub` adds the bound address. A request whose `Host` is not listed
   * gets 421, which keeps DNS-rebinding pages out.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * The one origin allowed besides the request's own: the public URL behind
   * the owner's reverse proxy (`HEARTH_PUBLIC_ORIGIN`), as returned by
   * `parsePublicOrigin`. Its host name is allowed too.
   */
  readonly publicOrigin?: string;
}

/** Methods that carry a request body; their API calls must be JSON. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** `Sec-Fetch-Site` values sent for a request made by another site's page. */
const FOREIGN_FETCH_SITES = new Set(["cross-site", "same-site"]);

/** A `Host` header: a DNS name, IPv4 or bracketed IPv6 literal, and an optional port. */
const HOST_SYNTAX = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

/** A host name as a `Host` header carries it: lowercased, IPv6 in brackets. */
export function hostKey(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.includes(":") && !lower.startsWith("[") ? `[${lower}]` : lower;
}

/** The host name of a `Host` header without its port, or undefined if it is malformed. */
function hostnameOf(host: string): string | undefined {
  const lower = host.toLowerCase();
  if (!HOST_SYNTAX.test(lower)) return undefined;
  return lower.startsWith("[") ? lower.slice(0, lower.indexOf("]") + 1) : lower.split(":")[0];
}

function refuse(status: 403 | 415 | 421, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, owner: "user", message } }, { status });
}

/** HTTP status for a classified failure of an API call. */
function statusFor(error: HearthError): 403 | 409 | 500 | 502 | 504 {
  switch (error.code) {
    case "authz.denied":
      return 403;
    case "box.not-connected":
    case "box.disconnected":
      return 409;
    case "rpc.deadline":
      return 504;
    case "rpc.error":
      return 502;
    default:
      return 500;
  }
}

/**
 * Builds the hub's HTTP app. Kept free of listening and process concerns so
 * tests can drive it with `app.request()`.
 */
export function createApp(deps?: AppDeps, options: AppOptions = {}) {
  const app = new Hono();
  const publicOrigin = options.publicOrigin;
  const allowedHosts = new Set((options.allowedHosts ?? LOOPBACK_HOSTS).map(hostKey));
  if (publicOrigin !== undefined) allowedHosts.add(hostKey(new URL(publicOrigin).hostname));

  // Request guard (docs/DECISIONS.md, 0010). Loopback does not keep browsers
  // out: any page the owner opens can send a "simple" cross-origin POST, and a
  // DNS-rebinding page can read the answers. Every route except /healthz
  // checks Host, then Origin / Sec-Fetch-Site, then the JSON content type.
  // The box socket never reaches this app (server.ts routes it first).
  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz") return next();

    const url = new URL(c.req.url);
    const host = c.req.header("host") ?? url.host;
    const hostname = hostnameOf(host);
    if (hostname === undefined || !allowedHosts.has(hostname)) {
      return refuse(421, "request.foreign-host", `Host ${JSON.stringify(host)} is not served here`);
    }

    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const ownOrigin = `${url.protocol}//${host.toLowerCase()}`;
      if (origin !== ownOrigin && origin !== publicOrigin) {
        return refuse(
          403,
          "request.cross-origin",
          `Origin ${JSON.stringify(origin)} is not allowed`,
        );
      }
    } else if (FOREIGN_FETCH_SITES.has(c.req.header("sec-fetch-site")?.toLowerCase() ?? "")) {
      return refuse(403, "request.cross-origin", "cross-site requests are not allowed");
    }

    if (BODY_METHODS.has(c.req.method)) {
      const mediaType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return refuse(
          415,
          "request.unsupported-media-type",
          "expected Content-Type: application/json",
        );
      }
    }
    return next();
  });

  // Liveness probe. The one route that does not call `authorize`: it takes no
  // input and returns no workspace data (docs/DECISIONS.md, 0001).
  app.get("/healthz", (c) =>
    c.json({ status: "ok", protocol: formatVersion(PROTOCOL_VERSION) }, 200),
  );

  if (deps !== undefined) {
    // Internal endpoint for the M0 echo round trip (docs/DECISIONS.md, 0008).
    // There is no login before M1, so the caller is the local principal; the
    // hub listens on loopback only. `echo` calls `authorize` before anything else.
    app.post("/v1/boxes/:boxId/echo", async (c) => {
      let params: JsonValue;
      try {
        params = (await c.req.json()) as JsonValue;
      } catch {
        return c.json({ ok: false, error: { code: "request.invalid-json" } }, 400);
      }
      try {
        const result = await deps.boxes.echo(LOCAL_PRINCIPAL, c.req.param("boxId"), params);
        return c.json({ ok: true, result }, 200);
      } catch (error) {
        if (!(error instanceof HearthError)) throw error;
        return c.json(
          {
            ok: false,
            error: {
              code: error.code,
              owner: error.owner,
              disposition: error.disposition,
              message: error.message,
            },
          },
          statusFor(error),
        );
      }
    });
  }

  return app;
}
