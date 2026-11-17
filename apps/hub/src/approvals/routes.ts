/**
 * Approval API (#155, decision 0048), behind the request guard (Host,
 * Origin, JSON content type; decision 0010) and the login guard (0014) like
 * every `/v1` route. The handler passes the principal and an unread body;
 * the service authorizes first (#32).
 *
 * - `POST /v1/sessions/:id/approvals/:approvalId {decision: "approve" | "deny"}`
 *   -> `{approval}`; 404 `approval.not-found` for an unknown id or another
 *   session's, 409 `approval.closed` when it already ended otherwise, 503
 *   when the audit row cannot be written (nothing changed)
 * - `GET /v1/approvals` -> `{approvals}`: the pending ones, for the session list
 */

import { HearthError } from "@hearth/core";
import type { Context, Hono } from "hono";
import type { HubEnv } from "../auth";
import { jsonBody } from "../request-body";
import type { Approvals } from "./service";

function statusOf(code: string): 400 | 403 | 404 | 409 | 500 | 503 {
  switch (code) {
    case "request.invalid":
      return 400;
    case "authz.denied":
      return 403;
    case "approval.not-found":
      return 404;
    case "approval.closed":
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

export function mountApprovalRoutes(app: Hono<HubEnv>, approvals: Approvals): void {
  app.post("/v1/sessions/:id/approvals/:approvalId", async (c) => {
    try {
      const approval = await approvals.decide(
        c.get("principal"),
        c.req.param("id"),
        c.req.param("approvalId"),
        jsonBody(c.req, "request.invalid"),
      );
      return c.json({ ok: true, approval }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/v1/approvals", async (c) => {
    try {
      return c.json({ ok: true, approvals: await approvals.list(c.get("principal")) }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
}
