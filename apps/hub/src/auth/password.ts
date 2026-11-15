/**
 * The owner password (PRD §10): argon2id through `Bun.password`, with named
 * parameters, and the length policy checked before any hashing.
 */

/** Parameters of `Bun.password.hash` the KDF accepts. */
export interface Argon2idParams {
  /** Memory in KiB. */
  readonly memoryCost: number;
  /** Passes over the memory. */
  readonly timeCost: number;
}

/**
 * argon2id with the OWASP Password Storage Cheat Sheet's first configuration:
 * 19 MiB of memory, 2 passes, 1 lane (Bun fixes the parallelism at 1). A
 * login costs about 0.1 s of one core; the login rate limit (`rate-limit.ts`)
 * keeps an attacker from turning that into a denial of service. Hashes carry
 * their own parameters, so raising these later still verifies old hashes.
 */
export const ARGON2ID_PARAMS: Argon2idParams = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
});

/** Shortest owner password accepted at setup, in characters. */
export const PASSWORD_MIN_LENGTH = 12;
/**
 * Longest password accepted at setup or login, in UTF-16 units of its NFC
 * form. Bounds the KDF input, so a huge body cannot buy more hashing work than
 * a normal attempt.
 */
export const PASSWORD_MAX_LENGTH = 1024;
/**
 * Loose cap on the password as it arrives, checked before NFC so the
 * normalization work is bounded too. Looser than `PASSWORD_MAX_LENGTH`
 * because the same password can arrive decomposed (NFD "é" is two units,
 * NFC one); the real cap is applied to the NFC form.
 */
export const PASSWORD_RAW_MAX_LENGTH = 4 * PASSWORD_MAX_LENGTH;

/** Hashes and verifies passwords. Tests swap in cheaper parameters. */
export interface PasswordKdf {
  hash(password: string): Promise<string>;
  /** Constant-time comparison is the KDF's job: argon2 compares the derived keys. */
  verify(password: string, hash: string): Promise<boolean>;
}

/** The argon2id KDF of `Bun.password` with `params` (default `ARGON2ID_PARAMS`). */
export function argon2idKdf(params: Argon2idParams = ARGON2ID_PARAMS): PasswordKdf {
  return {
    hash: (password) =>
      Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: params.memoryCost,
        timeCost: params.timeCost,
      }),
    verify: (password, hash) => Bun.password.verify(password, hash, "argon2id"),
  };
}

/**
 * The form a password is hashed and verified in: Unicode NFC. The same
 * password typed on another keyboard or OS can arrive composed ("é", U+00E9)
 * or decomposed ("e" + U+0301); both must log in. NFC, not NFKC: "ﬁ" (U+FB01)
 * and fullwidth letters stay as typed. Call it only after the raw cap
 * (`PASSWORD_RAW_MAX_LENGTH`), so that cap bounds this work; NFC can make a
 * string longer (U+FB2C becomes three units), so check `PASSWORD_MAX_LENGTH`
 * on the result.
 */
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}

/** The problem `passwordProblem` names for a password over the cap. */
export const PASSWORD_TOO_LONG = `the password can have at most ${PASSWORD_MAX_LENGTH} characters`;

/** Why a new password (in NFC, see `normalizePassword`) is refused, or undefined when it is acceptable. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `the password needs at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return PASSWORD_TOO_LONG;
  }
  return undefined;
}
