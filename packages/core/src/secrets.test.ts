import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  createDefaultSecretStore,
  fingerprint,
  parseSecretRef,
  ResolvingSecretStore,
  SecretError,
  type SecretResolver,
  SecretValue,
} from "./secrets";

const RAW = "sk-very-secret-value-123";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hearth-secrets-"));
  await writeFile(join(dir, "token"), `${RAW}\n`);
  await writeFile(join(dir, "empty"), "\n");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A resolver that counts calls and resolves only when released. */
function gatedResolver(values: Record<string, string>) {
  const state = { calls: 0, release: () => {} };
  let gate = Promise.resolve();
  const resolver: SecretResolver = {
    scheme: "test",
    async resolve(body) {
      state.calls++;
      await gate;
      const value = values[body];
      if (value === undefined) throw new Error("missing");
      return value;
    },
  };
  const hold = () => {
    gate = new Promise((resolve) => {
      state.release = resolve;
    });
  };
  return { resolver, state, hold };
}

describe("references", () => {
  test("parse into scheme and body", () => {
    expect(parseSecretRef("env:HEARTH_X")).toEqual({ scheme: "env", body: "HEARTH_X" });
    expect(parseSecretRef("file:/a:b")).toEqual({ scheme: "file", body: "/a:b" });
  });

  test("a malformed reference is rejected without echoing it", () => {
    let error: unknown;
    try {
      parseSecretRef(RAW);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecretError);
    expect((error as SecretError).code).toBe("secret.malformed-ref");
    expect((error as SecretError).message).not.toContain(RAW);
    expect((error as SecretError).message).toContain(fingerprint(RAW));
  });
});

describe("env: and file: resolution", () => {
  const store = createDefaultSecretStore({ env: { HEARTH_TOKEN: RAW, HEARTH_EMPTY: "" } });

  test("env: reads the injected environment", async () => {
    expect((await store.resolve("env:HEARTH_TOKEN")).reveal()).toBe(RAW);
  });

  test("file: reads the file and drops one trailing newline", async () => {
    expect((await store.resolve(`file:${join(dir, "token")}`)).reveal()).toBe(RAW);
  });

  test("file: rejects relative paths", async () => {
    await expect(store.resolve("file:token")).rejects.toMatchObject({
      code: "secret.malformed-ref",
    });
  });

  test("missing and empty values are errors", async () => {
    await expect(store.resolve("env:HEARTH_MISSING")).rejects.toMatchObject({
      code: "secret.not-found",
      owner: "user",
    });
    await expect(store.resolve("env:HEARTH_EMPTY")).rejects.toMatchObject({ code: "secret.empty" });
    await expect(store.resolve(`file:${join(dir, "nope")}`)).rejects.toMatchObject({
      code: "secret.not-found",
    });
  });

  test("an unknown scheme is rejected without echoing the reference", async () => {
    const pasted = `user:${RAW}`;
    const attempt = store.resolve(pasted);
    await expect(attempt).rejects.toMatchObject({ code: "secret.unknown-scheme" });
    const error = (await attempt.catch((e: unknown) => e)) as SecretError;
    expect(error.message).not.toContain(RAW);
    expect(error.ref).not.toContain(RAW);
  });
});

describe("SecretValue and fingerprint", () => {
  test("fingerprint is a stable sha256 prefix", () => {
    // sha256("abc") = ba7816bf8f01cfea…
    expect(fingerprint("abc")).toBe("sha256:ba7816bf8f01");
    expect(fingerprint("abd")).not.toBe(fingerprint("abc"));
  });

  test("string, JSON and inspect show the fingerprint, never the value", () => {
    const value = new SecretValue(RAW);
    for (const shown of [String(value), JSON.stringify({ value }), inspect(value), `${value}`]) {
      expect(shown).not.toContain(RAW);
      expect(shown).toContain(fingerprint(RAW));
    }
  });

  test("store.fingerprint matches the value", async () => {
    const store = createDefaultSecretStore({ env: { K: RAW } });
    expect(await store.fingerprint("env:K")).toBe(fingerprint(RAW));
  });
});

describe("cache", () => {
  test("reuses a value within the TTL and reads again after it", async () => {
    let now = 0;
    const { resolver, state } = gatedResolver({ a: "one" });
    const store = new ResolvingSecretStore({ resolvers: [resolver], ttlMs: 100, now: () => now });

    await store.resolve("test:a");
    now = 99;
    await store.resolve("test:a");
    expect(state.calls).toBe(1);
    now = 100;
    await store.resolve("test:a");
    expect(state.calls).toBe(2);
  });

  test("collapses concurrent lookups of one reference into one read", async () => {
    const { resolver, state, hold } = gatedResolver({ a: "one", b: "two" });
    const store = new ResolvingSecretStore({ resolvers: [resolver] });
    hold();
    const lookups = [store.resolve("test:a"), store.resolve("test:a"), store.resolve("test:a")];
    const other = store.resolve("test:b");
    state.release();
    const values = await Promise.all(lookups);
    expect(values.map((v) => v.reveal())).toEqual(["one", "one", "one"]);
    expect((await other).reveal()).toBe("two");
    expect(state.calls).toBe(2);
  });

  test("does not cache failures", async () => {
    const env: Record<string, string> = {};
    const store = createDefaultSecretStore({ env });
    await expect(store.resolve("env:LATE")).rejects.toMatchObject({ code: "secret.not-found" });
    env["LATE"] = "now-set";
    expect((await store.resolve("env:LATE")).reveal()).toBe("now-set");
  });

  test("invalidate drops the cached value, including one being read", async () => {
    const values: Record<string, string> = { a: "old" };
    const { resolver, state, hold } = gatedResolver(values);
    const store = new ResolvingSecretStore({ resolvers: [resolver] });
    await store.resolve("test:a");
    values["a"] = "new";
    store.invalidate("test:a");
    expect((await store.resolve("test:a")).reveal()).toBe("new");

    hold();
    const racing = store.resolve("test:a");
    store.invalidate();
    values["a"] = "newer";
    state.release();
    await racing;
    expect((await store.resolve("test:a")).reveal()).toBe("newer");
  });
});

describe("preflight", () => {
  test("passes when every reference resolves to a non-empty value", async () => {
    const store = createDefaultSecretStore({ env: { A: RAW } });
    expect(await store.preflight(["env:A", `file:${join(dir, "token")}`, "env:A"])).toEqual({
      ok: true,
      checked: 2,
    });
  });

  test("names each failing reference and never includes a value", async () => {
    const store = createDefaultSecretStore({ env: { A: RAW, EMPTY: "" } });
    const report = await store.preflight([
      "env:A",
      "env:MISSING",
      "env:EMPTY",
      `file:${join(dir, "empty")}`,
      RAW,
      `vault:${RAW}`,
    ]);
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.checked).toBe(6);
    expect(report.failures.map((f) => f.code)).toEqual([
      "secret.not-found",
      "secret.empty",
      "secret.empty",
      "secret.malformed-ref",
      "secret.unknown-scheme",
    ]);
    expect(report.failures[0]?.message).toContain("env:MISSING");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(RAW);
  });

  test("bypasses the cache, so a value removed since is reported", async () => {
    const env: Record<string, string | undefined> = { A: RAW };
    const store = createDefaultSecretStore({ env });
    await store.resolve("env:A");
    env["A"] = undefined;
    expect((await store.preflight(["env:A"])).ok).toBe(false);
  });

  test("a resolver that throws a non-SecretError does not leak its message", async () => {
    const leaky: SecretResolver = {
      scheme: "leaky",
      resolve: async () => {
        throw new Error(`boom ${RAW}`);
      },
    };
    const store = new ResolvingSecretStore({ resolvers: [leaky] });
    const report = await store.preflight(["leaky:x"]);
    expect(JSON.stringify(report)).not.toContain(RAW);
    expect(report.ok).toBe(false);
  });
});
