/**
 * DockerBoxProvider: the personal-edition E4 BoxProvider (PRD §6.2, §6.3, §7, §10;
 * decision 0007). It talks to the Docker Engine API over the daemon's unix socket.
 *
 * Per box it owns, all named `<instance>-box-<boxId>` and labeled `dev.hearth.*`:
 *
 * - a bridge network of its own (egress allowed, nothing published, no
 *   inter-container traffic, IPv4 only), so boxes cannot reach each other. Its
 *   Linux bridge is named `hbx…` (`bridgeName`), which is what the host
 *   firewall of decision 0012 matches to keep boxes off the host and the LAN;
 * - two named volumes, one for `/workspace` and one (`…-home`) for `/home/hearth`;
 * - while running, one container built fresh by every `start`.
 */

import {
  type BoxBootConfig,
  type BoxId,
  type BoxInfo,
  type BoxProvider,
  type BoxSpec,
  type BoxState,
  type DestroyOutcome,
  type FailureDisposition,
  type FailureOwner,
  HearthError,
  type SnapshotOutcome,
  type StopOutcome,
} from "@hearth/core";
import { DEFAULT_DOCKER_BOX_CONFIG, type DockerBoxProviderConfig, NAME_PART } from "./config";
import { DockerApiError, DockerEngine } from "./engine";

/**
 * The provider's label namespace. User labels from `BoxSpec.labels` under it are
 * dropped (not rejected: `BoxInfo.labels` carries these, and a caller passing them
 * back must not fail), so they can neither override `LABEL` nor add look-alikes
 * (decision 0007).
 */
export const RESERVED_LABEL_PREFIX = "dev.hearth.";

/** The uid:gid every box runs as, whatever the image says (decision 0007). */
export const BOX_USER = "1000:1000";

/** Labels the provider sets, all under `RESERVED_LABEL_PREFIX`. */
export const LABEL = {
  managed: "dev.hearth.managed",
  instance: "dev.hearth.instance",
  boxId: "dev.hearth.box.id",
  workspaceId: "dev.hearth.workspace.id",
  sessionId: "dev.hearth.session.id",
  image: "dev.hearth.image",
  piVersion: "dev.hearth.pi.version",
  createdAt: "dev.hearth.created-at",
  volumeRole: "dev.hearth.volume.role",
} as const;

/** Where the two volumes are mounted in the box (the image's workdir and the user's home). */
export const WORKSPACE_MOUNT = "/workspace";
export const HOME_MOUNT = "/home/hearth";

/**
 * Environment the provider sets on every boot. The caller's `boot.env` cannot
 * override it. `HEARTH_CHROMIUM_SANDBOX=off` tells box-agent to launch Chromium
 * with `--no-sandbox`: the container is the sandbox (decision 0007).
 */
export const PROVIDER_ENV_KEYS = [
  "HEARTH_BOX_ID",
  "HEARTH_WORKSPACE_ID",
  "HEARTH_SESSION_ID",
  "HEARTH_CHROMIUM_SANDBOX",
] as const;

/**
 * Prefix of every box network's Linux bridge. `scripts/box-firewall.sh` matches
 * `hbx+` (decision 0012), so the rules cover boxes created after they were
 * installed without any per-box change.
 */
export const BOX_BRIDGE_PREFIX = "hbx";

/**
 * The Linux bridge name of a box network: the prefix and 12 hex digits of the
 * network name's SHA-256, 15 characters, the kernel's limit for an interface name.
 */
export function bridgeName(networkName: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(networkName).digest("hex");
  return `${BOX_BRIDGE_PREFIX}${hash.slice(0, 12)}`;
}

/**
 * Kernel settings for every box: no IPv6 at all, so IPv6 ULA and link-local
 * addresses are out of reach without IPv6 firewall rules (decision 0012).
 */
export const BOX_SYSCTLS: Readonly<Record<string, string>> = {
  "net.ipv6.conf.all.disable_ipv6": "1",
  "net.ipv6.conf.default.disable_ipv6": "1",
};

const IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DockerBoxProviderOptions {
  /** Settings; omitted fields use `DEFAULT_DOCKER_BOX_CONFIG`. */
  readonly config?: Partial<DockerBoxProviderConfig>;
  /** Clock for `createdAt`; tests inject one. */
  readonly now?: () => number;
}

interface ContainerJson {
  readonly Id: string;
  readonly Created?: string;
  readonly State?: { readonly Status?: string };
  readonly Config?: { readonly Image?: string; readonly Labels?: Record<string, string> | null };
}

interface VolumeJson {
  readonly Name: string;
  readonly CreatedAt?: string;
  readonly Labels?: Record<string, string> | null;
}

interface NetworkJson {
  readonly Id: string;
  readonly Labels?: Record<string, string> | null;
  readonly IPAM?: { readonly Config?: readonly { readonly Gateway?: string }[] | null };
}

function fail(
  message: string,
  owner: FailureOwner,
  disposition: FailureDisposition,
  code: string,
  cause?: unknown,
): HearthError {
  return new HearthError(message, {
    owner,
    disposition,
    code,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Classify a failure outside the box-specific paths: an unexpected answer from
 * the daemon while it manages its own objects is the hub's backend failing.
 */
function asHubFailure(error: unknown): HearthError {
  if (error instanceof HearthError) return error;
  if (error instanceof DockerApiError) {
    const retry = error.status >= 500;
    return fail(error.message, "hub", retry ? "retry" : "give-up", "docker.api-error", error);
  }
  return fail(`docker: ${String(error)}`, "hub", "give-up", "docker.unexpected", error);
}

function mapState(status: string | undefined): BoxState {
  switch (status) {
    case "running":
    case "paused":
    case "restarting":
      return "running";
    case "exited":
    case "dead":
      return "exited";
    default:
      // `created` (a start interrupted before the container ran) and
      // `removing` have no runtime that runs; `start` replaces them.
      return "stopped";
  }
}

export class DockerBoxProvider implements BoxProvider {
  readonly name = "docker";
  readonly config: DockerBoxProviderConfig;
  readonly #engine: DockerEngine;
  readonly #now: () => number;
  /** One operation at a time per box, so concurrent calls stay idempotent. */
  readonly #locks = new Map<BoxId, Promise<unknown>>();

  constructor(options: DockerBoxProviderOptions = {}) {
    this.config = { ...DEFAULT_DOCKER_BOX_CONFIG, ...options.config };
    if (!NAME_PART.test(this.config.instance)) {
      throw new Error(`instance must match ${NAME_PART}, got "${this.config.instance}"`);
    }
    this.#engine = new DockerEngine({
      socketPath: this.config.socketPath,
      apiVersion: this.config.apiVersion,
    });
    this.#now = options.now ?? Date.now;
  }

  /** Container and network name, and the workspace volume name. */
  objectName(boxId: BoxId): string {
    return `${this.config.instance}-box-${boxId}`;
  }

  homeVolumeName(boxId: BoxId): string {
    return `${this.objectName(boxId)}-home`;
  }

  /**
   * The gateway of the box's network: the host's address on it, where the hub
   * binds the box's listener (decision 0012). IPv4 only, like the network.
   */
  async hubAddress(boxId: BoxId): Promise<string> {
    this.#validateId(boxId);
    const name = this.objectName(boxId);
    const network = await this.#get<NetworkJson>(`/networks/${name}`, "network.inspect");
    if (network === undefined) {
      throw fail(`network ${name} does not exist`, "box", "retry-cold", "box.network-missing");
    }
    this.#checkOwned(boxId, network.Labels, `network ${name}`);
    const gateway = network.IPAM?.Config?.find(
      (c) => typeof c.Gateway === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(c.Gateway),
    )?.Gateway;
    if (gateway === undefined) {
      throw fail(`network ${name} has no IPv4 gateway`, "hub", "give-up", "box.network-invalid");
    }
    return gateway;
  }

  async create(spec: BoxSpec): Promise<BoxInfo> {
    this.#validateSpec(spec);
    return this.#locked(spec.boxId, () => this.#create(spec));
  }

  async start(spec: BoxSpec, boot: BoxBootConfig): Promise<BoxInfo> {
    this.#validateSpec(spec);
    const env = this.#bootEnv(spec, boot);
    return this.#locked(spec.boxId, () => this.#start(spec, env));
  }

  async stop(boxId: BoxId, options?: { readonly graceMs?: number }): Promise<StopOutcome> {
    this.#validateId(boxId);
    const graceMs = options?.graceMs ?? this.config.stopGraceMs;
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw fail(`graceMs must be >= 0, got ${graceMs}`, "hub", "give-up", "box.invalid-spec");
    }
    return this.#locked(boxId, () => this.#stop(boxId, graceMs));
  }

  async destroy(boxId: BoxId): Promise<DestroyOutcome> {
    this.#validateId(boxId);
    return this.#locked(boxId, () => this.#destroy(boxId));
  }

  /** Process snapshots (CRIU) are P2 (PRD §6.3); v1 says so explicitly. */
  async snapshot(boxId: BoxId): Promise<SnapshotOutcome> {
    this.#validateId(boxId);
    return { kind: "not-supported" };
  }

  async attach(boxId: BoxId): Promise<BoxInfo | undefined> {
    this.#validateId(boxId);
    return this.#locked(boxId, () => this.#info(boxId));
  }

  async adopt(): Promise<readonly BoxInfo[]> {
    const filters = JSON.stringify({
      label: [`${LABEL.managed}=true`, `${LABEL.instance}=${this.config.instance}`],
    });
    const ids = new Set<BoxId>();
    try {
      const containers = await this.#engine.request({
        method: "GET",
        path: "/containers/json",
        query: { all: true, filters },
        ok: [200],
        timeoutMs: this.config.requestTimeoutMs,
        endpoint: "container.list",
      });
      for (const c of (containers.body ?? []) as { Labels?: Record<string, string> | null }[]) {
        const id = c.Labels?.[LABEL.boxId];
        if (id !== undefined && NAME_PART.test(id)) ids.add(id);
      }
      const volumes = await this.#engine.request({
        method: "GET",
        path: "/volumes",
        query: { filters },
        ok: [200],
        timeoutMs: this.config.requestTimeoutMs,
        endpoint: "volume.list",
      });
      const list = ((volumes.body as { Volumes?: VolumeJson[] | null } | undefined)?.Volumes ??
        []) as VolumeJson[];
      for (const v of list) {
        const id = v.Labels?.[LABEL.boxId];
        if (id !== undefined && NAME_PART.test(id)) ids.add(id);
      }
    } catch (error) {
      throw asHubFailure(error);
    }
    const boxes: BoxInfo[] = [];
    for (const id of [...ids].sort()) {
      const info = await this.attach(id);
      if (info !== undefined) boxes.push(info);
    }
    return boxes;
  }

  // --- verbs, called under the box's lock ---

  async #create(spec: BoxSpec): Promise<BoxInfo> {
    try {
      await this.#ensureNetwork(spec);
      const createdAt = String(this.#now());
      await this.#ensureVolume(spec, this.objectName(spec.boxId), "workspace", createdAt);
      await this.#ensureVolume(spec, this.homeVolumeName(spec.boxId), "home", createdAt);
    } catch (error) {
      throw asHubFailure(error);
    }
    const info = await this.#info(spec.boxId);
    if (info === undefined) {
      throw fail(
        `box ${spec.boxId} vanished right after it was created`,
        "hub",
        "retry",
        "box.vanished",
      );
    }
    return info;
  }

  async #start(spec: BoxSpec, env: readonly string[]): Promise<BoxInfo> {
    await this.#create(spec);
    const name = this.objectName(spec.boxId);
    const existing = await this.#inspectContainer(spec.boxId);
    if (existing !== undefined) {
      if (mapState(existing.State?.Status) === "running") {
        // Already running: left alone, `boot` is not applied (BoxProvider.start).
        return this.#mustInfo(spec.boxId);
      }
      // An exited or half-created runtime is disposable; start builds a fresh one.
      await this.#removeContainer(existing.Id);
    }

    const piVersion = await this.#ensureImage(spec.image);
    const body = this.#containerBody(spec, env, piVersion);
    let id: string | undefined;
    for (let attempt = 0; id === undefined; attempt++) {
      let res: Awaited<ReturnType<DockerEngine["request"]>>;
      try {
        res = await this.#engine.request({
          method: "POST",
          path: "/containers/create",
          query: { name },
          body,
          ok: [201, 404, 409],
          timeoutMs: this.config.requestTimeoutMs,
          endpoint: "container.create",
        });
      } catch (error) {
        if (error instanceof DockerApiError && error.status >= 500) {
          throw fail(error.message, "box", "retry-cold", "box.create-failed", error);
        }
        throw asHubFailure(error);
      }
      if (res.status === 404) throw await this.#createNotFound(spec, res.text);
      if (res.status === 409) {
        // A container with this name appeared (a leftover still being removed).
        if (attempt >= 1) {
          throw fail(
            `container ${name} keeps conflicting: ${res.text.slice(0, 200)}`,
            "hub",
            "retry",
            "box.name-conflict",
          );
        }
        const leftover = await this.#inspectContainer(spec.boxId);
        if (leftover !== undefined) await this.#removeContainer(leftover.Id);
        continue;
      }
      id = String((res.body as { Id?: unknown } | undefined)?.Id ?? name);
    }

    try {
      await this.#engine.request({
        method: "POST",
        path: `/containers/${id}/start`,
        ok: [204, 304],
        timeoutMs: this.config.requestTimeoutMs,
        endpoint: "container.start",
      });
    } catch (error) {
      // The runtime refused the box (OCI error, bad mount): drop the container
      // so the next start is a clean cold boot from the volume.
      await this.#removeContainer(id).catch(() => undefined);
      if (error instanceof DockerApiError) {
        throw fail(error.message, "box", "retry-cold", "box.start-failed", error);
      }
      throw asHubFailure(error);
    }
    return this.#mustInfo(spec.boxId);
  }

  /**
   * `containers/create` answers 404 for a missing image and for a missing network
   * alike; look at both to tell which. The image is `box`/`give-up`, as when it is
   * missing before the create. The network is the box's own, gone between
   * `#create` and here (removed by hand or by a prune): the box's runtime is
   * suspect but the hub is fine, so it is `box`/`retry-cold`; the next `start`
   * runs `#create`, which builds the network again.
   */
  async #createNotFound(spec: BoxSpec, text: string): Promise<HearthError> {
    if ((await this.#inspectImage(spec.image)) === undefined) {
      return fail(`image ${spec.image} is missing`, "box", "give-up", "box.image-missing", text);
    }
    const network = this.objectName(spec.boxId);
    if ((await this.#get<NetworkJson>(`/networks/${network}`, "network.inspect")) === undefined) {
      return fail(
        `network ${network} vanished before the container was created`,
        "box",
        "retry-cold",
        "box.network-missing",
        text,
      );
    }
    return fail(
      `creating the container failed: ${text.slice(0, 200)}`,
      "box",
      "retry-cold",
      "box.create-failed",
      text,
    );
  }

  async #stop(boxId: BoxId, graceMs: number): Promise<StopOutcome> {
    const container = await this.#inspectContainer(boxId);
    if (container === undefined) {
      const volume = await this.#inspectVolume(boxId);
      return volume === undefined ? "not-found" : "already-stopped";
    }
    if (mapState(container.State?.Status) === "running") {
      try {
        await this.#engine.request({
          method: "POST",
          path: `/containers/${container.Id}/stop`,
          query: { t: Math.ceil(graceMs / 1000) },
          ok: [204, 304, 404],
          // Named deadline: the grace the box gets, plus an ordinary call.
          timeoutMs: graceMs + this.config.requestTimeoutMs,
          endpoint: "container.stop",
        });
      } catch (error) {
        throw asHubFailure(error);
      }
    }
    await this.#removeContainer(container.Id);
    return "stopped";
  }

  async #destroy(boxId: BoxId): Promise<DestroyOutcome> {
    let found = false;
    const container = await this.#inspectContainer(boxId);
    if (container !== undefined) {
      await this.#removeContainer(container.Id);
      found = true;
    }
    for (const volume of [this.objectName(boxId), this.homeVolumeName(boxId)]) {
      const existing = await this.#get<VolumeJson>(`/volumes/${volume}`, "volume.inspect");
      if (existing === undefined) continue;
      this.#checkOwned(boxId, existing.Labels, `volume ${volume}`);
      found = true;
      await this.#remove(`/volumes/${volume}`, "volume.remove");
    }
    const network = await this.#get<NetworkJson>(
      `/networks/${this.objectName(boxId)}`,
      "network.inspect",
    );
    if (network !== undefined) {
      this.#checkOwned(boxId, network.Labels, `network ${this.objectName(boxId)}`);
      found = true;
      await this.#remove(`/networks/${network.Id}`, "network.remove");
    }
    return found ? "destroyed" : "not-found";
  }

  async #info(boxId: BoxId): Promise<BoxInfo | undefined> {
    const container = await this.#inspectContainer(boxId);
    const volume = await this.#inspectVolume(boxId);
    if (container === undefined && volume === undefined) return undefined;
    const containerLabels = container?.Config?.Labels ?? {};
    const volumeLabels = volume?.Labels ?? {};
    const labels = container !== undefined ? containerLabels : volumeLabels;
    const state = container === undefined ? "stopped" : mapState(container.State?.Status);
    const createdAt =
      Number(volumeLabels[LABEL.createdAt] ?? containerLabels[LABEL.createdAt]) ||
      Date.parse(volume?.CreatedAt ?? container?.Created ?? "") ||
      0;
    return {
      boxId,
      workspaceId: labels[LABEL.workspaceId] ?? volumeLabels[LABEL.workspaceId] ?? "",
      sessionId: labels[LABEL.sessionId] ?? volumeLabels[LABEL.sessionId] ?? "",
      state,
      image: containerLabels[LABEL.image] ?? volumeLabels[LABEL.image] ?? "",
      ...(container !== undefined && state !== "stopped" ? { providerRef: container.Id } : {}),
      volumeRef: this.objectName(boxId),
      labels: { ...labels },
      createdAt,
    };
  }

  async #mustInfo(boxId: BoxId): Promise<BoxInfo> {
    const info = await this.#info(boxId);
    if (info === undefined) {
      throw fail(`box ${boxId} vanished`, "hub", "retry", "box.vanished");
    }
    return info;
  }

  // --- Docker objects ---

  #labels(spec: BoxSpec, extra: Record<string, string>): Record<string, string> {
    const user = Object.entries(spec.labels ?? {}).filter(
      ([key]) => !key.startsWith(RESERVED_LABEL_PREFIX),
    );
    return {
      ...Object.fromEntries(user),
      [LABEL.managed]: "true",
      [LABEL.instance]: this.config.instance,
      [LABEL.boxId]: spec.boxId,
      [LABEL.workspaceId]: spec.workspaceId,
      [LABEL.sessionId]: spec.sessionId,
      [LABEL.image]: spec.image,
      ...extra,
    };
  }

  /**
   * The container: limits from the spec or the configured defaults, both volumes,
   * the box's own network, no published ports, no capabilities, and no way to
   * gain privileges. Docker's default seccomp profile stays on (decision 0007).
   */
  #containerBody(spec: BoxSpec, env: readonly string[], piVersion: string | undefined) {
    const limits = this.config.limits;
    const cpus = spec.resources?.cpus ?? limits.cpus;
    const memory = spec.resources?.memoryBytes ?? limits.memoryBytes;
    const pids = spec.resources?.pids ?? limits.pids;
    const disk = spec.resources?.diskBytes ?? limits.diskBytes;
    const network = this.objectName(spec.boxId);
    return {
      Image: spec.image,
      User: BOX_USER,
      Env: env,
      Labels: this.#labels(spec, piVersion === undefined ? {} : { [LABEL.piVersion]: piVersion }),
      ExposedPorts: {},
      HostConfig: {
        NetworkMode: network,
        Mounts: [
          { Type: "volume", Source: this.objectName(spec.boxId), Target: WORKSPACE_MOUNT },
          { Type: "volume", Source: this.homeVolumeName(spec.boxId), Target: HOME_MOUNT },
        ],
        NanoCpus: Math.round(cpus * 1e9),
        Memory: memory,
        MemorySwap: memory,
        PidsLimit: pids,
        ShmSize: this.config.shmBytes,
        Sysctls: { ...BOX_SYSCTLS },
        ...(disk === undefined ? {} : { StorageOpt: { size: String(disk) } }),
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        PublishAllPorts: false,
        PortBindings: {},
        RestartPolicy: { Name: "no" },
      },
      NetworkingConfig: { EndpointsConfig: { [network]: {} } },
    };
  }

  async #ensureNetwork(spec: BoxSpec): Promise<void> {
    const name = this.objectName(spec.boxId);
    const existing = await this.#get<NetworkJson>(`/networks/${name}`, "network.inspect");
    if (existing !== undefined) {
      this.#checkOwned(spec.boxId, existing.Labels, `network ${name}`);
      return;
    }
    const res = await this.#engine.request({
      method: "POST",
      path: "/networks/create",
      body: {
        Name: name,
        Driver: "bridge",
        Internal: false,
        Attachable: false,
        EnableIPv6: false,
        Labels: this.#labels(spec, {}),
        Options: {
          "com.docker.network.bridge.enable_icc": "false",
          "com.docker.network.bridge.name": bridgeName(name),
        },
      },
      // 409: a same-named network appeared since the inspect.
      ok: [201, 409],
      timeoutMs: this.config.requestTimeoutMs,
      endpoint: "network.create",
    });
    if (res.status === 409) {
      // Someone else may have made it: check it is ours before anything uses it.
      const raced = await this.#get<NetworkJson>(`/networks/${name}`, "network.inspect");
      if (raced === undefined) {
        throw fail(`network ${name} conflicted and then vanished`, "hub", "retry", "box.vanished");
      }
      this.#checkOwned(spec.boxId, raced.Labels, `network ${name}`);
    }
  }

  async #ensureVolume(
    spec: BoxSpec,
    name: string,
    role: "workspace" | "home",
    createdAt: string,
  ): Promise<void> {
    // Creating an existing named volume returns it unchanged.
    const res = await this.#engine.request({
      method: "POST",
      path: "/volumes/create",
      body: {
        Name: name,
        Labels: this.#labels(spec, { [LABEL.createdAt]: createdAt, [LABEL.volumeRole]: role }),
      },
      ok: [200, 201],
      timeoutMs: this.config.requestTimeoutMs,
      endpoint: "volume.create",
    });
    this.#checkOwned(spec.boxId, (res.body as VolumeJson | undefined)?.Labels, `volume ${name}`);
  }

  /** Inspect the image, pulling it when missing. Returns its pinned pi version label. */
  async #ensureImage(image: string): Promise<string | undefined> {
    let found = await this.#inspectImage(image);
    if (found === undefined) {
      if (this.config.pullPolicy === "never") {
        throw fail(
          `image ${image} is not present and pulling is off`,
          "box",
          "give-up",
          "box.image-missing",
        );
      }
      await this.#pull(image);
      found = await this.#inspectImage(image);
      if (found === undefined) {
        throw fail(`image ${image} is missing after a pull`, "box", "give-up", "box.image-missing");
      }
    }
    return found.Config?.Labels?.[LABEL.piVersion];
  }

  async #inspectImage(image: string) {
    try {
      return await this.#get<{ Config?: { Labels?: Record<string, string> | null } }>(
        `/images/${image}/json`,
        "image.inspect",
      );
    } catch (error) {
      throw asHubFailure(error);
    }
  }

  async #pull(image: string): Promise<void> {
    let res: Awaited<ReturnType<DockerEngine["request"]>>;
    try {
      res = await this.#engine.request({
        method: "POST",
        path: "/images/create",
        query: { fromImage: image },
        ok: [200, 404],
        timeoutMs: this.config.pullTimeoutMs,
        endpoint: "image.pull",
      });
    } catch (error) {
      if (error instanceof DockerApiError) {
        throw fail(error.message, "box", "give-up", "box.image-pull-failed", error);
      }
      throw asHubFailure(error);
    }
    // The pull answers 200 and streams JSON progress lines; a failure is a line
    // with an `error` field.
    const failure =
      res.status === 404
        ? res.text
        : res.text
            .split("\n")
            .map((line) => {
              try {
                return JSON.parse(line) as { error?: unknown };
              } catch {
                return undefined;
              }
            })
            .find((line) => line?.error !== undefined)?.error;
    if (failure !== undefined) {
      throw fail(
        `pulling ${image} failed: ${String(failure).slice(0, 300)}`,
        "box",
        "give-up",
        "box.image-pull-failed",
      );
    }
  }

  async #inspectContainer(boxId: BoxId): Promise<ContainerJson | undefined> {
    const name = this.objectName(boxId);
    const container = await this.#get<ContainerJson>(
      `/containers/${name}/json`,
      "container.inspect",
    );
    if (container !== undefined) {
      this.#checkOwned(boxId, container.Config?.Labels, `container ${name}`);
    }
    return container;
  }

  async #inspectVolume(boxId: BoxId): Promise<VolumeJson | undefined> {
    const name = this.objectName(boxId);
    const volume = await this.#get<VolumeJson>(`/volumes/${name}`, "volume.inspect");
    if (volume !== undefined) this.#checkOwned(boxId, volume.Labels, `volume ${name}`);
    return volume;
  }

  async #removeContainer(id: string): Promise<void> {
    // `v=false`: anonymous volumes only; the named box volumes are never touched here.
    await this.#remove(`/containers/${id}`, "container.remove", { force: true, v: false });
  }

  /** GET an object; `undefined` when the daemon says it does not exist. */
  async #get<T>(path: string, endpoint: string): Promise<T | undefined> {
    try {
      const res = await this.#engine.request({
        method: "GET",
        path,
        ok: [200, 404],
        timeoutMs: this.config.requestTimeoutMs,
        endpoint,
      });
      return res.status === 404 ? undefined : (res.body as T);
    } catch (error) {
      throw asHubFailure(error);
    }
  }

  /** DELETE an object; a missing one counts as removed. */
  async #remove(
    path: string,
    endpoint: string,
    query?: Record<string, string | number | boolean>,
  ): Promise<void> {
    try {
      const res = await this.#engine.request({
        method: "DELETE",
        path,
        ...(query === undefined ? {} : { query }),
        // 409 on a container: removal already in progress.
        ok: [200, 204, 404, 409],
        timeoutMs: this.config.requestTimeoutMs,
        endpoint,
      });
      if (res.status === 409 && !endpoint.startsWith("container.")) {
        throw fail(`docker ${endpoint}: ${res.text.slice(0, 200)}`, "box", "retry", "box.in-use");
      }
    } catch (error) {
      throw asHubFailure(error);
    }
  }

  /**
   * A Docker object with a box's name that Hearth did not create (or that
   * belongs to another instance or box) is never adopted, changed or removed.
   */
  #checkOwned(
    boxId: BoxId,
    labels: Readonly<Record<string, string>> | null | undefined,
    what: string,
  ): void {
    if (
      labels?.[LABEL.managed] !== "true" ||
      labels[LABEL.instance] !== this.config.instance ||
      labels[LABEL.boxId] !== boxId
    ) {
      throw fail(
        `${what} exists but is not managed by Hearth instance ${this.config.instance} for box ${boxId}`,
        "hub",
        "give-up",
        "box.name-conflict",
      );
    }
  }

  // --- validation ---

  #validateId(boxId: BoxId): void {
    if (!NAME_PART.test(boxId)) {
      throw fail(
        `box id must match ${NAME_PART}, got ${JSON.stringify(boxId)}`,
        "hub",
        "give-up",
        "box.invalid-spec",
      );
    }
  }

  #validateSpec(spec: BoxSpec): void {
    this.#validateId(spec.boxId);
    const bad = (message: string) => fail(message, "hub", "give-up", "box.invalid-spec");
    if (!IMAGE_REF.test(spec.image) || spec.image.includes("..")) {
      throw bad(`image reference is not valid: ${JSON.stringify(spec.image)}`);
    }
    for (const [key, value] of Object.entries(spec.resources ?? {})) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw bad(`resources.${key} must be a positive number`);
      }
    }
  }

  /** `KEY=value` lines: the caller's boot env, then the provider's own keys on top. */
  #bootEnv(spec: BoxSpec, boot: BoxBootConfig): string[] {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(boot.env)) {
      // Names only in the message: values may be tokens (PRD §10).
      if (!ENV_KEY.test(key) || value.includes("\0")) {
        throw fail(
          `boot env ${JSON.stringify(key)} is not a valid variable`,
          "hub",
          "give-up",
          "box.invalid-spec",
        );
      }
      env[key] = value;
    }
    env["HEARTH_BOX_ID"] = spec.boxId;
    env["HEARTH_WORKSPACE_ID"] = spec.workspaceId;
    env["HEARTH_SESSION_ID"] = spec.sessionId;
    env["HEARTH_CHROMIUM_SANDBOX"] = "off";
    return Object.entries(env).map(([key, value]) => `${key}=${value}`);
  }

  async #locked<T>(boxId: BoxId, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(boxId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#locks.set(boxId, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(boxId) === tail) this.#locks.delete(boxId);
    }
  }
}
