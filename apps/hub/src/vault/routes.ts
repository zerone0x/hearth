/**
 * Vault API (decision 0031), behind the login guard like every `/v1` route.
 * Each handler hands its service the principal and an unread body; the
 * service calls `authorize` first (#32). No route returns a stored value:
 * answers carry metadata and keyed fingerprints only.
 *
 * - `GET /v1/vault/status` -> `{state, reason?, message?, kekCheck?}`
 * - `GET /v1/secrets` -> `{secrets: [...]}`
 * - `POST /v1/secrets {name, kind, scope?, policy?, meta?, fields}` -> 201 `{id, fingerprint, version}`
 * - `PUT /v1/secrets/:id/value {fields, use?}` -> `{fingerprint, version}` (rotate; `use` of a token, decision 0041)
 * - `DELETE /v1/secrets/:id` -> 204
 * - `GET /v1/secrets/:id/uses?before=<ms>` -> `{uses: [...]}` (from the audit table)
 */

import { HearthError } from "@hearth/core";
import type { Context, Hono } from "hono";
import type { HubEnv } from "../auth";
import { jsonBody } from "../request-body";
import type { HubVault } from "./service";

function statusOf(code: string): 400 | 403 | 404 | 409 | 500 | 503 {
  switch (code) {
    case "request.invalid":
      return 400;
    case "authz.denied":
      return 403;
    case "secret.not-found":
      return 404;
    case "secret.name-taken":
    case "secret.conflict":
    case "secret.system-managed":
    case "vault.disabled":
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

export function mountVaultRoutes(app: Hono<HubEnv>, vault: HubVault): void {
  app.get("/v1/vault/status", async (c) => {
    try {
      return c.json({ ok: true, ...(await vault.status(c.get("principal"))) }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/v1/secrets", async (c) => {
    try {
      return c.json({ ok: true, secrets: await vault.list(c.get("principal")) }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/v1/secrets", async (c) => {
    try {
      const created = await vault.create(c.get("principal"), jsonBody(c.req, "request.invalid"));
      return c.json({ ok: true, ...created }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.put("/v1/secrets/:id/value", async (c) => {
    try {
      const rotated = await vault.rotate(
        c.get("principal"),
        c.req.param("id"),
        jsonBody(c.req, "request.invalid"),
      );
      return c.json({ ok: true, ...rotated }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.delete("/v1/secrets/:id", async (c) => {
    try {
      await vault.remove(c.get("principal"), c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/v1/secrets/:id/uses", async (c) => {
    try {
      const uses = await vault.uses(c.get("principal"), c.req.param("id"), c.req.query("before"));
      return c.json({ ok: true, uses }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
}
