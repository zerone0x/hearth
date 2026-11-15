import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDefaultSecretStore } from "@hearth/core";
import { DockerBoxProvider, dockerBoxConfigFromEnv } from "./box/docker";
import { boxEgressFromEnv } from "./box/egress";
import { observabilityFromEnv } from "./obs/setup";
import type { RunnerConfig } from "./runner";
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

/**
 * The runner's model (decision 0015): `HEARTH_MODEL_PROVIDER`, `HEARTH_MODEL`
 * and `HEARTH_MODEL_KEY_REF`, a SecretStore reference such as
 * `env:ANTHROPIC_API_KEY`. Without `HEARTH_MODEL` the runner is off.
 */
export function runnerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): RunnerConfig | undefined {
  const model = env["HEARTH_MODEL"];
  if (model === undefined || model === "") return undefined;
  const provider = env["HEARTH_MODEL_PROVIDER"];
  if (provider === undefined || provider === "") {
    throw new Error("HEARTH_MODEL_PROVIDER must be set when HEARTH_MODEL is");
  }
  const keyRef = env["HEARTH_MODEL_KEY_REF"];
  return { provider, model, ...(keyRef ? { apiKeyRef: keyRef } : {}) };
}

/** Where `bun run --filter @hearth/web build` puts the UI, relative to this file. */
const DEFAULT_WEB_DIR = join(import.meta.dir, "../../web/dist");

/**
 * The built web UI (decision 0017): `HEARTH_WEB_DIR`, else `apps/web/dist`
 * when it was built. A configured directory that does not exist is an error;
 * an unbuilt default just means no UI.
 */
export function webRootFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fallback: string = DEFAULT_WEB_DIR,
): string | undefined {
  const raw = env["HEARTH_WEB_DIR"];
  if (raw !== undefined && raw !== "") {
    if (!existsSync(join(raw, "index.html"))) {
      throw new Error(`HEARTH_WEB_DIR has no index.html: "${raw}"`);
    }
    return raw;
  }
  return existsSync(join(fallback, "index.html")) ? fallback : undefined;
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
  const runnerConfig = runnerConfigFromEnv(process.env);
  const webRoot = webRootFromEnv(process.env);
  // JSON logs and optional OTLP export (decision 0021, obs/setup.ts).
  const obs = observabilityFromEnv(process.env);
  const hub = startHub({
    ...(runnerConfig === undefined
      ? {}
      : {
          runner: {
            config: runnerConfig,
            secrets: createDefaultSecretStore(),
            telemetry: obs.telemetry,
          },
        }),
    hostname: process.env["HEARTH_HOST"] || DEFAULT_HOSTNAME,
    port: parsePort(process.env["HEARTH_PORT"]),
    // Box listeners bind each box network's gateway on this port (0012).
    boxPort: parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(provider === undefined ? {} : { provider }),
    boxEgress,
    dbPath: join(dataDir, "hearth.db"),
    ...(webRoot === undefined ? {} : { webRoot }),
    ...(process.env["HEARTH_BOX_IMAGE"] ? { boxImage: process.env["HEARTH_BOX_IMAGE"] } : {}),
    sessions: { idleMs: idleMsFromEnv(process.env) },
    log: obs.logger.lines(),
  });

  console.log(`hearth hub listening on ${hub.url} (box provider: ${provider?.name ?? "none"})`);
  console.log(webRoot === undefined ? "web UI: not built" : `web UI: ${webRoot}`);
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
      void hub
        .stop()
        .then(() => obs.telemetry.shutdown())
        .then(() => process.exit(0));
    });
  }
}
