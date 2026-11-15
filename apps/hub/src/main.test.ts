import { describe, expect, test } from "bun:test";
import { DockerBoxProvider } from "./box/docker";
import { boxProviderFromEnv } from "./main";

describe("boxProviderFromEnv", () => {
  test("defaults to the Docker provider (decision 0012)", () => {
    for (const env of [{}, { HEARTH_BOX_PROVIDER: "" }, { HEARTH_BOX_PROVIDER: "docker" }]) {
      const provider = boxProviderFromEnv(env);
      expect(provider).toBeInstanceOf(DockerBoxProvider);
      expect(provider?.name).toBe("docker");
    }
  });

  test("passes the Docker settings from the environment through", () => {
    const provider = boxProviderFromEnv({
      HEARTH_DOCKER_SOCKET: "/tmp/hearth-test.sock",
      HEARTH_BOX_INSTANCE: "testinstance",
    });
    expect(provider).toBeInstanceOf(DockerBoxProvider);
    const config = (provider as DockerBoxProvider).config;
    expect(config.socketPath).toBe("/tmp/hearth-test.sock");
    expect(config.instance).toBe("testinstance");
  });

  test("none means a hub that starts no boxes", () => {
    expect(boxProviderFromEnv({ HEARTH_BOX_PROVIDER: "none" })).toBeUndefined();
  });

  test("anything else is refused", () => {
    expect(() => boxProviderFromEnv({ HEARTH_BOX_PROVIDER: "podman" })).toThrow(
      'HEARTH_BOX_PROVIDER must be "docker" or "none", got "podman"',
    );
  });
});
