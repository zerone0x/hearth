import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  createDefaultSecretStore,
  displayRef,
  fingerprint,
  MAX_DISPLAYED_ENV_NAME_LENGTH,
  parseSecretRef,
  ResolvingSecretStore,
  redactRef,
  SecretError,
  type SecretResolver,
  SecretValue,
} from "./secrets";

const RAW = "sk-very-secret-value-123";
/** Shaped like a GitHub token: only `[A-Za-z0-9_]`, so it passes the env-name lookup pattern. */
const GHP = "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
/** An AWS access key id: all caps, so it matches the conventional env-name pattern. */
const AKIA = "AKIAIOSFODNN7EXAMPLE";
const ASIA = "ASIAIOSFODNN7EXAMPLE";
/** All caps, over the displayed-name length cap, no known prefix. */
const LONG_CAPS = "QWERTYUIOPASDFGHJKLZXCVBNM1234567890QWERTY";
/** 40 random uppercase letters and digits: inside the old inclusive cap of 40. */
const CAPS_40 = "Q7XK2M9ZP4LW8RT3VN6YB1CJ5HD0GFA2SEUI4OXQ";
/** 33 random uppercase letters: one over the cap, no digits. */
const CAPS_33 = "QWHZKPLMRTXBVNCJDFGSYAEUIOQZXKWPM";
/** 20 random uppercase letters and digits, no `_`: under the cap, caught by shape. */
const CAPS_20 = "K3P9ZQ7WX2M4LR8TB6VN";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hearth-secrets-"));
  await writeFile(join(dir, "token"), `${RAW}\n`);
  await writeFile(join(dir, "empty"), "\n");
  await writeFile(join(dir, "blank"), "   \n");
  await writeFile(join(dir, "newlines"), "\n\n");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A resolver that counts calls and resolves only when released. It reads the
 * value when called, so a held read returns the value from before any change.
 */
function gatedResolver(values: Record<string, string>) {
  const state = { calls: 0, release: () => {} };
  let gate = Promise.resolve();
  const resolver: SecretResolver = {
    scheme: "test",
    async resolve(body) {
      state.calls++;
      const value = values[body];
      await gate;
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

  test("a raw value pasted after env: or file: is shown only by fingerprint", async () => {
    for (const pasted of [`env:${RAW}`, `file:${RAW}`, `file:../${RAW}`, `file:/x\n${RAW}`]) {
      const error = (await store.resolve(pasted).catch((e: unknown) => e)) as SecretError;
      expect(error).toBeInstanceOf(SecretError);
      expect(error.code).toBe("secret.malformed-ref");
      expect(error.message).not.toContain(RAW);
      expect(error.ref).not.toContain(RAW);
      expect(error.message).toContain(fingerprint(pasted));
    }
  });

  test("a token-shaped env: reference is shown only by fingerprint", async () => {
    const pasted = `env:${GHP}`;
    // Unset: the lookup runs, but neither the message nor `ref` names the token.
    const missing = (await store.resolve(pasted).catch((e: unknown) => e)) as SecretError;
    expect(missing).toBeInstanceOf(SecretError);
    expect(missing.code).toBe("secret.not-found");
    expect(missing.ref).toBe(redactRef(pasted));
    expect(missing.message).toContain(fingerprint(pasted));
    expect(missing.message).not.toContain(GHP);
    // Set but blank: the store's own error is redacted the same way.
    const blank = createDefaultSecretStore({ env: { [GHP]: " " } });
    const empty = (await blank.resolve(pasted).catch((e: unknown) => e)) as SecretError;
    expect(empty.code).toBe("secret.empty");
    expect(empty.ref).toBe(redactRef(pasted));
    expect(empty.message).not.toContain(GHP);
  });

  test("a conventional variable name is shown, an unconventional one is not", async () => {
    expect(displayRef("env:HEARTH_TOKEN")).toBe("env:HEARTH_TOKEN");
    expect(displayRef("env:_X9")).toBe("env:_X9");
    const longest = "A".repeat(MAX_DISPLAYED_ENV_NAME_LENGTH);
    expect(displayRef(`env:${longest}`)).toBe(`env:${longest}`);
    expect(displayRef(`env:${longest}A`)).toBe(redactRef(`env:${longest}A`));
    expect(displayRef("env:lower_case")).toBe(redactRef("env:lower_case"));
    expect(displayRef(`env:${GHP}`)).toBe(redactRef(`env:${GHP}`));
    expect(displayRef(RAW)).toBe(redactRef(RAW));
    const path = `file:${join(dir, "token")}`;
    expect(displayRef(path)).toBe(path);
    const error = (await store
      .resolve("env:HEARTH_MISSING")
      .catch((e: unknown) => e)) as SecretError;
    expect(error.ref).toBe("env:HEARTH_MISSING");
    expect(error.message).toContain("variable HEARTH_MISSING is not set");
  });

  test("an unconventional variable name still resolves", async () => {
    const lower = createDefaultSecretStore({ env: { lower_case: RAW } });
    expect((await lower.resolve("env:lower_case")).reveal()).toBe(RAW);
  });

  test("whitespace-only values are empty", async () => {
    const blank = createDefaultSecretStore({ env: { BLANK: "  \t " } });
    await expect(blank.resolve("env:BLANK")).rejects.toMatchObject({ code: "secret.empty" });
    await expect(blank.resolve(`file:${join(dir, "blank")}`)).rejects.toMatchObject({
      code: "secret.empty",
    });
    await expect(blank.resolve(`file:${join(dir, "newlines")}`)).rejects.toMatchObject({
      code: "secret.empty",
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

describe("all-caps token shapes", () => {
  const planted = [
    ["an AWS AKIA key id", AKIA],
    ["an AWS ASIA key id", ASIA],
    ["an AWS key id after a prefix", `PROD_${AKIA}`],
    ["a long all-caps string", LONG_CAPS],
    ["a 40-character random all-caps string", CAPS_40],
    ["a 33-character random all-caps string", CAPS_33],
    ["a 20-character unseparated all-caps string with digits", CAPS_20],
  ] as const;

  for (const [name, value] of planted) {
    test(`${name} is never displayed`, async () => {
      const ref = `env:${value}`;
      expect(displayRef(ref)).toBe(redactRef(ref));
      // Unset, then set but blank: both errors are redacted.
      for (const env of [{}, { [value]: " " }]) {
        const error = (await createDefaultSecretStore({ env })
          .resolve(ref)
          .catch((e: unknown) => e)) as SecretError;
        expect(error.ref).toBe(redactRef(ref));
        expect(error.message).not.toContain(value);
      }
      const report = await createDefaultSecretStore({ env: {} }).preflight([ref]);
      expect(JSON.stringify(report)).not.toContain(value);
    });
  }

  test("a short conventional name containing AKIA is still shown", () => {
    expect(displayRef("env:AKIA_KEY")).toBe("env:AKIA_KEY");
  });

  test("the length cap is 32 and inclusive", () => {
    expect(MAX_DISPLAYED_ENV_NAME_LENGTH).toBe(32);
    expect(CAPS_40).toHaveLength(40);
    expect(CAPS_33).toHaveLength(33);
    const at32 = "HEARTH_PROVIDER_ANTHROPIC_APIKEY";
    expect(at32).toHaveLength(32);
    expect(displayRef(`env:${at32}`)).toBe(`env:${at32}`);
  });

  test("conventional names are still shown", () => {
    for (const name of [
      "DATABASE_URL",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "OPENAI_API_KEY",
      "HEARTH_TOKEN",
      "PG_HOST_2",
      "S3_BUCKET",
      "HTTPS_PROXY",
      "NODEJSVERSION",
    ]) {
      expect(displayRef(`env:${name}`)).toBe(`env:${name}`);
    }
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

  test("invalidate drops the cached value", async () => {
    const values: Record<string, string> = { a: "old" };
    const { resolver, state } = gatedResolver(values);
    const store = new ResolvingSecretStore({ resolvers: [resolver] });
    await store.resolve("test:a");
    values["a"] = "new";
    store.invalidate("test:a");
    expect((await store.resolve("test:a")).reveal()).toBe("new");
    expect(state.calls).toBe(2);
  });

  test("a read started before invalidate does not populate the cache after it", async () => {
    const values: Record<string, string> = { a: "old" };
    const { resolver, state, hold } = gatedResolver(values);
    const store = new ResolvingSecretStore({ resolvers: [resolver] });
    hold();
    const racing = store.resolve("test:a");
    expect(state.calls).toBe(1);
    store.invalidate();
    values["a"] = "new";
    state.release();
    // The racing caller still gets the value it read...
    expect((await racing).reveal()).toBe("old");
    // ...but the next lookup reads again instead of reusing it.
    expect((await store.resolve("test:a")).reveal()).toBe("new");
    expect(state.calls).toBe(2);
  });

  test("a resolve after invalidate() with no ref does not join the read in flight", async () => {
    const values: Record<string, string> = { a: "old" };
    const { resolver, state, hold } = gatedResolver(values);
    const store = new ResolvingSecretStore({ resolvers: [resolver] });
    hold();
    const stale = store.resolve("test:a");
    store.invalidate();
    values["a"] = "rotated";
    const fresh = store.resolve("test:a");
    expect(fresh).not.toBe(stale);
    state.release();
    expect((await stale).reveal()).toBe("old");
    expect((await fresh).reveal()).toBe("rotated");
    expect(state.calls).toBe(2);
  });

  test("a resolve after invalidate(ref) does not join the read in flight", async () => {
    const values: Record<string, string> = { a: "old" };
    const { resolver, state, hold } = gatedResolver(values);
    const store = new ResolvingSecretStore({ resolvers: [resolver] });
    hold();
    const stale = store.resolve("test:a");
    store.invalidate("test:a");
    values["a"] = "rotated";
    const fresh = store.resolve("test:a");
    expect(fresh).not.toBe(stale);
    state.release();
    expect((await stale).reveal()).toBe("old");
    expect((await fresh).reveal()).toBe("rotated");
    expect(state.calls).toBe(2);
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

  test("a raw value pasted after a known scheme never reaches the report", async () => {
    const store = createDefaultSecretStore({ env: {} });
    const pasted = [`env:${RAW}`, `file:${RAW}`, `file:../${RAW}`];
    const report = await store.preflight(pasted);
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.failures.map((f) => f.code)).toEqual(pasted.map(() => "secret.malformed-ref"));
    expect(report.failures.map((f) => f.ref)).toEqual(pasted.map((ref) => redactRef(ref)));
    expect(JSON.stringify(report)).not.toContain(RAW);
  });

  test("a token-shaped env: reference never reaches the report", async () => {
    const store = createDefaultSecretStore({ env: { [`${GHP}_EMPTY`]: "" } });
    const pasted = [`env:${GHP}`, `env:${GHP}_EMPTY`];
    const report = await store.preflight(pasted);
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.failures.map((f) => f.code)).toEqual(["secret.not-found", "secret.empty"]);
    expect(report.failures.map((f) => f.ref)).toEqual(pasted.map((ref) => redactRef(ref)));
    expect(JSON.stringify(report)).not.toContain(GHP);
  });

  test("a resolver failure on a token-shaped reference does not show the reference", async () => {
    const broken: SecretResolver = {
      scheme: "env",
      resolve: async () => {
        throw new Error("boom");
      },
    };
    const store = new ResolvingSecretStore({ resolvers: [broken] });
    const ref = `env:${GHP}`;
    // The resolver-failed SecretError in the store's read.
    const error = (await store.resolve(ref).catch((e: unknown) => e)) as SecretError;
    expect(error.code).toBe("secret.unreadable");
    expect(error.ref).toBe(redactRef(ref));
    expect(error.message).toBe(`Secret ${redactRef(ref)}: resolver failed`);
    expect(error.message).not.toContain(GHP);
  });

  test("a non-SecretError from the read does not show a token-shaped reference", async () => {
    // A resolver returning a non-string makes the store's own `trim` throw a
    // TypeError, which reaches the preflight fallback.
    const broken: SecretResolver = {
      scheme: "env",
      resolve: async () => undefined as unknown as string,
    };
    const store = new ResolvingSecretStore({ resolvers: [broken] });
    const ref = `env:${GHP}`;
    const report = await store.preflight([ref]);
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.failures[0]?.ref).toBe(redactRef(ref));
    expect(report.failures[0]?.message).toBe(`Secret ${redactRef(ref)}: lookup failed`);
    expect(JSON.stringify(report)).not.toContain(GHP);
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
