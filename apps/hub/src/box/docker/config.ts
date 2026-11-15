/**
 * Settings for the Docker BoxProvider (decision 0007). These are host settings,
 * not secrets: the socket path, default limits and deadlines.
 */

export interface DockerBoxLimits {
  /** CPU cores, may be fractional. Sent as `NanoCpus`. */
  readonly cpus: number;
  /** Memory limit; swap is set to the same value, so the box gets no swap. */
  readonly memoryBytes: number;
  /** Maximum number of processes and threads in the box. */
  readonly pids: number;
  /**
   * Size limit for the container's writable layer (`StorageOpt.size`). Only
   * some storage drivers support it (overlay2 on xfs with `pquota`), so it is
   * unset by default and applied only when configured or asked for.
   */
  readonly diskBytes?: number;
}

export interface DockerBoxProviderConfig {
  /** Path to the Docker daemon socket. */
  readonly socketPath: string;
  /** Engine API version the provider speaks. */
  readonly apiVersion: string;
  /**
   * Prefix for container, volume and network names, and the value of the
   * `dev.hearth.instance` label. `adopt` only lists boxes with this instance
   * label, so two hubs (or a test run) on one daemon never adopt each other's boxes.
   */
  readonly instance: string;
  readonly limits: DockerBoxLimits;
  /** `/dev/shm` size. Chromium needs more than Docker's 64 MB default. */
  readonly shmBytes: number;
  /** Default grace for `stop` before the box is killed. */
  readonly stopGraceMs: number;
  /** Deadline for one ordinary API call (inspect, create, remove). */
  readonly requestTimeoutMs: number;
  /** Deadline for pulling a missing image. */
  readonly pullTimeoutMs: number;
  /** `missing`: pull an image that is not present locally. `never`: fail instead. */
  readonly pullPolicy: "missing" | "never";
}

export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
/** Docker Engine 25.0 and later. */
export const DEFAULT_DOCKER_API_VERSION = "1.44";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

export const DEFAULT_DOCKER_BOX_CONFIG: DockerBoxProviderConfig = {
  socketPath: DEFAULT_DOCKER_SOCKET,
  apiVersion: DEFAULT_DOCKER_API_VERSION,
  instance: "hearth",
  limits: { cpus: 2, memoryBytes: 2 * GIB, pids: 1024 },
  shmBytes: 256 * MIB,
  stopGraceMs: 10_000,
  requestTimeoutMs: 30_000,
  pullTimeoutMs: 600_000,
  pullPolicy: "missing",
};

function positive(name: string, raw: string | undefined, integer: boolean): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}, got "${raw}"`);
  }
  return value;
}

/**
 * Read the provider settings from the environment, falling back to the
 * defaults. Variables: `HEARTH_DOCKER_SOCKET`, `HEARTH_DOCKER_API_VERSION`,
 * `HEARTH_BOX_INSTANCE`, `HEARTH_BOX_CPUS`, `HEARTH_BOX_MEMORY_BYTES`,
 * `HEARTH_BOX_PIDS`, `HEARTH_BOX_DISK_BYTES`, `HEARTH_BOX_PULL` (`missing` or `never`).
 */
export function dockerBoxConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): DockerBoxProviderConfig {
  const d = DEFAULT_DOCKER_BOX_CONFIG;
  const instance = env["HEARTH_BOX_INSTANCE"] || d.instance;
  if (!NAME_PART.test(instance)) {
    throw new Error(`HEARTH_BOX_INSTANCE must match ${NAME_PART}, got "${instance}"`);
  }
  const pull = env["HEARTH_BOX_PULL"] || d.pullPolicy;
  if (pull !== "missing" && pull !== "never") {
    throw new Error(`HEARTH_BOX_PULL must be "missing" or "never", got "${pull}"`);
  }
  const diskBytes = positive("HEARTH_BOX_DISK_BYTES", env["HEARTH_BOX_DISK_BYTES"], true);
  return {
    ...d,
    socketPath: env["HEARTH_DOCKER_SOCKET"] || d.socketPath,
    apiVersion: env["HEARTH_DOCKER_API_VERSION"] || d.apiVersion,
    instance,
    pullPolicy: pull,
    limits: {
      cpus: positive("HEARTH_BOX_CPUS", env["HEARTH_BOX_CPUS"], false) ?? d.limits.cpus,
      memoryBytes:
        positive("HEARTH_BOX_MEMORY_BYTES", env["HEARTH_BOX_MEMORY_BYTES"], true) ??
        d.limits.memoryBytes,
      pids: positive("HEARTH_BOX_PIDS", env["HEARTH_BOX_PIDS"], true) ?? d.limits.pids,
      ...(diskBytes === undefined ? {} : { diskBytes }),
    },
  };
}

/** Docker object names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; ids and the instance must fit. */
export const NAME_PART = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
