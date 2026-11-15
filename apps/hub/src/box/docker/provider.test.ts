import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxSpec, HearthError } from "@hearth/core";
import { dockerBoxConfigFromEnv } from "./config";
import { FakeDockerEngine, type FakeNetwork } from "./fake-engine";
import { BOX_BRIDGE_PREFIX, bridgeName, DockerBoxProvider, LABEL } from "./provider";

const IMAGE = "ghcr.io/zerone0x/hearth-box:test";
const spec: BoxSpec = {
  boxId: "bx_1",
  workspaceId: "ws_default",
  sessionId: "se_1",
  image: IMAGE,
  labels: { team: "a", [LABEL.boxId]: "spoofed" },
};
const boot = { env: { HEARTH_HUB_URL: "ws://hub.example:8787/box", HEARTH_JOIN_TOKEN: "tok-1" } };

let fake: FakeDockerEngine;
let provider: DockerBoxProvider;

function make(config: ConstructorParameters<typeof DockerBoxProvider>[0] = {}) {
  return new DockerBoxProvider({
    now: () => 1_700_000_000_000,
    ...config,
    config: { socketPath: fake.socketPath, instance: "t", ...config.config },
  });
}

async function rejection(promise: Promise<unknown>): Promise<HearthError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HearthError);
    return error as HearthError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  fake = new FakeDockerEngine();
  fake.images.set(IMAGE, { [LABEL.piVersion]: "1.5.2" });
  provider = make();
});
afterEach(() => fake.close());

describe("hubAddress", () => {
  test("is the IPv4 gateway of the box's own network", async () => {
    await provider.create(spec);
    const network = fake.networks.get("t-box-bx_1");
    network?.IPAM.Config.unshift({ Subnet: "fd00::/64", Gateway: "fd00::1" });
    expect(await provider.hubAddress("bx_1")).toBe(network?.IPAM.Config[1]?.Gateway as string);
    expect(BOX_BRIDGE_PREFIX).toBe("hbx");
  });

  test("fails for a missing network, a foreign one, or one without an IPv4 gateway", async () => {
    expect((await rejection(provider.hubAddress("bx_1"))).code).toBe("box.network-missing");
    fake.networks.set(NET, foreignNetwork({}));
    expect((await rejection(provider.hubAddress("bx_1"))).code).toBe("box.name-conflict");
    fake.networks.clear();
    await provider.create(spec);
    const network = fake.networks.get("t-box-bx_1");
    if (network !== undefined) network.IPAM.Config = [];
    expect((await rejection(provider.hubAddress("bx_1"))).code).toBe("box.network-invalid");
  });
});

describe("create", () => {
  test("creates a labeled network and two labeled volumes, and no container", async () => {
    const info = await provider.create(spec);
    expect(info).toEqual({
      boxId: "bx_1",
      workspaceId: "ws_default",
      sessionId: "se_1",
      state: "stopped",
      image: IMAGE,
      volumeRef: "t-box-bx_1",
      labels: expect.any(Object),
      createdAt: 1_700_000_000_000,
    });
    expect(info.providerRef).toBeUndefined();
    expect(fake.containers.size).toBe(0);

    const network = fake.networks.get("t-box-bx_1");
    expect(network?.Internal).toBe(false);
    // IPv4 only, no inter-container traffic, and a bridge the host firewall
    // matches by its `hbx` prefix (decision 0012).
    expect(network?.EnableIPv6).toBe(false);
    expect(network?.Options).toEqual({
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.name": bridgeName("t-box-bx_1"),
    });
    expect(bridgeName("t-box-bx_1")).toMatch(/^hbx[0-9a-f]{12}$/);
    expect(bridgeName("t-box-bx_2")).not.toBe(bridgeName("t-box-bx_1"));
    expect([...fake.volumes.keys()].sort()).toEqual(["t-box-bx_1", "t-box-bx_1-home"]);
    for (const labels of [network?.Labels, fake.volumes.get("t-box-bx_1")?.Labels]) {
      expect(labels).toMatchObject({
        team: "a",
        [LABEL.managed]: "true",
        [LABEL.instance]: "t",
        [LABEL.boxId]: "bx_1",
        [LABEL.workspaceId]: "ws_default",
        [LABEL.sessionId]: "se_1",
        [LABEL.image]: IMAGE,
      });
    }
    expect(fake.volumes.get("t-box-bx_1-home")?.Labels[LABEL.volumeRole]).toBe("home");
  });

  test("creating an existing box id returns it unchanged", async () => {
    const first = await provider.create(spec);
    const second = await provider.create({ ...spec, sessionId: "se_other", image: "other:1" });
    expect(second).toEqual(first);
    expect(fake.calls("POST", /^\/networks\/create$/)).toHaveLength(1);
    expect(fake.volumes.get("t-box-bx_1")?.Labels[LABEL.sessionId]).toBe("se_1");
  });

  test("refuses a same-named object that Hearth does not manage", async () => {
    fake.volumes.set("t-box-bx_1", { Name: "t-box-bx_1", CreatedAt: "", Labels: {} });
    const error = await rejection(provider.create(spec));
    expect(error.code).toBe("box.name-conflict");
    expect(error.owner).toBe("hub");
    // And never removes it.
    expect(await rejection(provider.destroy("bx_1"))).toMatchObject({ code: "box.name-conflict" });
    expect(fake.volumes.has("t-box-bx_1")).toBe(true);
  });

  test("rejects invalid ids and specs as hub-owned, without calling Docker", async () => {
    for (const bad of [
      provider.create({ ...spec, boxId: "../x" }),
      provider.create({ ...spec, image: "img?x=1" }),
      provider.create({ ...spec, resources: { cpus: -1 } }),
      provider.start(spec, { env: { "BAD=KEY": "v" } }),
      provider.stop("a b"),
    ]) {
      expect(await rejection(bad)).toMatchObject({ owner: "hub", code: "box.invalid-spec" });
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("start", () => {
  test("builds a container with limits, labels, mounts, isolation and the boot env", async () => {
    const info = await provider.start(spec, boot);
    expect(info.state).toBe("running");
    expect(info.providerRef).toBeDefined();

    const [create] = fake.calls("POST", /^\/containers\/create$/);
    expect(create?.query.get("name")).toBe("t-box-bx_1");
    const body = create?.body as Record<string, unknown>;
    expect(body["Image"]).toBe(IMAGE);
    expect(body["User"]).toBe("1000:1000");
    expect(body["Labels"]).toMatchObject({
      team: "a",
      [LABEL.boxId]: "bx_1",
      [LABEL.workspaceId]: "ws_default",
      [LABEL.sessionId]: "se_1",
      [LABEL.image]: IMAGE,
      [LABEL.piVersion]: "1.5.2",
      [LABEL.instance]: "t",
    });
    expect(body["ExposedPorts"]).toEqual({});
    expect((body["Env"] as string[]).sort()).toEqual([
      "HEARTH_BOX_ID=bx_1",
      "HEARTH_CHROMIUM_SANDBOX=off",
      "HEARTH_HUB_URL=ws://hub.example:8787/box",
      "HEARTH_JOIN_TOKEN=tok-1",
      "HEARTH_SESSION_ID=se_1",
      "HEARTH_WORKSPACE_ID=ws_default",
    ]);
    expect(body["HostConfig"]).toEqual({
      NetworkMode: "t-box-bx_1",
      Mounts: [
        { Type: "volume", Source: "t-box-bx_1", Target: "/workspace" },
        { Type: "volume", Source: "t-box-bx_1-home", Target: "/home/hearth" },
      ],
      NanoCpus: 2_000_000_000,
      Memory: 2 * 1024 ** 3,
      MemorySwap: 2 * 1024 ** 3,
      PidsLimit: 1024,
      ShmSize: 256 * 1024 ** 2,
      Sysctls: {
        "net.ipv6.conf.all.disable_ipv6": "1",
        "net.ipv6.conf.default.disable_ipv6": "1",
      },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      PublishAllPorts: false,
      PortBindings: {},
      RestartPolicy: { Name: "no" },
    });
    expect(body["NetworkingConfig"]).toEqual({ EndpointsConfig: { "t-box-bx_1": {} } });
  });

  test("spec resources override the configured limits, and disk maps to StorageOpt", async () => {
    await make({ config: { limits: { cpus: 1, memoryBytes: 1e9, pids: 100 } } }).start(
      { ...spec, resources: { cpus: 0.5, memoryBytes: 512e6, pids: 64, diskBytes: 10e9 } },
      boot,
    );
    const created = fake.calls("POST", /^\/containers\/create$/)[0]?.body as Record<
      string,
      unknown
    >;
    const host = created["HostConfig"];
    expect(host).toMatchObject({
      NanoCpus: 500_000_000,
      Memory: 512e6,
      MemorySwap: 512e6,
      PidsLimit: 64,
      StorageOpt: { size: "10000000000" },
    });
  });

  test("the caller cannot override provider labels or env", async () => {
    await provider.start(spec, { env: { HEARTH_BOX_ID: "evil", HEARTH_CHROMIUM_SANDBOX: "on" } });
    const body = fake.calls("POST", /^\/containers\/create$/)[0]?.body as Record<string, unknown>;
    expect(body["Env"]).toContain("HEARTH_BOX_ID=bx_1");
    expect(body["Env"]).toContain("HEARTH_CHROMIUM_SANDBOX=off");
    expect((body["Labels"] as Record<string, string>)[LABEL.boxId]).toBe("bx_1");
  });

  test("a running box is left alone and the new boot is not applied", async () => {
    const first = await provider.start(spec, boot);
    const second = await provider.start(spec, { env: { HEARTH_JOIN_TOKEN: "tok-2" } });
    expect(second.providerRef).toBe(first.providerRef);
    expect(fake.calls("POST", /^\/containers\/create$/)).toHaveLength(1);
  });

  test("an exited runtime is replaced by a fresh one", async () => {
    const first = await provider.start(spec, boot);
    const c = fake.containers.get(first.providerRef as string);
    if (c) {
      c.State.Status = "exited";
      c.State.ExitCode = 3;
    }
    const exited = await provider.attach("bx_1");
    expect(exited?.state).toBe("exited");
    // The hub classifies the exit by its code (decision 0013).
    expect(exited?.exitCode).toBe(3);
    const second = await provider.start(spec, { env: { HEARTH_JOIN_TOKEN: "tok-2" } });
    expect(second.state).toBe("running");
    expect(second.providerRef).not.toBe(first.providerRef);
    expect(fake.containers.size).toBe(1);
    expect([...fake.containers.values()][0]?.Config.Env).toContain("HEARTH_JOIN_TOKEN=tok-2");
  });

  test("concurrent starts create one container", async () => {
    const [a, b] = await Promise.all([provider.start(spec, boot), provider.start(spec, boot)]);
    expect(a.providerRef).toBe(b.providerRef as string);
    expect(fake.calls("POST", /^\/containers\/create$/)).toHaveLength(1);
  });

  test("pulls a missing image, and a failed pull is a box-owned give-up", async () => {
    fake.images.clear();
    fake.registry.set(IMAGE, { [LABEL.piVersion]: "1.5.2" });
    expect((await provider.start(spec, boot)).state).toBe("running");
    expect(fake.calls("POST", /^\/images\/create$/)[0]?.query.get("fromImage")).toBe(IMAGE);

    const other = { ...spec, boxId: "bx_2", image: "ghcr.io/x/missing:1" };
    expect(await rejection(provider.start(other, boot))).toMatchObject({
      owner: "box",
      disposition: "give-up",
      code: "box.image-pull-failed",
    });
    expect(
      await rejection(make({ config: { pullPolicy: "never" } }).start(other, boot)),
    ).toMatchObject({ owner: "box", code: "box.image-missing" });
  });

  test("a runtime refusing the box is box-owned, retry-cold, and leaves no container", async () => {
    fake.override = (r) =>
      r.method === "POST" && r.path.endsWith("/start")
        ? Response.json({ message: "OCI runtime create failed" }, { status: 500 })
        : undefined;
    expect(await rejection(provider.start(spec, boot))).toMatchObject({
      owner: "box",
      disposition: "retry-cold",
      code: "box.start-failed",
    });
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.size).toBe(2);
  });

  test("a leftover container with the box's name is replaced", async () => {
    await provider.create(spec);
    let conflicts = 0;
    fake.override = (r) =>
      r.method === "POST" && r.path === "/containers/create" && conflicts++ === 0
        ? Response.json({ message: "Conflict" }, { status: 409 })
        : undefined;
    expect((await provider.start(spec, boot)).state).toBe("running");
    expect(fake.calls("POST", /^\/containers\/create$/)).toHaveLength(2);
  });
});

describe("labels, user and create failures", () => {
  test("a user label under dev.hearth. is dropped, never set on any object", async () => {
    fake.images.set(IMAGE, {});
    await provider.start(
      {
        ...spec,
        labels: {
          team: "a",
          [LABEL.piVersion]: "9.9.9",
          [LABEL.createdAt]: "1",
          [LABEL.volumeRole]: "home",
          [LABEL.managed]: "false",
          "dev.hearth.extra": "x",
        },
      },
      boot,
    );
    const container = [...fake.containers.values()][0]?.Config.Labels ?? {};
    expect(container[LABEL.piVersion]).toBeUndefined();
    expect(container[LABEL.createdAt]).toBeUndefined();
    expect(container[LABEL.volumeRole]).toBeUndefined();
    for (const labels of [
      container,
      fake.networks.get("t-box-bx_1")?.Labels ?? {},
      fake.volumes.get("t-box-bx_1")?.Labels ?? {},
      fake.volumes.get("t-box-bx_1-home")?.Labels ?? {},
    ]) {
      expect(labels["team"]).toBe("a");
      expect(labels[LABEL.managed]).toBe("true");
      expect(labels["dev.hearth.extra"]).toBeUndefined();
    }
    expect(fake.volumes.get("t-box-bx_1")?.Labels[LABEL.volumeRole]).toBe("workspace");
    expect(fake.volumes.get("t-box-bx_1")?.Labels[LABEL.createdAt]).toBe("1700000000000");
  });

  test("a 404 from containers/create says which object is missing", async () => {
    await provider.create(spec);
    // The image disappears after it was inspected.
    fake.override = (r) => {
      if (r.method === "POST" && r.path === "/containers/create") fake.images.delete(IMAGE);
      return undefined;
    };
    expect(await rejection(provider.start(spec, boot))).toMatchObject({
      owner: "box",
      disposition: "give-up",
      code: "box.image-missing",
    });

    // The box's network disappears after create built it.
    fake.images.set(IMAGE, { [LABEL.piVersion]: "1.5.2" });
    fake.override = (r) => {
      if (r.method === "POST" && r.path === "/containers/create") fake.networks.clear();
      return undefined;
    };
    expect(await rejection(provider.start(spec, boot))).toMatchObject({
      owner: "box",
      disposition: "retry-cold",
      code: "box.network-missing",
    });
    // A cold retry builds the network again.
    fake.override = undefined;
    expect((await provider.start(spec, boot)).state).toBe("running");
    expect(fake.networks.has("t-box-bx_1")).toBe(true);

    // Neither is missing: the runtime refused the create.
    await provider.stop("bx_1");
    fake.override = (r) =>
      r.method === "POST" && r.path === "/containers/create"
        ? Response.json({ message: "no such device" }, { status: 404 })
        : undefined;
    expect(await rejection(provider.start(spec, boot))).toMatchObject({
      owner: "box",
      disposition: "retry-cold",
      code: "box.create-failed",
    });
  });
});

/**
 * Same-named objects that are not this box's: unlabeled, labeled for another
 * instance, and labeled for another box of this instance. None may be started,
 * stopped, attached to, mounted or removed.
 */
const FOREIGN: Record<string, Record<string, string>> = {
  unlabeled: {},
  "another instance": {
    [LABEL.managed]: "true",
    [LABEL.instance]: "other",
    [LABEL.boxId]: "bx_1",
  },
  "another box": { [LABEL.managed]: "true", [LABEL.instance]: "t", [LABEL.boxId]: "bx_9" },
};

const NET = "t-box-bx_1";
const NET_ID = "nforeign0000";
const foreignNetwork = (labels: Record<string, string>): FakeNetwork => ({
  Id: NET_ID,
  Name: NET,
  Labels: { ...labels },
  Options: {},
  Internal: false,
  EnableIPv6: false,
  IPAM: { Config: [{ Subnet: "172.31.0.0/24", Gateway: "172.31.0.1" }] },
});

/**
 * Requests that remove, connect to, mount or attach a container to the network or
 * volume `name` (or `id`). Container names never collide with these here.
 */
function touching(kind: "networks" | "volumes", name: string, id: string) {
  return fake.requests.filter((r) => {
    const [, root, ref, verb] = r.path.split("/");
    const hit = root === kind && (ref === name || ref === id);
    if (hit && (r.method === "DELETE" || verb !== undefined)) return true;
    if (r.method === "POST" && r.path === "/containers/create") {
      const host = ((r.body ?? {}) as { HostConfig?: Record<string, unknown> }).HostConfig ?? {};
      const mounts = (host["Mounts"] ?? []) as { Source: string }[];
      return kind === "networks"
        ? host["NetworkMode"] === name || host["NetworkMode"] === id
        : mounts.some((m) => m.Source === name);
    }
    return false;
  });
}

const createCalls = () => fake.requests.filter((r) => r.path === "/containers/create");

describe("ownership of same-named objects", () => {
  for (const [kind, labels] of Object.entries(FOREIGN)) {
    describe(kind, () => {
      test("a foreign home volume is never mounted or removed", async () => {
        const home = { Name: "t-box-bx_1-home", CreatedAt: "", Labels: { ...labels } };
        fake.volumes.set(home.Name, home);
        for (const call of [
          () => provider.create(spec),
          () => provider.start(spec, boot),
          () => provider.destroy("bx_1"),
        ]) {
          expect(await rejection(call())).toMatchObject({ code: "box.name-conflict" });
        }
        expect(fake.containers.size).toBe(0);
        expect(createCalls()).toEqual([]);
        expect(touching("volumes", home.Name, home.Name)).toEqual([]);
        expect(fake.volumes.get(home.Name)).toEqual({ ...home, Labels: { ...labels } });
      });

      test("a foreign network found by create or start is never used", async () => {
        fake.networks.set(NET, foreignNetwork(labels));
        expect(await rejection(provider.create(spec))).toMatchObject({ code: "box.name-conflict" });
        expect(await rejection(provider.start(spec, boot))).toMatchObject({
          code: "box.name-conflict",
        });
        expect(createCalls()).toEqual([]);
        expect(touching("networks", NET, NET_ID)).toEqual([]);
        expect(fake.networks.get(NET)).toEqual(foreignNetwork(labels));
      });

      test("destroy never removes a foreign network", async () => {
        // Alone, and next to this box's own volumes.
        fake.networks.set(NET, foreignNetwork(labels));
        expect(await rejection(provider.destroy("bx_1"))).toMatchObject({
          code: "box.name-conflict",
        });
        fake.networks.clear();
        await provider.create(spec);
        fake.networks.set(NET, foreignNetwork(labels));
        expect(await rejection(provider.destroy("bx_1"))).toMatchObject({
          code: "box.name-conflict",
        });
        expect(touching("networks", NET, NET_ID)).toEqual([]);
        expect(fake.networks.get(NET)).toEqual(foreignNetwork(labels));
      });

      test("a foreign network created between inspect and create is never used", async () => {
        // The race: the inspect finds nothing, then someone creates the name, so
        // networks/create answers 409.
        fake.override = (r) => {
          if (r.method === "POST" && r.path === "/networks/create") {
            fake.networks.set(NET, foreignNetwork(labels));
          }
          return undefined;
        };
        expect(await rejection(provider.start(spec, boot))).toMatchObject({
          code: "box.name-conflict",
        });
        expect(fake.requests.filter((r) => r.path === "/networks/create")).toHaveLength(1);
        expect(createCalls()).toEqual([]);
        expect(touching("networks", NET, NET_ID)).toEqual([]);
        expect(fake.networks.get(NET)).toEqual(foreignNetwork(labels));
      });
    });
  }

  test("a network this box's own hub created during the race is used", async () => {
    fake.override = (r) => {
      if (r.method === "POST" && r.path === "/networks/create") {
        fake.networks.set(
          NET,
          foreignNetwork({ [LABEL.managed]: "true", [LABEL.instance]: "t", [LABEL.boxId]: "bx_1" }),
        );
      }
      return undefined;
    };
    expect((await provider.start(spec, boot)).state).toBe("running");
    expect(createCalls()).toHaveLength(1);
  });
});

describe("stop", () => {
  test("hibernates: stops with the grace, removes the container, keeps the volumes", async () => {
    await provider.start(spec, boot);
    expect(await provider.stop("bx_1", { graceMs: 2_500 })).toBe("stopped");
    expect(fake.calls("POST", /\/stop$/)[0]?.query.get("t")).toBe("3");
    const remove = fake.calls("DELETE", /^\/containers\//)[0];
    expect(remove?.query.get("force")).toBe("true");
    expect(remove?.query.get("v")).toBe("false");
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.size).toBe(2);
    expect(await provider.attach("bx_1")).toMatchObject({ state: "stopped", sessionId: "se_1" });
  });

  test("uses the configured grace by default", async () => {
    await provider.start(spec, boot);
    await provider.stop("bx_1");
    expect(fake.calls("POST", /\/stop$/)[0]?.query.get("t")).toBe("10");
  });

  test("answers already-stopped and not-found explicitly", async () => {
    expect(await provider.stop("bx_1")).toBe("not-found");
    await provider.create(spec);
    expect(await provider.stop("bx_1")).toBe("already-stopped");
    await provider.start(spec, boot);
    expect(await provider.stop("bx_1")).toBe("stopped");
    expect(await provider.stop("bx_1")).toBe("already-stopped");
  });
});

describe("destroy", () => {
  test("removes the container, both volumes and the network", async () => {
    await provider.start(spec, boot);
    expect(await provider.destroy("bx_1")).toBe("destroyed");
    expect(fake.containers.size + fake.volumes.size + fake.networks.size).toBe(0);
    expect(await provider.attach("bx_1")).toBeUndefined();
  });

  test("destroying a missing box succeeds with not-found", async () => {
    expect(await provider.destroy("bx_1")).toBe("not-found");
    await provider.create(spec);
    expect(await provider.destroy("bx_1")).toBe("destroyed");
    expect(await provider.destroy("bx_1")).toBe("not-found");
  });
});

describe("snapshot, attach and adopt", () => {
  test("snapshot is not supported in v1", async () => {
    await provider.start(spec, boot);
    expect(await provider.snapshot("bx_1")).toEqual({ kind: "not-supported" });
  });

  test("attach reports a missing box as undefined", async () => {
    expect(await provider.attach("bx_1")).toBeUndefined();
  });

  test("adopt lists this instance's boxes, running or not, and skips others", async () => {
    await provider.start(spec, boot);
    await provider.create({ ...spec, boxId: "bx_2", sessionId: "se_2" });
    await make({ config: { instance: "other" } }).create({ ...spec, boxId: "bx_3" });

    const adopted = await make().adopt();
    expect(adopted.map((b) => [b.boxId, b.sessionId, b.state])).toEqual([
      ["bx_1", "se_1", "running"],
      ["bx_2", "se_2", "stopped"],
    ]);
    const list = fake.calls("GET", /^\/containers\/json$/)[0];
    expect(list?.query.get("all")).toBe("true");
    expect(JSON.parse(list?.query.get("filters") ?? "{}")).toEqual({
      label: [`${LABEL.managed}=true`, `${LABEL.instance}=t`],
    });
  });
});

describe("failure classification", () => {
  test("a missing socket is hub-owned and retryable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-nosock-"));
    try {
      const p = make({ config: { socketPath: join(dir, "none.sock") } });
      expect(await rejection(p.attach("bx_1"))).toMatchObject({
        owner: "hub",
        disposition: "retry",
        code: "docker.unreachable",
      });
      writeFileSync(join(dir, "file.sock"), "");
      const q = make({ config: { socketPath: join(dir, "file.sock") } });
      expect(await rejection(q.adopt())).toMatchObject({
        owner: "hub",
        code: "docker.unreachable",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hung daemon hits the named deadline", async () => {
    fake.override = () => new Promise<Response>(() => {}) as unknown as Response;
    const p = make({ config: { requestTimeoutMs: 100 } });
    expect(await rejection(p.attach("bx_1"))).toMatchObject({
      owner: "hub",
      disposition: "retry",
      code: "docker.timeout",
    });
  });

  test("daemon errors on its own objects are hub-owned", async () => {
    fake.override = () => Response.json({ message: "boom" }, { status: 500 });
    expect(await rejection(provider.create(spec))).toMatchObject({
      owner: "hub",
      disposition: "retry",
      code: "docker.api-error",
    });
  });

  test("error messages never contain boot env values", async () => {
    fake.override = (r) =>
      r.path === "/containers/create"
        ? Response.json({ message: "invalid" }, { status: 400 })
        : undefined;
    const error = await rejection(provider.start(spec, boot));
    expect(error.message).not.toContain("tok-1");
  });
});

describe("dockerBoxConfigFromEnv", () => {
  test("defaults, overrides and validation", () => {
    expect(dockerBoxConfigFromEnv({}).socketPath).toBe("/var/run/docker.sock");
    const c = dockerBoxConfigFromEnv({
      HEARTH_DOCKER_SOCKET: "/run/user/1000/docker.sock",
      HEARTH_BOX_CPUS: "1.5",
      HEARTH_BOX_MEMORY_BYTES: "1073741824",
      HEARTH_BOX_PIDS: "256",
      HEARTH_BOX_DISK_BYTES: "5000000000",
      HEARTH_BOX_PULL: "never",
    });
    expect(c.socketPath).toBe("/run/user/1000/docker.sock");
    expect(c.limits).toEqual({ cpus: 1.5, memoryBytes: 1073741824, pids: 256, diskBytes: 5e9 });
    expect(c.pullPolicy).toBe("never");
    expect(() => dockerBoxConfigFromEnv({ HEARTH_BOX_PIDS: "1.5" })).toThrow();
    expect(() => dockerBoxConfigFromEnv({ HEARTH_BOX_PULL: "always" })).toThrow();
    expect(() => dockerBoxConfigFromEnv({ HEARTH_BOX_INSTANCE: "a/b" })).toThrow();
  });
});
