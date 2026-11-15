/** The minimal local login (PRD §10, §11.1 item 6; decision 0014). */

export { isSecureContext, SESSION_COOKIE, sessionCookie } from "./cookie";
export {
  ARGON2ID_PARAMS,
  type Argon2idParams,
  argon2idKdf,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordKdf,
  passwordProblem,
} from "./password";
export { type Admission, AttemptLimiter, LOGIN_RATE_LIMIT, type RateLimit } from "./rate-limit";
export { type AuthRouteOptions, authRoutes, type HubEnv, OPEN_ROUTES } from "./routes";
export {
  AuthService,
  type AuthServiceOptions,
  type IssuedSession,
  type LoginOutcome,
  SESSION_TOKEN_PREFIX,
  SESSION_TTL_MS,
  SETUP_TOKEN_PREFIX,
  type SetupOutcome,
  secretHash,
  secretsEqual,
} from "./service";
export type { LoginSessionRecord, LoginStore } from "./store";
