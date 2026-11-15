/**
 * The web UI's static assets (#46, decision 0017): the built `apps/web/dist`,
 * served same-origin on the public listener so the request guard (0010) and
 * the login cookie (0014) work without CORS.
 *
 * Only `GET`/`HEAD` outside `/v1/` reach this handler without a login (the
 * session guard in `app.ts` lets them through when a web root is configured):
 * the assets hold no secrets and the login page itself is one of them. The
 * request guard still runs first, so a foreign `Host` gets 421 here too.
 */

import { realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Env, Hono } from "hono";

/**
 * Content-Security-Policy of the UI's HTML. Scripts, styles and connections
 * only from the hub's own origin (`connect-src 'self'` covers the same-origin
 * desktop WebSocket); no inline script or style element, no plugins, no
 * framing. `img-src` adds `data:`/`blob:` for noVNC's cursor.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Whether a request may be answered from the web root without a login. */
export function isWebAssetRequest(method: string, path: string): boolean {
  return (method === "GET" || method === "HEAD") && path !== "/v1" && !path.startsWith("/v1/");
}

/** Built asset names carry a content hash, so they can be cached for good. */
const IMMUTABLE_PREFIX = "/assets/";

/**
 * The file under `root` that `path` names, or undefined when there is none or
 * the path would leave `root` (`..`, encoded or not, and symlinks out).
 */
export function resolveAsset(root: string, path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relative.split("/").some((segment) => segment === "..")) return undefined;
  const candidate = join(root, relative);
  try {
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(root + sep)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Mounts the static handler for every `GET`/`HEAD` outside `/v1/`. */
export function mountWebAssets<E extends Env>(app: Hono<E>, webRoot: string): void {
  const root = realpathSync(resolve(webRoot));
  app.on(["GET", "HEAD"], "*", async (c, next) => {
    if (!isWebAssetRequest(c.req.method, c.req.path)) return next();
    const file = resolveAsset(root, c.req.path);
    const headers = new Headers({ "x-content-type-options": "nosniff" });
    if (file === undefined) {
      headers.set("content-type", "text/plain; charset=utf-8");
      return new Response("not found", { status: 404, headers });
    }
    const blob = Bun.file(file);
    headers.set("content-type", blob.type);
    if (extname(file) === ".html") {
      headers.set("content-security-policy", WEB_CSP);
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-frame-options", "DENY");
      headers.set("cache-control", "no-cache");
    } else if (c.req.path.startsWith(IMMUTABLE_PREFIX)) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    }
    return new Response(c.req.method === "HEAD" ? null : blob, { status: 200, headers });
  });
}
