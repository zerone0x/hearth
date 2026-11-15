import { formatVersion, PROTOCOL_VERSION } from "@hearth/protocol";
import { Hono } from "hono";

/**
 * Builds the hub's HTTP app. Kept free of listening and process concerns so
 * tests can drive it with `app.request()`.
 */
export function createApp() {
  const app = new Hono();

  // Liveness probe. The one route that does not call `authorize`: it takes no
  // input and returns no workspace data (docs/DECISIONS.md, 0001).
  app.get("/healthz", (c) =>
    c.json({ status: "ok", protocol: formatVersion(PROTOCOL_VERSION) }, 200),
  );

  return app;
}
