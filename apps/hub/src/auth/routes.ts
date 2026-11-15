/**
 * The login API (decision 0014). The request guard of decision 0010 runs
 * before these routes like before every other one, so a cross-origin page
 * cannot sign in or set the first password either.
 */

import type { Principal } from "@hearth/core";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { isSecureContext, SESSION_COOKIE, sessionCookie } from "./cookie";
import type { AuthService, IssuedSession } from "./service";

/** Hono environment of the hub app: the session guard sets `principal`. */
export interface HubEnv {
  Variables: { principal: Principal };
}

/**
 * Routes that answer without a session: the liveness probe and the ways to
 * get one. Every other route, including ones that do not exist, needs a
 * session (`401 auth.required`).
 */
export const OPEN_ROUTES: readonly string[] = [
  "GET /healthz",
  "GET /v1/auth/status",
  "POST /v1/auth/setup",
  "POST /v1/auth/login",
];

function fail(
  c: Context<HubEnv>,
  status: 400 | 401 | 403 | 409 | 429,
  code: string,
  message: string,
) {
  return c.json({ ok: false, error: { code, owner: "user", message } }, status);
}

async function stringFields<K extends string>(
  c: Context<HubEnv>,
  keys: readonly K[],
): Promise<Record<K, string> | undefined> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value !== "string") return undefined;
    out[key] = value;
  }
  return out;
}

export interface AuthRouteOptions {
  readonly publicOrigin?: string | undefined;
  readonly now?: () => number;
}

/** Mounts `/v1/auth/*` on `app`. */
export function authRoutes(app: Hono<HubEnv>, auth: AuthService, options: AuthRouteOptions = {}) {
  const now = options.now ?? Date.now;

  function signedIn(c: Context<HubEnv>, session: IssuedSession, status: 200 | 201) {
    const secure = isSecureContext(c.req.url, options.publicOrigin);
    c.header("set-cookie", sessionCookie(session.token, session.expiresAt - now(), secure));
    return c.json({ ok: true, expiresAt: session.expiresAt }, status);
  }

  function rateLimited(c: Context<HubEnv>, retryAfterMs: number) {
    c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
    return fail(c, 429, "auth.rate-limited", "too many sign-in attempts; try again later");
  }

  // For the UI: whether to show the first-run form or the login form. No
  // workspace data, so it needs neither a session nor `authorize`.
  app.get("/v1/auth/status", (c) =>
    c.json({
      setupRequired: auth.setupRequired(),
      authenticated: auth.authenticate(getCookie(c, SESSION_COOKIE)) !== undefined,
    }),
  );

  app.post("/v1/auth/setup", async (c) => {
    const body = await stringFields(c, ["setupToken", "password"]);
    if (body === undefined) {
      return fail(c, 400, "request.invalid-body", "expected {setupToken, password} strings");
    }
    const outcome = await auth.setup(
      body.setupToken,
      body.password,
      getCookie(c, SESSION_COOKIE),
    );
    switch (outcome.kind) {
      case "ok":
        return signedIn(c, outcome, 201);
      case "bad-token":
        return fail(c, 403, "auth.setup-token-invalid", "the setup token is not valid");
      case "bad-password":
        return fail(c, 400, "auth.password-too-weak", outcome.problem);
      case "rate-limited":
        return rateLimited(c, outcome.retryAfterMs);
      case "already-set-up":
        return fail(c, 409, "auth.already-set-up", "the owner password is already set");
    }
  });

  app.post("/v1/auth/login", async (c) => {
    const body = await stringFields(c, ["password"]);
    if (body === undefined) {
      return fail(c, 400, "request.invalid-body", "expected {password} as a string");
    }
    const outcome = await auth.login(body.password, getCookie(c, SESSION_COOKIE));
    switch (outcome.kind) {
      case "ok":
        return signedIn(c, outcome, 200);
      case "rejected":
        return fail(c, 401, "auth.invalid-credentials", "wrong password");
      case "rate-limited":
        return rateLimited(c, outcome.retryAfterMs);
      case "setup-required":
        return fail(c, 409, "auth.setup-required", "set the owner password first");
    }
  });

  // Behind the session guard like every route not in OPEN_ROUTES.
  app.post("/v1/auth/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) auth.logout(token);
    const secure = isSecureContext(c.req.url, options.publicOrigin);
    c.header("set-cookie", sessionCookie("", 0, secure));
    return c.body(null, 204);
  });
}
