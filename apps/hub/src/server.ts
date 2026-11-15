import { createApp } from "./app";

export interface HubListenOptions {
  /** Interface to bind. Defaults to loopback: the hub is never public by default (PRD §10). */
  readonly hostname?: string;
  /** TCP port. 0 picks a free port (used by tests). */
  readonly port?: number;
}

export const DEFAULT_HOSTNAME = "127.0.0.1";
export const DEFAULT_PORT = 8787;

/** Starts the hub HTTP server. The caller owns the returned server and must `stop()` it. */
export function startHub(options: HubListenOptions = {}) {
  const app = createApp();
  return Bun.serve({
    hostname: options.hostname ?? DEFAULT_HOSTNAME,
    port: options.port ?? DEFAULT_PORT,
    fetch: app.fetch,
  });
}

/**
 * Parses a port from configuration. Rejects anything that is not an integer in
 * 0..65535 instead of silently falling back.
 */
export function parsePort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${raw}": expected an integer from 0 to 65535`);
  }
  return port;
}
