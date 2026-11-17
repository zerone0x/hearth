import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createDefaultSecretStore, type SecretStore } from "@hearth/core";
import { DockerBoxProvider, dockerBoxConfigFromEnv } from "./box/docker";
import { boxEgressFromEnv } from "./box/egress";
import { hubLines } from "./obs/hub-log";
import { registerKnownSecrets } from "./obs/redaction";
import { observabilityFromEnv } from "./obs/setup";
import { HUB_VERSION } from "./obs/version";
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
 * `env:ANTHROPIC_API_KEY` or `file:/run/secrets/model_key`. Without
 * `HEARTH_MODEL` the runner is off. `HEARTH_MODELS_FILE` (decision 0020) is a
 * pi `models.json` for providers pi does not ship, such as an
 * OpenAI-compatible endpoint; it must be an absolute path to an existing regular file (not a directory).
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
  return {
    provider,
    model,
    ...(keyRef ? { apiKeyRef: keyRef } : {}),
    ...modelsFileFromEnv(env),
  };
}

/**
 * `HEARTH_MODELS_FILE` (decision 0020), also without `HEARTH_MODEL`: a model
 * chosen on the Settings page (decision 0038) can come from it.
 */
export function modelsFileFromEnv(env: Readonly<Record<string, string | undefined>>): {
  modelsFile?: string;
} {
  const modelsFile = env["HEARTH_MODELS_FILE"];
  if (modelsFile === undefined || modelsFile === "") return {};
  if (!isAbsolute(modelsFile) || !statSync(modelsFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`HEARTH_MODELS_FILE must be an absolute path to a file, got "${modelsFile}"`);
  }
  return { modelsFile };
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

/**
 * Register the secrets the hub resolves for its own use (the model key) with
 * the sink-side redactor, before the first turn: the API, the logs and spans
 * redact the key from the start, also in events an older build stored raw
 * (decision 0021). A reference that does not resolve is a warning.
 */
export async function registerStartupSecrets(
  secrets: SecretStore,
  runnerConfig: Pick<RunnerConfig, "apiKeyRef"> | undefined,
  log: { warn(message: string): void },
): Promise<void> {
  // A `vault:` key is registered by the vault itself when it opens (decision 0031).
  if (runnerConfig?.apiKeyRef !== undefined && !runnerConfig.apiKeyRef.startsWith("vault:")) {
    await registerKnownSecrets(secrets, [runnerConfig.apiKeyRef], (m) => log.warn(m));
  }
}

/**
 * The vault's key references (decision 0031): `HEARTH_VAULT_KEY_REF`, the key
 * file written by `install:vault-key`, and `HEARTH_VAULT_KEY_NEXT_REF`, the
 * key to rotate to. Both are SecretStore references (`file:` or `env:`).
 */
export function vaultConfigFromEnv(env: Readonly<Record<string, string | undefined>>): {
  keyRef?: string;
  nextKeyRef?: string;
} {
  const keyRef = env["HEARTH_VAULT_KEY_REF"];
  const nextKeyRef = env["HEARTH_VAULT_KEY_NEXT_REF"];
  return {
    ...(keyRef ? { keyRef } : {}),
    ...(nextKeyRef ? { nextKeyRef } : {}),
  };
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
  const log = obs.logger.child({}, "hub");
  const secrets = createDefaultSecretStore();
  await registerStartupSecrets(secrets, runnerConfig, log);
  const hub = startHub({
    // Always a runner: without HEARTH_MODEL the Settings page picks the model
    // (decision 0038), and a message before that fails with `runner.no-model`.
    runner: {
      config: runnerConfig ?? modelsFileFromEnv(process.env),
      telemetry: obs.telemetry,
    },
    // The vault's key is read through the env:/file: store (decision 0031).
    vault: { ...vaultConfigFromEnv(process.env), keySecrets: secrets },
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
    // Level, component and ids from each line (obs/hub-log.ts).
    log: hubLines(obs.logger),
  });

  log.info(`hearth hub listening on ${hub.url} (box provider: ${provider?.name ?? "none"})`, {
    hub_version: HUB_VERSION,
  });
  log.info(webRoot === undefined ? "web UI: not built" : `web UI: ${webRoot}`);
  // The vault logs its own state ("vault: enabled" or "vault: disabled (reason)").
  void hub.vaultReady;
  if (provider !== undefined) {
    // Boxes still running from before a restart get their listeners back. A
    // daemon that is down is not fatal: the hub serves the API and keeps
    // retrying in the background; one box that fails does not stop the rest.
    hub.listenForRunningBoxes().then(
      ({ listening }) => {
        if (listening.length > 0) {
          log.info(`listening again for running boxes: ${listening.join(", ")}`, {
            component: "box",
          });
        }
      },
      (error: unknown) => log.error("could not list running boxes", { component: "box" }, error),
    );
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // A collector that is down or hangs does not keep the hub from exiting.
      void hub
        .stop()
        .catch((error: unknown) => log.error("hub stop failed", {}, error))
        .then(() => obs.telemetry.shutdown())
        .then((r) => {
          if (!r.ok) log.warn("telemetry export did not finish", { error: r.error ?? "" });
        })
        .finally(() => process.exit(0));
    });
  }
}
