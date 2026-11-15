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
 * Longest password accepted at setup or login, in characters. Bounds the KDF
 * input, so a huge body cannot buy more hashing work than a normal attempt.
 */
export const PASSWORD_MAX_LENGTH = 1024;

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

/** Why a new password is refused, or undefined when it is acceptable. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `the password needs at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `the password can have at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return undefined;
}
