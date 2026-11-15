import { HearthError, type JsonValue, LOCAL_PRINCIPAL } from "@hearth/core";
import { formatVersion, PROTOCOL_VERSION } from "@hearth/protocol";
import { Hono } from "hono";
import type { BoxConnections } from "./box/connections";

export interface AppDeps {
  readonly boxes: BoxConnections;
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
export function createApp(deps?: AppDeps) {
  const app = new Hono();

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
