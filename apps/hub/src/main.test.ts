import { describe, expect, test } from "bun:test";
import { type SecretStore, SecretValue } from "@hearth/core";
import { DockerBoxProvider } from "./box/docker";
import {
  approvalTimeoutMsFromEnv,
  boxProviderFromEnv,
  registerStartupSecrets,
  vaultConfigFromEnv,
} from "./main";

describe("approvalTimeoutMsFromEnv (decision 0048)", () => {
  test("unset or empty: the default (undefined, so Approvals uses 10 min)", () => {
    expect(approvalTimeoutMsFromEnv({})).toBeUndefined();
    expect(approvalTimeoutMsFromEnv({ HEARTH_APPROVAL_TIMEOUT_MINUTES: "" })).toBeUndefined();
  });

  test("minutes become milliseconds, fractions too", () => {
    expect(approvalTimeoutMsFromEnv({ HEARTH_APPROVAL_TIMEOUT_MINUTES: "10" })).toBe(600_000);
    expect(approvalTimeoutMsFromEnv({ HEARTH_APPROVAL_TIMEOUT_MINUTES: "0.5" })).toBe(30_000);
  });

  test("zero, negative and non-numbers are refused, not a silent default", () => {
    for (const raw of ["0", "-1", "-0.5", "abc", "Infinity", "NaN"]) {
      expect(() => approvalTimeoutMsFromEnv({ HEARTH_APPROVAL_TIMEOUT_MINUTES: raw })).toThrow(
        "HEARTH_APPROVAL_TIMEOUT_MINUTES must be a positive number",
      );
    }
  });
});

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

describe("vaultConfigFromEnv (decision 0031)", () => {
  test("passes both key references through and leaves unset or empty ones out", () => {
    expect(
      vaultConfigFromEnv({
        HEARTH_VAULT_KEY_REF: "file:/run/hearth-secrets/vault_key",
        HEARTH_VAULT_KEY_NEXT_REF: "file:/run/hearth-secrets/vault_key.next",
      }),
    ).toEqual({
      keyRef: "file:/run/hearth-secrets/vault_key",
      nextKeyRef: "file:/run/hearth-secrets/vault_key.next",
    });
    expect(vaultConfigFromEnv({ HEARTH_VAULT_KEY_REF: "", HEARTH_VAULT_KEY_NEXT_REF: "" })).toEqual(
      {},
    );
    expect(vaultConfigFromEnv({})).toEqual({});
  });
});

describe("registerStartupSecrets", () => {
  test("leaves a vault: model key to the vault and resolves any other", async () => {
    const asked: string[] = [];
    const secrets = {
      resolve: async (ref: string) => {
        asked.push(ref);
        return new SecretValue("startup-probe-value-2c7f");
      },
    } as unknown as SecretStore;
    const warn = { warn: () => {} };
    await registerStartupSecrets(secrets, { apiKeyRef: "vault:model" }, warn);
    expect(asked).toEqual([]);
    await registerStartupSecrets(secrets, { apiKeyRef: "env:MODEL_KEY" }, warn);
    expect(asked).toEqual(["env:MODEL_KEY"]);
  });
});
