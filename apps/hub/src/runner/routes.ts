/**
 * Runner API (#43): send a message, interrupt the turn, read events with a
 * cursor, set runner options. Mounted after the request guard (0010) and the
 * login guard (0014); every handler passes the signed-in principal to
 * `authorize` (through `SessionRunners`).
 */

import { HearthError } from "@hearth/core";
import type { Context, Hono } from "hono";
import type { HubEnv } from "../auth";
import type { SessionRunners } from "./runners";

/** Most bytes of one user message. */
export const MAX_MESSAGE_CHARS = 256 * 1024;
const DEFAULT_PAGE = 200;
const MAX_PAGE = 1000;

function statusFor(code: string): 400 | 403 | 404 | 409 | 500 {
  switch (code) {
    case "authz.denied":
      return 403;
    case "session.not-found":
      return 404;
    case "runner.busy":
    case "runner.failed":
    case "runner.configured":
      return 409;
    case "request.invalid":
    case "runner.unknown-model":
      return 400;
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
    statusFor(error.code),
  );
}

function invalid(message: string): HearthError {
  return new HearthError(message, {
    owner: "user",
    disposition: "give-up",
    code: "request.invalid",
  });
}

async function body(c: Context<HubEnv>): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw invalid("the body is not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function nonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!/^\d{1,15}$/.test(raw)) throw invalid(`${name} must be a non-negative integer`);
  return Number(raw);
}

export function mountRunnerRoutes(app: Hono<HubEnv>, runners: SessionRunners): void {
  app.post("/v1/sessions/:id/messages", async (c) => {
    try {
      const input = await body(c);
      const keys = Object.keys(input);
      const text = input["text"];
      if (keys.length !== 1 || typeof text !== "string") {
        throw invalid('expected exactly {"text": string}');
      }
      if (text.length > MAX_MESSAGE_CHARS) throw invalid("the message is too long");
      await runners.send(c.get("principal"), c.req.param("id"), text);
      return c.json({ ok: true }, 202);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/v1/sessions/:id/interrupt", async (c) => {
    try {
      const interrupted = await runners.interrupt(c.get("principal"), c.req.param("id"));
      return c.json({ ok: true, interrupted }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/v1/sessions/:id/runner", async (c) => {
    try {
      const input = await body(c);
      for (const key of Object.keys(input)) {
        if (key !== "codemode") throw invalid(`unknown field ${JSON.stringify(key)}`);
      }
      if (input["codemode"] !== undefined && typeof input["codemode"] !== "boolean") {
        throw invalid("codemode must be a boolean");
      }
      const runner = await runners.configure(c.get("principal"), c.req.param("id"), {
        codemode: input["codemode"] === true,
      });
      return c.json({ ok: true, runner }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/v1/sessions/:id/runner", async (c) => {
    try {
      return c.json({
        ok: true,
        runner: await runners.view(c.get("principal"), c.req.param("id")),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  // Cursor resume (PRD §6.1): pass the last `cursor` back as `after`.
  app.get("/v1/sessions/:id/events", async (c) => {
    try {
      const after = nonNegativeInt(c.req.query("after"), 0, "after");
      const limit = Math.min(nonNegativeInt(c.req.query("limit"), DEFAULT_PAGE, "limit"), MAX_PAGE);
      if (limit === 0) throw invalid("limit must be at least 1");
      const page = await runners.events(c.get("principal"), c.req.param("id"), after, limit);
      return c.json({ ok: true, ...page }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
}
