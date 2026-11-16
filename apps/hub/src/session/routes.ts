/**
 * Session API (#42): create, list, get and archive. Mounted by `server.ts` on
 * the app from `createApp`, after its request guard (decision 0010), so these
 * routes get the same Host/Origin/JSON checks, and after its session guard
 * (decision 0014), so every route has a signed-in principal. Every route calls
 * `authorize` through the manager first, with that principal (#61): it is also
 * the principal of the manager's audit rows.
 */

import { HearthError } from "@hearth/core";
import type { Context, Hono } from "hono";
import type { HubEnv } from "../auth";
import { jsonBody, RequestBody } from "../request-body";
import type { CreateSessionInput, SessionManager } from "./manager";

function statusFor(error: HearthError): 400 | 403 | 404 | 409 | 500 {
  switch (error.code) {
    case "authz.denied":
      return 403;
    case "session.not-found":
      return 404;
    case "session.illegal-transition":
    case "session.unavailable":
      return 409;
    case "request.invalid":
      return 400;
    default:
      return 500;
  }
}

function failure(c: Context, error: unknown): Response {
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

function invalid(message: string): HearthError {
  return new HearthError(message, {
    owner: "user",
    disposition: "give-up",
    code: "request.invalid",
  });
}

/** Validates the body of `POST /v1/sessions`: optional strings only. */
export function parseCreateSession(body: unknown): CreateSessionInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("expected a JSON object");
  }
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "title" && key !== "model" && key !== "repoUrl") {
      throw invalid(`unknown field ${JSON.stringify(key)}`);
    }
    if (typeof value !== "string" || value.length > 2048) {
      throw invalid(`${key} must be a string of at most 2048 characters`);
    }
    input[key] = value;
  }
  return input;
}

export function mountSessionRoutes(app: Hono<HubEnv>, sessions: SessionManager): void {
  app.post("/v1/sessions", async (c) => {
    try {
      // Read and checked after `authorize` (#32).
      const json = jsonBody(c.req, "request.invalid");
      const body = new RequestBody(async () => parseCreateSession(await json.read()));
      const session = await sessions.create(c.get("principal"), body);
      return c.json({ ok: true, session }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/v1/sessions", async (c) => {
    try {
      return c.json({ ok: true, sessions: await sessions.list(c.get("principal")) }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/v1/sessions/:id", async (c) => {
    try {
      return c.json(
        { ok: true, session: await sessions.get(c.get("principal"), c.req.param("id")) },
        200,
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/v1/sessions/:id/archive", async (c) => {
    try {
      const session = await sessions.archive(c.get("principal"), c.req.param("id"));
      return c.json({ ok: true, session }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
}
