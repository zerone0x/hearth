/**
 * E7 SecretStore (PRD §7, §10). Configuration holds secret *references* such
 * as `env:BIFROST_ADMIN_KEY` or `file:/run/secrets/telegram`, resolved at use
 * with a short cache. Logs, errors and the UI show references and
 * fingerprints, never values.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { HearthError } from "./failure";
import type { EpochMs } from "./ids";

/** A reference such as `env:NAME` or `file:/abs/path`. References are not secret. */
export type SecretRef = string;

export interface ParsedSecretRef {
  readonly scheme: string;
  /** Everything after the first `:`. */
  readonly body: string;
}

export type SecretErrorCode =
  | "secret.malformed-ref"
  | "secret.unknown-scheme"
  | "secret.not-found"
  | "secret.unreadable"
  | "secret.empty";

/**
 * How a reference appears in messages. A reference that does not parse, names
 * an unknown scheme, has a body its scheme rejects (`env:` not followed by a
 * variable name, `file:` not followed by an absolute path), or is an `env:`
 * reference whose name is not conventional or is token-shaped (see `displayRef`) may be a raw
 * secret pasted where a reference belongs, so it is shown only as a fingerprint.
 */
export function redactRef(ref: SecretRef): string {
  return `<unrecognized reference ${fingerprint(ref)}>`;
}

/** `scheme:body`; the scheme is lowercase letters, digits and `-`. */
const SECRET_REF = /^([a-z][a-z0-9-]*):(.+)$/s;

/**
 * The longest `env:` name shown as written. Real variable names are short; a
 * longer all-caps name is more likely a pasted high-entropy token.
 */
export const MAX_DISPLAYED_ENV_NAME_LENGTH = 40;

/**
 * The `env:` names shown as written: uppercase letters, digits and `_`, at most
 * `MAX_DISPLAYED_ENV_NAME_LENGTH` characters. A lowercase or mixed-case name is
 * still looked up, but a token made of `[A-Za-z0-9_]` (e.g. `ghp_…`) pasted
 * after `env:` also matches the lookup pattern, so anything unconventional is
 * shown only by fingerprint.
 */
const CONVENTIONAL_ENV_NAME = new RegExp(
  `^[A-Z_][A-Z0-9_]{0,${MAX_DISPLAYED_ENV_NAME_LENGTH - 1}}$`,
);

/**
 * A known all-caps token shape: an AWS access key id (`AKIA`/`ASIA` plus 16
 * characters), alone or after an `_`. It fits the conventional pattern and the
 * length cap, so it is excluded explicitly.
 */
const AWS_KEY_ID = /(?:^|_)(?:AKIA|ASIA)[A-Z0-9]{16}/;

/**
 * How a reference appears in messages and in `SecretError.ref`: as written when
 * it parses and its body is safe to show, otherwise `redactRef(ref)`. An `env:`
 * body is safe only when it looks like a conventional variable name.
 */
export function displayRef(ref: SecretRef): string {
  const match = SECRET_REF.exec(ref);
  if (!match?.[1] || !match[2]) return redactRef(ref);
  if (match[1] === "env") {
    const name = match[2];
    if (!CONVENTIONAL_ENV_NAME.test(name) || AWS_KEY_ID.test(name)) return redactRef(ref);
  }
  return ref;
}

/**
 * A failed lookup. The message names the reference (or, for an unrecognized
 * one, its fingerprint), never the value.
 */
export class SecretError extends HearthError {
  /** The reference as it may be displayed: `displayRef` of the reference. */
  readonly ref: string;
  declare readonly code: SecretErrorCode;

  constructor(ref: string, code: SecretErrorCode, message: string) {
    // A missing or bad secret is a configuration problem: the user fixes it.
    super(message, { owner: "user", disposition: "give-up", code });
    this.name = "SecretError";
    this.ref = ref;
  }
}

/** Split `scheme:body`. The scheme is lowercase letters, digits and `-`. */
export function parseSecretRef(ref: SecretRef): ParsedSecretRef {
  const match = SECRET_REF.exec(ref);
  if (!match?.[1] || !match[2]) {
    const shown = redactRef(ref);
    throw new SecretError(
      shown,
      "secret.malformed-ref",
      `Malformed secret reference ${shown}: expected scheme:value, e.g. env:NAME`,
    );
  }
  return { scheme: match[1], body: match[2] };
}

const FINGERPRINT_HEX_CHARS = 12;

/**
 * A display-safe fingerprint: `sha256:` plus the first 12 hex characters of the
 * SHA-256 of the value. Enough to tell two values apart or confirm a rotation,
 * not enough to recover the value.
 */
export function fingerprint(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `sha256:${hex.slice(0, FINGERPRINT_HEX_CHARS)}`;
}

/**
 * A resolved secret. The value is only available through `reveal()`; string
 * conversion, JSON and inspection show the fingerprint, so a secret passed to a
 * logger by mistake does not leak.
 */
export class SecretValue {
  readonly #value: string;
  readonly fingerprint: string;

  constructor(value: string) {
    this.#value = value;
    this.fingerprint = fingerprint(value);
  }

  /** The raw value. Call it at the last moment, where the value is used. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `[secret ${this.fingerprint}]`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/**
 * Resolves the body of one reference scheme. Implementations touch the
 * underlying system (environment, filesystem, later Vault or a KMS); nothing
 * else does.
 *
 * Called only by a `SecretStore`. Guarantees: returns the raw value, possibly
 * empty (the store rejects values that are empty after trimming); throws a
 * `SecretError` on failure, with a message that contains no secret value. A
 * body that fails the scheme's validation is reported with `redactRef`; any
 * other failure shows the reference as `displayRef(ref)`.
 */
export interface SecretResolver {
  /** The scheme handled, without the colon, e.g. `env`. */
  readonly scheme: string;
  resolve(body: string, ref: SecretRef): Promise<string>;
}

/** A well-formed `env:` body: a portable environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * A reference whose body fails its scheme's validation. Such a body may be a
 * raw secret pasted after a known scheme, so only the fingerprint is shown.
 */
function malformedBody(ref: SecretRef, expected: string): SecretError {
  const shown = redactRef(ref);
  return new SecretError(
    shown,
    "secret.malformed-ref",
    `Malformed secret reference ${shown}: ${expected}`,
  );
}

/** `env:NAME`: reads a variable from the given environment (default `process.env`). */
export class EnvSecretResolver implements SecretResolver {
  readonly scheme = "env";
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    this.#env = env;
  }

  async resolve(body: string, ref: SecretRef): Promise<string> {
    if (!ENV_NAME.test(body)) {
      // Not a variable name, so possibly a raw secret pasted after `env:`.
      throw malformedBody(ref, "env: expects a variable name");
    }
    const value = this.#env[body];
    if (value === undefined) {
      const shown = displayRef(ref);
      // Name the variable only when the reference itself is shown as written.
      const variable = shown === ref ? `variable ${body}` : "variable";
      throw new SecretError(shown, "secret.not-found", `Secret ${shown}: ${variable} is not set`);
    }
    return value;
  }
}

/**
 * `file:/abs/path`: reads a file, dropping one trailing newline (as written by
 * `echo` or most editors). Relative paths are rejected so that a reference
 * means the same thing regardless of the working directory.
 */
export class FileSecretResolver implements SecretResolver {
  readonly scheme = "file";

  async resolve(body: string, ref: SecretRef): Promise<string> {
    if (!isAbsolute(body) || CONTROL_CHAR.test(body)) {
      // Not an absolute path, so possibly a raw secret pasted after `file:`.
      throw malformedBody(ref, "file: expects an absolute path");
    }
    let text: string;
    try {
      text = await readFile(body, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") {
        throw new SecretError(ref, "secret.not-found", `Secret ${ref}: file does not exist`);
      }
      // Only the error code is kept: an OS message never contains file contents,
      // but keeping the surface small is cheaper than auditing every case.
      throw new SecretError(
        ref,
        "secret.unreadable",
        `Secret ${ref}: file cannot be read (${typeof code === "string" ? code : "unknown error"})`,
      );
    }
    return text.replace(/\r?\n$/, "");
  }
}

export interface PreflightFailure {
  /** The reference as it may be displayed: `displayRef` of the reference. */
  readonly ref: string;
  readonly code: SecretErrorCode;
  /** Names the reference and the problem; never contains a value. */
  readonly message: string;
}

/** The answer of a preflight: every reference resolved, or the list of those that did not. */
export type PreflightReport =
  | { readonly ok: true; readonly checked: number }
  | {
      readonly ok: false;
      readonly checked: number;
      readonly failures: readonly PreflightFailure[];
    };

/**
 * E7: resolves secret references at use.
 *
 * Called by implementations of other extension points (the model gateway, the
 * Telegram channel, the join-token signer) at the moment they need a value, and
 * by hub startup through `preflight`. Guarantees:
 * - `resolve` returns a `SecretValue` that is not blank or rejects with a `SecretError`
 *   whose message names the reference, never the value.
 * - Values are cached for a short TTL; concurrent lookups of the same reference
 *   share one underlying read; `invalidate` detaches a read in flight. Failures
 *   are not cached.
 */
export interface SecretStore {
  resolve(ref: SecretRef): Promise<SecretValue>;
  /** The fingerprint of the current value, for logs and the settings UI. */
  fingerprint(ref: SecretRef): Promise<string>;
  /** Resolve every reference (bypassing the cache) and report each one that fails or is empty. */
  preflight(refs: readonly SecretRef[]): Promise<PreflightReport>;
  /** Drop a cached value (after a rotation), or every cached value when `ref` is omitted. */
  invalidate(ref?: SecretRef): void;
}

/**
 * How long a resolved value is reused. Short, so a rotated secret is picked up
 * within seconds, but long enough that a burst of requests reads it once.
 */
export const SECRET_CACHE_TTL_MS = 30_000;

export interface ResolvingSecretStoreOptions {
  readonly resolvers: readonly SecretResolver[];
  readonly ttlMs?: number;
  readonly now?: () => EpochMs;
}

interface CacheEntry {
  readonly value: SecretValue;
  readonly expiresAt: EpochMs;
}

/** v1 implementation of E7, over any set of scheme resolvers. */
export class ResolvingSecretStore implements SecretStore {
  readonly #resolvers: ReadonlyMap<string, SecretResolver>;
  readonly #ttlMs: number;
  readonly #now: () => EpochMs;
  readonly #cache = new Map<SecretRef, CacheEntry>();
  readonly #inFlight = new Map<SecretRef, Promise<SecretValue>>();
  /** Bumped by `invalidate`, so a read that started before it is not cached after it. */
  #generation = 0;

  constructor(options: ResolvingSecretStoreOptions) {
    const resolvers = new Map<string, SecretResolver>();
    for (const resolver of options.resolvers) {
      if (resolvers.has(resolver.scheme)) {
        throw new Error(`Two secret resolvers for scheme ${resolver.scheme}`);
      }
      resolvers.set(resolver.scheme, resolver);
    }
    this.#resolvers = resolvers;
    this.#ttlMs = options.ttlMs ?? SECRET_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  resolve(ref: SecretRef): Promise<SecretValue> {
    const cached = this.#cache.get(ref);
    if (cached && cached.expiresAt > this.#now()) {
      return Promise.resolve(cached.value);
    }
    const pending = this.#inFlight.get(ref);
    if (pending) {
      return pending;
    }
    const generation = this.#generation;
    const lookup = this.#read(ref)
      .then((value) => {
        if (generation === this.#generation) {
          this.#cache.set(ref, { value, expiresAt: this.#now() + this.#ttlMs });
        }
        return value;
      })
      .finally(() => {
        if (this.#inFlight.get(ref) === lookup) {
          this.#inFlight.delete(ref);
        }
      });
    this.#inFlight.set(ref, lookup);
    return lookup;
  }

  async fingerprint(ref: SecretRef): Promise<string> {
    return (await this.resolve(ref)).fingerprint;
  }

  async preflight(refs: readonly SecretRef[]): Promise<PreflightReport> {
    const unique = [...new Set(refs)];
    const results = await Promise.all(
      unique.map(async (ref): Promise<PreflightFailure | undefined> => {
        try {
          await this.#read(ref);
          return undefined;
        } catch (error) {
          if (error instanceof SecretError) {
            return { ref: error.ref, code: error.code, message: error.message };
          }
          const shown = displayRef(ref);
          return {
            ref: shown,
            code: "secret.unreadable",
            message: `Secret ${shown}: lookup failed`,
          };
        }
      }),
    );
    const failures = results.filter((failure) => failure !== undefined);
    return failures.length === 0
      ? { ok: true, checked: unique.length }
      : { ok: false, checked: unique.length, failures };
  }

  invalidate(ref?: SecretRef): void {
    this.#generation++;
    // Detach reads in flight too, so a resolve after this starts a fresh read
    // instead of joining one that may return the pre-rotation value.
    if (ref === undefined) {
      this.#cache.clear();
      this.#inFlight.clear();
    } else {
      this.#cache.delete(ref);
      this.#inFlight.delete(ref);
    }
  }

  async #read(ref: SecretRef): Promise<SecretValue> {
    const { scheme, body } = parseSecretRef(ref);
    const resolver = this.#resolvers.get(scheme);
    if (!resolver) {
      const known = [...this.#resolvers.keys()].join(", ") || "none";
      const unknown = redactRef(ref);
      throw new SecretError(
        unknown,
        "secret.unknown-scheme",
        `Secret ${unknown}: unknown scheme (known: ${known})`,
      );
    }
    const shown = displayRef(ref);
    let raw: string;
    try {
      raw = await resolver.resolve(body, ref);
    } catch (error) {
      if (error instanceof SecretError) throw error;
      // A resolver broke its contract by throwing something else. Its message
      // could contain anything, so it is not passed on.
      throw new SecretError(shown, "secret.unreadable", `Secret ${shown}: resolver failed`);
    }
    if (raw.trim().length === 0) {
      // Whitespace only is as useless as nothing, and usually a broken file.
      throw new SecretError(shown, "secret.empty", `Secret ${shown}: value is empty`);
    }
    return new SecretValue(raw);
  }
}

/** The personal-edition store: `env:` and `file:` references. */
export function createDefaultSecretStore(
  options: { env?: Readonly<Record<string, string | undefined>>; ttlMs?: number } = {},
): SecretStore {
  return new ResolvingSecretStore({
    resolvers: [new EnvSecretResolver(options.env), new FileSecretResolver()],
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
}
