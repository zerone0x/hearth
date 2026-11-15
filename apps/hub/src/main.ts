import { DEFAULT_HOSTNAME, parsePort, startHub } from "./server";

// Process entry point. Only listening config is read here; secrets never come
// from env directly (they go through SecretStore, PRD §7 E7).
const server = startHub({
  hostname: process.env["HEARTH_HOST"] || DEFAULT_HOSTNAME,
  port: parsePort(process.env["HEARTH_PORT"]),
});

console.log(`hearth hub listening on ${server.url}`);
