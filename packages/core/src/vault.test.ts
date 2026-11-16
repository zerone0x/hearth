import { describe, expect, test } from "bun:test";
import { createDefaultSecretStore, displayRef, parseVaultRefBody, SecretError } from "./secrets";
import {
  canonicalPolicy,
  type EntryBinding,
  entryAad,
  generateDataKey,
  MasterKeyProvider,
  openEntry,
  parseMasterKey,
  sealEntry,
  VaultCryptoError,
  VaultSecretResolver,
} from "./vault";

const masterA = new Uint8Array(32).fill(7);
const masterB = new Uint8Array(32).fill(9);

const login: EntryBinding = {
  id: "sec_a",
  workspaceId: "ws_default",
  name: "github",
  kind: "login",
  version: 1,
  scopeSessionId: null,
  policyJson: canonicalPolicy("login", { origins: ["https://github.com"] }),
};
const fields = { username: "octo-vault-user", password: "pw-vault-test-77f3" };

async function rejectsCorrupt(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VaultCryptoError);
  expect((error as VaultCryptoError).code).toBe("vault.entry-corrupt");
  // The message names the entry, never a value.
  expect(String((error as Error).message)).not.toContain(fields.password);
}

describe("vault crypto", () => {
  test("AES-GCM round trip under a data key wrapped by the master key", async () => {
    const keys = await MasterKeyProvider.fromBytes(masterA);
    const dek = await generateDataKey();
    const wrapped = await keys.wrap(dek);
    // RFC 3394 adds 8 bytes to the 32-byte key.
    expect(wrapped.length).toBe(40);
    const unwrapped = await keys.unwrap(wrapped);
    const sealed = await sealEntry(dek, login, fields);
    expect(sealed.iv.length).toBe(12);
    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain(fields.password);
    expect(await openEntry(unwrapped, login, sealed)).toEqual(fields);
  });

  test("each seal uses a fresh IV", async () => {
    const dek = await generateDataKey();
    const one = await sealEntry(dek, login, fields);
    const two = await sealEntry(dek, login, fields);
    expect(Buffer.from(one.iv).equals(Buffer.from(two.iv))).toBe(false);
  });

  test("a wrong master key does not unwrap the data key", async () => {
    const a = await MasterKeyProvider.fromBytes(masterA);
    const b = await MasterKeyProvider.fromBytes(masterB);
    const wrapped = await a.wrap(await generateDataKey());
    await rejectsCorrupt(b.unwrap(wrapped));
    expect(a.kekCheck).not.toBe(b.kekCheck);
  });

  test("a wrong data key does not decrypt", async () => {
    const sealed = await sealEntry(await generateDataKey(), login, fields);
    await rejectsCorrupt(openEntry(await generateDataKey(), login, sealed));
  });

  test("a flipped ciphertext bit, a changed IV or a truncated tag is rejected", async () => {
    const dek = await generateDataKey();
    const sealed = await sealEntry(dek, login, fields);
    const flipped = new Uint8Array(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    await rejectsCorrupt(openEntry(dek, login, { ...sealed, ciphertext: flipped }));
    const iv = new Uint8Array(sealed.iv);
    iv[11] = (iv[11] ?? 0) ^ 1;
    await rejectsCorrupt(openEntry(dek, login, { ...sealed, iv }));
    await rejectsCorrupt(
      openEntry(dek, login, { ...sealed, ciphertext: sealed.ciphertext.slice(0, -1) }),
    );
  });

  const edits: [string, Partial<EntryBinding>][] = [
    ["id (a row swap)", { id: "sec_b" }],
    ["workspace", { workspaceId: "ws_other" }],
    ["name", { name: "gitlab" }],
    ["kind", { kind: "token" }],
    ["version (a rollback)", { version: 2 }],
    ["scope", { scopeSessionId: "ses_1" }],
    [
      "policy (a new origin)",
      {
        policyJson: canonicalPolicy("login", {
          origins: ["https://github.com", "https://evil.example"],
        }),
      },
    ],
    [
      "policy (allow_any_field)",
      {
        policyJson: canonicalPolicy("login", {
          origins: ["https://github.com"],
          allow_any_field: true,
        }),
      },
    ],
  ];
  for (const [what, edit] of edits) {
    test(`AAD: a changed ${what} does not decrypt`, async () => {
      const dek = await generateDataKey();
      const sealed = await sealEntry(dek, login, fields);
      await rejectsCorrupt(openEntry(dek, { ...login, ...edit }, sealed));
    });
  }

  test("the AAD lists every bound field and hashes the policy", async () => {
    const aad = new TextDecoder().decode(await entryAad({ ...login, scopeSessionId: "ses_9" }));
    const parts = aad.split("|");
    expect(parts.slice(0, 7)).toEqual([
      "hearth-vault/v1",
      "sec_a",
      "ws_default",
      "github",
      "login",
      "1",
      "ses_9",
    ]);
    expect(parts[7]).toMatch(/^[0-9a-f]{64}$/);
    await expect(entryAad({ ...login, name: "a|b" })).rejects.toThrow("must not contain |");
  });

  test("fingerprints are keyed by the master key, not plain SHA-256", async () => {
    const a = await MasterKeyProvider.fromBytes(masterA);
    const b = await MasterKeyProvider.fromBytes(masterB);
    const fa = await a.fingerprint(fields.password);
    expect(fa).toMatch(/^hmac:[0-9a-f]{12}$/);
    expect(await a.fingerprint(fields.password)).toBe(fa);
    expect(await b.fingerprint(fields.password)).not.toBe(fa);
    const sha = new Bun.CryptoHasher("sha256").update(fields.password).digest("hex");
    expect(fa.slice(5)).not.toBe(sha.slice(0, 12));
  });

  test("subkeys differ by purpose: kek_check is not the fingerprint of the check message", async () => {
    const a = await MasterKeyProvider.fromBytes(masterA);
    expect(a.kekCheck).toMatch(/^[0-9a-f]{64}$/);
    const fp = await a.fingerprint("hearth-vault/v1 kek-check");
    expect(a.kekCheck.startsWith(fp.slice(5))).toBe(false);
  });
});

describe("master key text", () => {
  test("the base64 of exactly 32 bytes, with a trailing newline, parses", () => {
    const text = `${Buffer.from(masterA).toString("base64")}\n`;
    expect(parseMasterKey(text)).toEqual(masterA);
  });
  test("other lengths, raw bytes and junk are invalid", () => {
    expect(parseMasterKey(Buffer.alloc(31, 1).toString("base64"))).toBeUndefined();
    expect(parseMasterKey(Buffer.alloc(33, 1).toString("base64"))).toBeUndefined();
    expect(parseMasterKey("not a key")).toBeUndefined();
    expect(parseMasterKey("")).toBeUndefined();
    expect(parseMasterKey(Buffer.alloc(32, 200).toString("latin1"))).toBeUndefined();
  });
});

describe("canonical policy", () => {
  test("origins are lower-cased, sorted and unique; keys sorted", () => {
    expect(
      canonicalPolicy("login", {
        origins: ["https://B.example", "https://a.example", "https://b.example"],
      }),
    ).toBe('{"allow_any_field":false,"origins":["https://a.example","https://b.example"]}');
    expect(canonicalPolicy("token", { hosts: ["API.example.com"] })).toBe(
      '{"hosts":["api.example.com"],"use":"hub"}',
    );
    expect(canonicalPolicy("model-key", undefined)).toBe("{}");
  });
  test("a path, a non-http scheme, no origin or an unknown key is refused", () => {
    expect(() => canonicalPolicy("login", { origins: ["https://a.example/login"] })).toThrow();
    expect(() => canonicalPolicy("login", { origins: ["javascript:alert(1)"] })).toThrow();
    expect(() => canonicalPolicy("login", { origins: [] })).toThrow();
    expect(() => canonicalPolicy("login", { origins: ["https://a.example"], x: 1 })).toThrow();
    expect(() => canonicalPolicy("token", { use: "anywhere" })).toThrow();
    expect(() => canonicalPolicy("model-key", { origins: [] })).toThrow();
  });
});

describe("vault: references", () => {
  test("names and fields parse; anything else is not a vault ref", () => {
    expect(parseVaultRefBody("github")).toEqual({ name: "github" });
    expect(parseVaultRefBody("github#password")).toEqual({ name: "github", field: "password" });
    expect(parseVaultRefBody("GitHub")).toBeUndefined();
    expect(parseVaultRefBody("sk-ant-AbC123")).toBeUndefined();
    expect(parseVaultRefBody("a#")).toBeUndefined();
  });
  test("displayRef shows a vault name, and only a fingerprint for anything else", () => {
    expect(displayRef("vault:github#password")).toBe("vault:github#password");
    expect(displayRef("vault:sk-ant-AbC123")).toMatch(/^<unrecognized reference sha256:/);
  });

  test("the store never caches vault: values: every resolve reaches the vault", async () => {
    const calls: string[] = [];
    const store = createDefaultSecretStore({
      env: { PLAIN: "plain-value" },
      resolvers: [
        new VaultSecretResolver({
          async readForHub(name, field) {
            calls.push(`${name}#${field ?? ""}`);
            return `value-${calls.length}`;
          },
        }),
      ],
    });
    expect((await store.resolve("vault:model#value")).reveal()).toBe("value-1");
    expect((await store.resolve("vault:model#value")).reveal()).toBe("value-2");
    expect(calls).toEqual(["model#value", "model#value"]);
    expect((await store.resolve("env:PLAIN")).reveal()).toBe("plain-value");
  });

  test("a malformed vault: body is refused without reaching the vault, shown by fingerprint", async () => {
    let reached = false;
    const store = createDefaultSecretStore({
      resolvers: [
        new VaultSecretResolver({
          async readForHub() {
            reached = true;
            return "x";
          },
        }),
      ],
    });
    const error = await store.resolve("vault:sk-PASTED-Key").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretError);
    expect((error as SecretError).code).toBe("secret.malformed-ref");
    expect((error as SecretError).message).not.toContain("PASTED");
    expect(reached).toBe(false);
  });
});
