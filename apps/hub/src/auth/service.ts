/**
 * The minimal local login (PRD §10, §11.1 item 6; decision 0014): one owner
 * password, set once at first run, and server-side login sessions with a
 * fixed expiry.
 *
 * TODO(PRD §10): passkeys (WebAuthn) as an optional second way to sign in.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type EpochMs, LOCAL_PRINCIPAL, type Principal } from "@hearth/core";
import { argon2idKdf, PASSWORD_MAX_LENGTH, type PasswordKdf, passwordProblem } from "./password";
import { AttemptLimiter, LOGIN_RATE_LIMIT, type RateLimit } from "./rate-limit";
import type { LoginStore } from "./store";

/** How long a login session lasts. Fixed from login; it is not extended by use. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

/** Prefix of a login session id, the value of the session cookie. */
export const SESSION_TOKEN_PREFIX = "hls_";
/** Prefix of the first-run setup token. */
export const SETUP_TOKEN_PREFIX = "hst_";

/** Random bytes in a session id or setup token: 256 bits, so a plain SHA-256 is a safe hash. */
const SECRET_BYTES = 32;

function mint(prefix: string): string {
  return prefix + randomBytes(SECRET_BYTES).toString("base64url");
}

/** SHA-256 of a secret, hex. Session ids are stored and looked up only by this. */
export function secretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Compares two secrets in time that depends on neither value nor length: both
 * are hashed to 32 bytes first, and `timingSafeEqual` compares the digests.
 */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

/** A session handed to the browser: the raw id goes into the cookie only. */
export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: EpochMs;
}

export type LoginOutcome =
  | ({ readonly kind: "ok" } & IssuedSession)
  | { readonly kind: "rejected" }
  | { readonly kind: "rate-limited"; readonly retryAfterMs: number }
  | { readonly kind: "setup-required" };

export type SetupOutcome =
  | ({ readonly kind: "ok" } & IssuedSession)
  | { readonly kind: "bad-token" }
  | { readonly kind: "bad-password"; readonly problem: string }
  | { readonly kind: "rate-limited"; readonly retryAfterMs: number }
  | { readonly kind: "already-set-up" };

export interface AuthServiceOptions {
  readonly store: LoginStore;
  /** Defaults to argon2id with `ARGON2ID_PARAMS`. */
  readonly kdf?: PasswordKdf;
  readonly rateLimit?: RateLimit;
  readonly sessionTtlMs?: number;
  readonly now?: () => EpochMs;
}

export class AuthService {
  /** The principal a password login signs in as: v1 has one local owner (E2). */
  static readonly OWNER: Principal = LOCAL_PRINCIPAL;

  readonly #store: LoginStore;
  readonly #kdf: PasswordKdf;
  readonly #limiter: AttemptLimiter;
  readonly #sessionTtlMs: number;
  readonly #now: () => EpochMs;
  /** In memory only; minted while no password is set, gone once it is. */
  #setupToken: string | undefined;

  constructor(options: AuthServiceOptions) {
    this.#store = options.store;
    this.#kdf = options.kdf ?? argon2idKdf();
    this.#now = options.now ?? Date.now;
    this.#limiter = new AttemptLimiter(options.rateLimit ?? LOGIN_RATE_LIMIT, this.#now);
    this.#sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  }

  /** True until the owner has set a password. */
  setupRequired(): boolean {
    return this.#store.passwordHash(AuthService.OWNER.id) === undefined;
  }

  /**
   * The one-time token that authorizes setting the first password, or
   * undefined once a password is set. The hub logs it at start, so only
   * someone who can read the hub's output can claim a fresh install, even
   * one already behind a public reverse proxy.
   */
  setupToken(): string | undefined {
    if (!this.setupRequired()) {
      this.#setupToken = undefined;
      return undefined;
    }
    this.#setupToken ??= mint(SETUP_TOKEN_PREFIX);
    return this.#setupToken;
  }

  /**
   * First run: set the owner password with the setup token, and sign in.
   * Rate-limited together with `login`.
   */
  async setup(setupToken: string, password: string, previous?: string): Promise<SetupOutcome> {
    const expected = this.setupToken();
    if (expected === undefined) return { kind: "already-set-up" };
    const admission = this.#limiter.admit();
    if (!admission.admitted) return { kind: "rate-limited", retryAfterMs: admission.retryAfterMs };
    if (!secretsEqual(setupToken, expected)) return { kind: "bad-token" };
    const problem = passwordProblem(password);
    if (problem !== undefined) return { kind: "bad-password", problem };
    const hash = await this.#kdf.hash(password);
    const owner = AuthService.OWNER;
    if (!this.#store.setInitialPassword(owner.workspaceId, owner.id, hash, this.#now())) {
      return { kind: "already-set-up" };
    }
    this.#setupToken = undefined;
    this.#limiter.succeeded();
    return { kind: "ok", ...this.#signIn(owner, previous) };
  }

  /**
   * Check the owner password and open a new session. `previous` is the
   * session id the browser already sent, if any: it is ended, never reused,
   * so a planted cookie cannot become a signed-in session (session fixation).
   */
  async login(password: string, previous?: string): Promise<LoginOutcome> {
    const owner = AuthService.OWNER;
    const hash = this.#store.passwordHash(owner.id);
    if (hash === undefined) return { kind: "setup-required" };
    const admission = this.#limiter.admit();
    if (!admission.admitted) return { kind: "rate-limited", retryAfterMs: admission.retryAfterMs };
    if (password.length > PASSWORD_MAX_LENGTH) return { kind: "rejected" };
    if (!(await this.#kdf.verify(password, hash))) return { kind: "rejected" };
    this.#limiter.succeeded();
    return { kind: "ok", ...this.#signIn(owner, previous) };
  }

  /** Open a session for `principal`. Login uses it; tests and in-process callers may too. */
  issueSession(principal: Principal): IssuedSession {
    const now = this.#now();
    this.#store.deleteExpiredSessions(now);
    const token = mint(SESSION_TOKEN_PREFIX);
    const expiresAt = now + this.#sessionTtlMs;
    this.#store.createSession({
      idHash: secretHash(token),
      workspaceId: principal.workspaceId,
      principalId: principal.id,
      createdAt: now,
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** The principal of a live session, or undefined for a missing, unknown or expired one. */
  authenticate(token: string | undefined): Principal | undefined {
    if (token === undefined || !token.startsWith(SESSION_TOKEN_PREFIX)) return undefined;
    const idHash = secretHash(token);
    const session = this.#store.findSession(idHash);
    if (session === undefined) return undefined;
    if (this.#now() >= session.expiresAt) {
      this.#store.deleteSession(idHash);
      return undefined;
    }
    const owner = AuthService.OWNER;
    if (session.principalId !== owner.id || session.workspaceId !== owner.workspaceId) {
      return undefined;
    }
    return owner;
  }

  /** End a session on the server. Unknown ids are ignored. */
  logout(token: string): void {
    if (token.startsWith(SESSION_TOKEN_PREFIX)) this.#store.deleteSession(secretHash(token));
  }

  #signIn(principal: Principal, previous: string | undefined): IssuedSession {
    if (previous !== undefined) this.logout(previous);
    return this.issueSession(principal);
  }
}
