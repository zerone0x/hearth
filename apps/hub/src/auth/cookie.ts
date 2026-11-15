/** The login session cookie (PRD §10, decision 0014). */

/** Name of the cookie that carries the login session id. */
export const SESSION_COOKIE = "hearth_session";

/**
 * `Set-Cookie` for a session id: `HttpOnly` (no script reads it),
 * `SameSite=Strict` (no other site's request carries it), `Path=/`, no
 * `Domain` (host-only), and `Secure` when the hub is reached over HTTPS.
 * `maxAgeMs` 0 deletes the cookie.
 */
export function sessionCookie(value: string, maxAgeMs: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Whether the session cookie is `Secure`: the request came over HTTPS, or the
 * owner's public origin (`HEARTH_PUBLIC_ORIGIN`) is HTTPS, as behind a
 * TLS-terminating reverse proxy that talks plain HTTP to the hub.
 */
export function isSecureContext(requestUrl: string, publicOrigin: string | undefined): boolean {
  return new URL(requestUrl).protocol === "https:" || publicOrigin?.startsWith("https:") === true;
}
