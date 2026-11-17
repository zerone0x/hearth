/**
 * Spend and the session budget (decision 0047), behind the login guard like
 * every `/v1` route; the service authorizes first and reads the body after.
 *
 * - `GET /v1/sessions/:id/spend` -> `{gateway, bifrostState, budgetUsd, spend, active, flushSeconds}`
 * - `GET /v1/settings/session-budget` -> `{budgetUsd, source, updatedAt, bifrostState, total, flushSeconds}`
 * - `PUT /v1/settings/session-budget {budgetUsd}` -> the same
 */

import { HearthError } from "@hearth/core";
import type { Context, Hono } from "hono";
import type { HubEnv } from "../auth";
import { jsonBody } from "../request-body";
import type { SessionVirtualKeys } from "./virtual-keys";

function statusOf(code: string): 400 | 403 | 404 | 500 | 503 {
  switch (code) {
    case "request.invalid":
      return 400;
    case "authz.denied":
      return 403;
    case "session.not-found":
      return 404;
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

export function mountSpendRoutes(app: Hono<HubEnv>, keys: SessionVirtualKeys): void {
  app.get("/v1/sessions/:id/spend", async (c) => {
    try {
      return c.json(
        { ok: true, ...(await keys.spend(c.get("principal"), c.req.param("id"))) },
        200,
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/v1/settings/session-budget", async (c) => {
    try {
      return c.json({ ok: true, ...(await keys.getBudget(c.get("principal"))) }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.put("/v1/settings/session-budget", async (c) => {
    try {
      const view = await keys.putBudget(c.get("principal"), jsonBody(c.req, "request.invalid"));
      return c.json({ ok: true, ...view }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
}
