/**
 * The vault (PRD §6.10, decision 0031, research `docs/research/vault.md`):
 * the crypto of a vault entry and the extension points of the store. No I/O
 * and no SQLite here (AGENTS.md, boundary rules): the hub's SQLite store
 * implements `VaultEntryBackend`, and `MasterKeyProvider` is the key file.
 *
 * Every primitive is WebCrypto (`crypto.subtle`, built into Bun): AES-256-GCM
 * for entries, AES-KW (RFC 3394) to wrap the data key, HKDF-SHA256 to derive
 * subkeys from the master key, HMAC-SHA256 for `kek_check` and fingerprints.
 * Nothing is hand-rolled.
 */

import { HearthError } from "./failure";
import type { EpochMs, SessionId, WorkspaceId } from "./ids";
import {
  displayRef,
  parseVaultRefBody,
  redactRef,
  type SecretRef,
  type SecretResolver,
  SecretError,
  type SecretErrorCode,
} from "./secrets";

/** Length of the master key in bytes (AES-256). */
export const VAULT_KEY_BYTES = 32;

/** HKDF `info` of each subkey, and the message `kek_check` signs. One key per purpose. */
export const VAULT_INFO = {
  kek: "hearth-vault/v1 kek",
  kekCheck: "hearth-vault/v1 kek-check",
  fingerprint: "hearth-vault/v1 fingerprint",
} as const;

/** The first field of every entry's AAD. */
export const VAULT_AAD_PREFIX = "hearth-vault/v1";

/** How many hex digits of a `kek_check` or a fingerprint are shown. */
export const VAULT_DISPLAY_HEX = 12;

export const VAULT_KINDS = ["model-key", "login", "token"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

/**
 * The encrypted fields of each kind and the one a bare `vault:<name>` names.
 * TOTP seeds (`#totp`) are a later issue; until then a login has a username
 * and a password.
 */
export const VAULT_FIELDS: Readonly<
  Record<VaultKind, { readonly fields: readonly string[]; readonly primary: string }>
> = {
  "model-key": { fields: ["value"], primary: "value" },
  login: { fields: ["username", "password"], primary: "password" },
  token: { fields: ["value"], primary: "value" },
};

/** A login's policy: the exact origins it may be filled on. */
export interface LoginPolicy {
  readonly origins: readonly string[];
  readonly allow_any_field: boolean;
}

/** A token's policy: where its value may go. */
export interface TokenPolicy {
  readonly use: "hub" | "box-env";
  readonly hosts: readonly string[];
}

export type VaultPolicy = LoginPolicy | TokenPolicy | Record<string, never>;

/** Longest accepted field value, in UTF-16 code units. */
export const MAX_VAULT_FIELD_CHARS = 16_384;

function invalid(message: string): HearthError {
  return new HearthError(message, { owner: "user", disposition: "give-up", code: "request.invalid" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw invalid(`${what} must be a list of strings`);
  }
  return value as string[];
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw invalid(`unknown ${what} field ${JSON.stringify(key)}`);
  }
}

/** An `http(s)` origin, lower-cased, exactly as `URL.origin` prints it. */
function canonicalOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.toLowerCase());
  } catch {
    throw invalid(`origin ${JSON.stringify(raw)} is not a URL origin`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== raw.toLowerCase()) {
    throw invalid(`origin ${JSON.stringify(raw)} must be scheme://host[:port] with http or https`);
  }
  return url.origin;
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The canonical JSON of an entry's policy: known keys only, sorted keys,
 * origins and hosts lower-cased, sorted and unique. Its SHA-256 is in the AAD,
 * so the same policy always hashes the same and any edit of the stored JSON
 * fails to decrypt.
 */
export function canonicalPolicy(kind: VaultKind, input: unknown): string {
  const policy = input ?? {};
  if (!isRecord(policy)) throw invalid("policy must be a JSON object");
  switch (kind) {
    case "model-key":
      onlyKeys(policy, [], "model-key policy");
      return "{}";
    case "login": {
      onlyKeys(policy, ["origins", "allow_any_field"], "login policy");
      const origins = [...new Set(stringList(policy["origins"], "origins").map(canonicalOrigin))];
      if (origins.length === 0) throw invalid("a login needs at least one origin");
      const any = policy["allow_any_field"] ?? false;
      if (typeof any !== "boolean") throw invalid("allow_any_field must be true or false");
      return JSON.stringify({ allow_any_field: any, origins: origins.sort() });
    }
    case "token": {
      onlyKeys(policy, ["use", "hosts"], "token policy");
      const use = policy["use"] ?? "hub";
      if (use !== "hub" && use !== "box-env") throw invalid('use must be "hub" or "box-env"');
      const hosts = stringList(policy["hosts"], "hosts").map((h) => h.toLowerCase());
      for (const host of hosts) {
        if (!HOST_NAME.test(host)) throw invalid(`host ${JSON.stringify(host)} is not a host name`);
      }
      return JSON.stringify({ hosts: [...new Set(hosts)].sort(), use });
    }
  }
}

/** The fields of one entry that its AAD binds. */
export interface EntryBinding {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly kind: VaultKind;
  readonly version: number;
  /** `null` for a global entry. */
  readonly scopeSessionId: SessionId | null;
  /** As stored: `canonicalPolicy` output. */
  readonly policyJson: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function hex(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * `hearth-vault/v1|<id>|<workspace>|<name>|<kind>|<version>|<scope or "">|<SHA-256 hex of policy_json>`.
 * A component holding `|` would make two bindings print alike, so it is refused.
 */
export async function entryAad(binding: EntryBinding): Promise<Uint8Array<ArrayBuffer>> {
  const parts = [
    binding.id,
    binding.workspaceId,
    binding.name,
    binding.kind,
    String(binding.version),
    binding.scopeSessionId ?? "",
  ];
  if (parts.some((part) => part.includes("|"))) {
    throw new Error("a vault entry's id, workspace, name and scope must not contain |");
  }
  if (!Number.isSafeInteger(binding.version) || binding.version < 1) {
    throw new Error("a vault entry's version is a positive integer");
  }
  const policyHash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(binding.policyJson)));
  return encoder.encode([VAULT_AAD_PREFIX, ...parts, policyHash].join("|"));
}

/** A ciphertext that does not open: wrong key, edited ciphertext, IV or bound field. */
export class VaultCryptoError extends HearthError {
  constructor(message: string) {
    super(message, { owner: "hub", disposition: "give-up", code: "vault.entry-corrupt" });
    this.name = "VaultCryptoError";
  }
}

/** Base64 of exactly `VAULT_KEY_BYTES` bytes, with or without its padding. */
const MASTER_KEY_TEXT = /^[A-Za-z0-9+/]{43}=?$/;

/**
 * The master key from its text form: the base64 of 32 random bytes, as the
 * `install:vault-key` step writes it (one trailing newline is dropped by the
 * `file:` resolver). Undefined when it is anything else.
 */
export function parseMasterKey(text: string): Uint8Array<ArrayBuffer> | undefined {
  const trimmed = text.trim();
  if (!MASTER_KEY_TEXT.test(trimmed)) return undefined;
  const bytes = new Uint8Array(Buffer.from(trimmed, "base64"));
  return bytes.length === VAULT_KEY_BYTES ? bytes : undefined;
}

/**
 * E7 extension (PRD §7): who holds the key that wraps the vault's data key.
 * The personal edition's provider is the key file (`MasterKeyProvider`); an
 * OpenBao transit provider can implement the same interface later.
 */
export interface VaultKeyProvider {
  /** Stored in `vault_key.provider`: `file` now. */
  readonly provider: string;
  /** HMAC of a fixed message under a subkey: tells a wrong key from a corrupt store. Hex. */
  readonly kekCheck: string;
  wrap(dataKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>>;
  /** Rejects with `VaultCryptoError` when the wrapped key does not open under this key. */
  unwrap(wrapped: Uint8Array<ArrayBuffer>): Promise<CryptoKey>;
  /** `hmac:` and 12 hex digits of a keyed HMAC: stable across data-key rotations. */
  fingerprint(value: string): Promise<string>;
}

/** The key file: three HKDF-SHA256 subkeys of one 32-byte master key. */
export class MasterKeyProvider implements VaultKeyProvider {
  readonly provider = "file";
  readonly kekCheck: string;
  readonly #kek: CryptoKey;
  readonly #fingerprintKey: CryptoKey;

  private constructor(kekCheck: string, kek: CryptoKey, fingerprintKey: CryptoKey) {
    this.kekCheck = kekCheck;
    this.#kek = kek;
    this.#fingerprintKey = fingerprintKey;
  }

  static async fromBytes(master: Uint8Array<ArrayBuffer>): Promise<MasterKeyProvider> {
    if (master.length !== VAULT_KEY_BYTES) {
      throw new Error(`a vault master key is ${VAULT_KEY_BYTES} bytes`);
    }
    const base = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
    const hkdf = (info: string) => ({
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(info),
    });
    const hmac = { name: "HMAC", hash: "SHA-256", length: 256 } as const;
    const kek = await crypto.subtle.deriveKey(
      hkdf(VAULT_INFO.kek),
      base,
      { name: "AES-KW", length: 256 },
      false,
      ["wrapKey", "unwrapKey"],
    );
    const checkKey = await crypto.subtle.deriveKey(hkdf(VAULT_INFO.kekCheck), base, hmac, false, [
      "sign",
    ]);
    const fingerprintKey = await crypto.subtle.deriveKey(
      hkdf(VAULT_INFO.fingerprint),
      base,
      hmac,
      false,
      ["sign"],
    );
    const check = await crypto.subtle.sign("HMAC", checkKey, encoder.encode(VAULT_INFO.kekCheck));
    return new MasterKeyProvider(hex(check), kek, fingerprintKey);
  }

  async wrap(dataKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.wrapKey("raw", dataKey, this.#kek, "AES-KW"));
  }

  async unwrap(wrapped: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    try {
      // Extractable, so a master-key rotation can wrap the same data key again.
      return await crypto.subtle.unwrapKey(
        "raw",
        wrapped,
        this.#kek,
        "AES-KW",
        { name: "AES-GCM" },
        true,
        ["encrypt", "decrypt"],
      );
    } catch {
      throw new VaultCryptoError("the vault's data key does not unwrap under this key");
    }
  }

  async fingerprint(value: string): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", this.#fingerprintKey, encoder.encode(value));
    return `hmac:${hex(mac).slice(0, VAULT_DISPLAY_HEX)}`;
  }
}

/** A fresh random AES-256-GCM data key (extractable only so it can be wrapped). */
export function generateDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]) as Promise<CryptoKey>;
}

/** An encrypted entry: a fresh 96-bit IV and the AES-GCM ciphertext (tag included). */
export interface SealedEntry {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
}

/** Encrypt an entry's fields (JSON) under the data key, bound to `binding` through the AAD. */
export async function sealEntry(
  dataKey: CryptoKey,
  binding: EntryBinding,
  fields: Readonly<Record<string, string>>,
): Promise<SealedEntry> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: await entryAad(binding), tagLength: 128 },
    dataKey,
    encoder.encode(JSON.stringify(fields)),
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * Decrypt an entry. Rejects with `VaultCryptoError` (`vault.entry-corrupt`)
 * when the data key, the ciphertext, the IV or any bound field differs from
 * what it was sealed with. The message never contains a value.
 */
export async function openEntry(
  dataKey: CryptoKey,
  binding: EntryBinding,
  sealed: SealedEntry,
): Promise<Record<string, string>> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: sealed.iv,
        additionalData: await entryAad(binding),
        tagLength: 128,
      },
      dataKey,
      sealed.ciphertext,
    );
  } catch {
    throw new VaultCryptoError(`vault entry ${binding.name} does not decrypt: corrupt or moved`);
  }
  const parsed: unknown = JSON.parse(decoder.decode(plain));
  if (!isRecord(parsed) || Object.values(parsed).some((v) => typeof v !== "string")) {
    throw new VaultCryptoError(`vault entry ${binding.name} holds no fields`);
  }
  return parsed as Record<string, string>;
}

/**
 * Check an entry's fields for its kind: exactly the kind's fields, each a
 * non-blank string of at most `MAX_VAULT_FIELD_CHARS`.
 */
export function checkEntryFields(kind: VaultKind, input: unknown): Record<string, string> {
  if (!isRecord(input)) throw invalid("fields must be a JSON object");
  const { fields } = VAULT_FIELDS[kind];
  onlyKeys(input, fields, `${kind}`);
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw invalid(`fields.${field} must be a non-empty string`);
    }
    if (value.length > MAX_VAULT_FIELD_CHARS) {
      throw invalid(`fields.${field} is longer than ${MAX_VAULT_FIELD_CHARS} characters`);
    }
    out[field] = value;
  }
  return out;
}

/** One stored entry, as the backend keeps it. `fingerprint` is of the primary field. */
export interface VaultEntryRecord extends EntryBinding {
  readonly metaJson: string;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly fingerprint: string;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
  readonly lastUsedAt: EpochMs | null;
}

/** The one wrapped data key of a hub. */
export interface VaultKeyRecord {
  readonly wrappedDek: Uint8Array<ArrayBuffer>;
  readonly kekCheck: string;
  readonly provider: string;
  readonly createdAt: EpochMs;
  readonly rotatedAt: EpochMs | null;
}

/**
 * E7 extension (PRD §7): where entries live. SQLite in the hub now
 * (`SqliteVaultStore`); OpenBao KV v2 later. Each multi-row change is one
 * transaction: a crash leaves the store before or after it.
 */
export interface VaultEntryBackend {
  keyRecord(): VaultKeyRecord | undefined;
  /** Store the first data key. Returns false when one is already there. */
  insertKeyRecord(record: VaultKeyRecord): boolean;
  list(workspaceId: WorkspaceId): VaultEntryRecord[];
  byName(workspaceId: WorkspaceId, name: string): VaultEntryRecord | undefined;
  byId(workspaceId: WorkspaceId, id: string): VaultEntryRecord | undefined;
  /** Rejects with `secret.name-taken` when the name is in use. */
  insert(entry: VaultEntryRecord): void;
  /** Replace ciphertext, IV, fingerprint and version if the row is still at `fromVersion`. */
  replaceValue(
    workspaceId: WorkspaceId,
    id: string,
    fromVersion: number,
    next: Pick<VaultEntryRecord, "iv" | "ciphertext" | "fingerprint" | "version" | "updatedAt">,
  ): boolean;
  remove(workspaceId: WorkspaceId, id: string): boolean;
  touch(workspaceId: WorkspaceId, id: string, at: EpochMs): void;
  /** Master-key rotation: new wrapped key, `kek_check` and every fingerprint, at once. */
  rewrap(
    key: Pick<VaultKeyRecord, "wrappedDek" | "kekCheck" | "rotatedAt">,
    fingerprints: ReadonlyMap<string, string>,
  ): void;
  /** Data-key rotation: new wrapped key and every entry's IV and ciphertext, at once. */
  reencrypt(
    key: Pick<VaultKeyRecord, "wrappedDek" | "rotatedAt">,
    entries: ReadonlyMap<string, SealedEntry>,
  ): void;
}

/** What the `vault:` resolver asks of the vault. */
export interface VaultReader {
  /**
   * The value of `vault:<name>[#field]` for a hub-side use with no session or
   * tool call (the model key, a hub token). Audits the use before it returns.
   * Rejects with a `SecretError` whose message contains no value.
   */
  readForHub(name: string, field: string | undefined, ref: SecretRef): Promise<string>;
}

/**
 * `vault:<name>[#field]` (E7). Not cached by the store: every resolve reaches
 * the vault, which decrypts (checking the AAD) and audits each use.
 */
export class VaultSecretResolver implements SecretResolver {
  readonly scheme = "vault";
  readonly cacheable = false;
  readonly #vault: VaultReader;

  constructor(vault: VaultReader) {
    this.#vault = vault;
  }

  async resolve(body: string, ref: SecretRef): Promise<string> {
    const parsed = parseVaultRefBody(body);
    if (parsed === undefined) {
      const shown = redactRef(ref);
      throw new SecretError(
        shown,
        "secret.malformed-ref",
        `Malformed secret reference ${shown}: vault: expects a name, e.g. vault:github#password`,
      );
    }
    return this.#vault.readForHub(parsed.name, parsed.field, ref);
  }
}

/** A `SecretError` for a vault failure, naming the reference as `displayRef` shows it. */
export function vaultSecretError(
  ref: SecretRef,
  code: SecretErrorCode,
  problem: string,
): SecretError {
  const shown = displayRef(ref);
  return new SecretError(shown, code, `Secret ${shown}: ${problem}`);
}
