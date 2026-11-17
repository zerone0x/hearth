/**
 * Model settings API (decision 0038), behind the login guard like every `/v1`
 * route. The handler hands the service the principal and an unread body; the
 * service authorizes first (#32).
 *
 * - `GET /v1/settings/model` -> `{source, provider, model, keyRef, keyFingerprint, updatedAt}`
 * - `PUT /v1/settings/model {provider, model, keyRef}` -> the same; 409 `settings.env-locked`
 *   while `HEARTH_MODEL` is set
 *
 * Access mode (decision 0045), the same way: the handler passes an unread
 * body, the service authorizes first. The request guard (Host, Origin, JSON
 * content type; decision 0010) and the login guard run before every one.
 *
 * - `GET /v1/settings/access-mode` -> `{mode, source, updatedAt}`
 * - `PUT /v1/settings/access-mode {mode: "yolo" | "ask"}` -> the same
 * - `GET /v1/sessions/:id/access-mode` -> `{sessionId, override, global, mode}`
 * - `PUT /v1/sessions/:id/access-mode {mode: "yolo" | "ask" | null}` -> the same
 */

import { HearthError } from "@hearth/core";
import type { Context, Hono } from "hono";
import type { HubEnv } from "../auth";
import { jsonBody } from "../request-body";
import type { AccessModes } from "./access-mode";
import type { ModelSettings } from "./service";

function statusOf(code: string): 400 | 403 | 404 | 409 | 500 | 503 {
  switch (code) {
    case "request.invalid":
    case "settings.unknown-model":
      return 400;
    case "authz.denied":
      return 403;
    case "secret.not-found":
    case "session.not-found":
      return 404;
    case "settings.env-locked":
      return 409;
    case "audit.write-failed":
      return 503;
    default:
      return 500;
  }
}

function failure(c: Context<HubEnv>, error: unknown): Response {
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
    statusOf(error.code),
  );
}

export function mountSettingsRoutes(app: Hono<HubEnv>, settings: ModelSettings): void {
  app.get("/v1/settings/model", async (c) => {
    try {
      return c.json({ ok: true, ...(await settings.get(c.get("principal"))) }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.put("/v1/settings/model", async (c) => {
    try {
      const view = await settings.put(c.get("principal"), jsonBody(c.req, "request.invalid"));
      return c.json({ ok: true, ...view }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
}

export function mountAccessModeRoutes(app: Hono<HubEnv>, modes: AccessModes): void {
  app.get("/v1/settings/access-mode", async (c) => {
    try {
      return c.json({ ok: true, ...(await modes.getGlobal(c.get("principal"))) }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.put("/v1/settings/access-mode", async (c) => {
    try {
      const view = await modes.putGlobal(c.get("principal"), jsonBody(c.req, "request.invalid"));
      return c.json({ ok: true, ...view }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/v1/sessions/:id/access-mode", async (c) => {
    try {
      const view = await modes.getSession(c.get("principal"), c.req.param("id"));
      return c.json({ ok: true, ...view }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.put("/v1/sessions/:id/access-mode", async (c) => {
    try {
      const view = await modes.putSession(
        c.get("principal"),
        c.req.param("id"),
        jsonBody(c.req, "request.invalid"),
      );
      return c.json({ ok: true, ...view }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
}
