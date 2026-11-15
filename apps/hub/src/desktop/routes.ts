/**
 * `GET /v1/sessions/:id/desktop`: the browser's WebSocket to a session's
 * desktop (decision 0016). Mounted on the app, so the request guard (0010:
 * Host, Origin) and the session guard (0014: login) run on the upgrade
 * request before this handler. The handler authorizes the signed-in
 * principal, starts the box, and only then accepts the upgrade.
 */

import { HearthError, type Principal } from "@hearth/core";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { type AuthService, type HubEnv, SESSION_COOKIE } from "../auth";
import type { DesktopBridge, Viewer, ViewerTicket } from "./bridge";

export const DESKTOP_PATH = "/v1/sessions/:id/desktop";

/** Per-socket data of a desktop WebSocket on the public listener. */
export interface DesktopSocketData {
  readonly ticket: ViewerTicket;
  viewer?: Viewer;
}

/** The part of `Bun.Server` the route needs to accept an upgrade. */
export interface Upgrader {
  upgrade(req: Request, options: { data: DesktopSocketData }): boolean;
}

function statusFor(error: HearthError): 403 | 404 | 409 | 503 | 500 {
  switch (error.code) {
    case "authz.denied":
      return 403;
    case "session.not-found":
      return 404;
    case "session.unavailable":
      return 409;
    case "box.no-provider":
    case "box.connect-deadline":
    case "box.egress-unfiltered":
    case "desktop.unavailable":
      return 503;
    default:
      return 500;
  }
}

function fail(
  c: Context<HubEnv>,
  status: 403 | 404 | 409 | 426 | 500 | 503,
  code: string,
  message: string,
) {
  return c.json({ ok: false, error: { code, owner: "user", message } }, status);
}

/**
 * Mounts the desktop route. `upgrader` returns the Bun server of the current
 * request (`app.fetch(req, server)` passes it as the env).
 */
export function mountDesktopRoute(
  app: Hono<HubEnv>,
  bridge: DesktopBridge,
  auth: AuthService,
  upgrader: (c: Context<HubEnv>) => Upgrader | undefined,
): void {
  app.get(DESKTOP_PATH, async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return fail(c, 426, "request.upgrade-required", "expected a WebSocket upgrade");
    }
    const principal: Principal = c.get("principal");
    const cookie = getCookie(c, SESSION_COOKIE);
    let ticket: ViewerTicket;
    try {
      ticket = await bridge.prepare(principal, c.req.param("id"), () => auth.authenticate(cookie));
    } catch (error) {
      if (!(error instanceof HearthError)) throw error;
      return fail(c, statusFor(error), error.code, error.message);
    }
    const server = upgrader(c);
    if (server === undefined || !server.upgrade(c.req.raw, { data: { ticket } })) {
      return fail(c, 426, "request.upgrade-required", "the WebSocket upgrade failed");
    }
    // Bun answers the upgrade itself; this response is not sent.
    return new Response(null, { status: 101 });
  });
}
