import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DockerBoxProvider, dockerBoxConfigFromEnv } from "./box/docker";
import { boxEgressFromEnv } from "./box/egress";
import {
  type BoxNetworkProvider,
  DEFAULT_BOX_PORT,
  DEFAULT_HOSTNAME,
  parsePort,
  parsePublicOrigin,
  startHub,
} from "./server";
import { DEFAULT_IDLE_MS } from "./session";

/** Where the hub keeps its database when `HEARTH_DATA_DIR` is not set. */
const DEFAULT_DATA_DIR = "data";

/**
 * The box provider from `HEARTH_BOX_PROVIDER`: `docker` (the default, settings
 * from `dockerBoxConfigFromEnv`) or `none` (a hub that starts no boxes).
 */
export function boxProviderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): BoxNetworkProvider | undefined {
  const kind = env["HEARTH_BOX_PROVIDER"] || "docker";
  if (kind === "none") return undefined;
  if (kind !== "docker") {
    throw new Error(`HEARTH_BOX_PROVIDER must be "docker" or "none", got "${kind}"`);
  }
  return new DockerBoxProvider({ config: dockerBoxConfigFromEnv(env) });
}

/**
 * Minutes a session may sit idle before its box is stopped
 * (`HEARTH_IDLE_MINUTES`, PRD §6.3: default 15). Rejects anything that is not
 * a positive number instead of silently falling back.
 */
export function idleMsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env["HEARTH_IDLE_MINUTES"];
  if (raw === undefined || raw === "") return DEFAULT_IDLE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`HEARTH_IDLE_MINUTES must be a positive number, got "${raw}"`);
  }
  return Math.round(minutes * 60_000);
}

if (import.meta.main) {
  // Process entry point. Only listening config, the box provider's host
  // settings and the data directory are read here; secrets never come from env
  // directly (they go through SecretStore, PRD §7 E7).
  const dataDir = process.env["HEARTH_DATA_DIR"] || DEFAULT_DATA_DIR;
  // The origin of a reverse proxy in front of the hub (docs/DECISIONS.md, 0010).
  const publicOrigin = parsePublicOrigin(process.env["HEARTH_PUBLIC_ORIGIN"]);
  const provider = boxProviderFromEnv(process.env);
  // Box egress gate (0012): the firewall marker, or HEARTH_BOX_EGRESS=unrestricted.
  const boxEgress = boxEgressFromEnv(process.env);
  mkdirSync(dataDir, { recursive: true });
  const hub = startHub({
    hostname: process.env["HEARTH_HOST"] || DEFAULT_HOSTNAME,
    port: parsePort(process.env["HEARTH_PORT"]),
    // Box listeners bind each box network's gateway on this port (0012).
    boxPort: parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(provider === undefined ? {} : { provider }),
    boxEgress,
    dbPath: join(dataDir, "hearth.db"),
    ...(process.env["HEARTH_BOX_IMAGE"] ? { boxImage: process.env["HEARTH_BOX_IMAGE"] } : {}),
    sessions: { idleMs: idleMsFromEnv(process.env) },
    log: (line) => console.log(line),
  });

  console.log(`hearth hub listening on ${hub.url} (box provider: ${provider?.name ?? "none"})`);
  if (provider !== undefined) {
    // Boxes still running from before a restart get their listeners back. A
    // daemon that is down is not fatal: the hub serves the API and keeps
    // retrying in the background; one box that fails does not stop the rest.
    hub.listenForRunningBoxes().then(
      ({ listening }) => {
        if (listening.length > 0) {
          console.log(`listening again for running boxes: ${listening.join(", ")}`);
        }
      },
      (error: unknown) => console.error(`could not list running boxes: ${String(error)}`),
    );
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void hub.stop().then(() => process.exit(0));
    });
  }
}
