/**
 * The hub's API as the UI uses it. Same-origin only (decision 0017): the
 * login cookie is `HttpOnly`, so the UI never sees it, and every call sends
 * `Content-Type: application/json` (decision 0010), even without a body.
 * Nothing secret lives in the client.
 */

export interface Session {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly model: string | null;
  readonly repoUrl: string | null;
  readonly boxId: string | null;
  readonly lastActivityAt: number;
  readonly createdAt: number;
  readonly archivedAt: number | null;
}

export interface HubEvent {
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly payload: unknown;
}

export interface EventPage {
  readonly events: HubEvent[];
  readonly cursor: number;
  readonly hasMore: boolean;
}

/** The desktop lock of a session (decision 0033): who may type on its desktop. */
export interface DesktopLock {
  readonly held: boolean;
  /** The signed-in user holds it. */
  readonly mine: boolean;
  readonly holder: { readonly kind: string; readonly principalId: string } | null;
  readonly expiresAt: number | null;
}

/** The vault's state (decision 0031): never a key, only its check prefix or the reason it is off. */
export type VaultStatus =
  | { readonly state: "starting" }
  | { readonly state: "enabled"; readonly kekCheck: string; readonly key: "current" | "next" }
  | { readonly state: "disabled"; readonly reason: string; readonly message: string };

export type SecretKind = "model-key" | "login" | "token";

/** One vault entry as the hub lists it: metadata and a keyed fingerprint, never a value. */
export interface Secret {
  readonly id: string;
  readonly name: string;
  readonly kind: SecretKind;
  readonly scope: { readonly sessionId: string } | null;
  readonly policy: {
    readonly origins?: string[];
    readonly use?: string;
    readonly hosts?: string[];
  };
  readonly meta: { readonly label?: string; readonly provider?: string };
  readonly fingerprint: string;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt: number | null;
}

/** A new entry. `fields` is write-only: the hub answers with a fingerprint. */
export interface NewSecret {
  readonly name: string;
  readonly kind: SecretKind;
  readonly policy?: { readonly origins: string[] } | { readonly use: "hub" | "box-env" };
  readonly fields: Readonly<Record<string, string>>;
}

/** The model settings (decision 0038). `source: "env"` means deploy/.env wins and they are read-only. */
export interface ModelSettings {
  readonly source: "env" | "settings" | "none";
  readonly provider: string | null;
  readonly model: string | null;
  readonly keyRef: string | null;
  readonly keyFingerprint: string | null;
  readonly updatedAt: number | null;
}

/** The access mode (decision 0045): `yolo` runs every tool without asking, `ask` stops risky ones. */
export type AccessMode = "yolo" | "ask";

/** The global default. `source: "default"` means nothing is saved and it is `ask`. */
export interface AccessModeSettings {
  readonly mode: AccessMode;
  readonly source: "default" | "settings";
  readonly updatedAt: number | null;
}

/** A session's mode: its own `override`, or null to follow the global default. */
export interface SessionAccessMode {
  readonly sessionId: string;
  readonly override: AccessMode | null;
  readonly global: AccessMode;
  /** The mode in force: `override ?? global`. */
  readonly mode: AccessMode;
}

export interface AuthStatus {
  readonly setupRequired: boolean;
  readonly authenticated: boolean;
}

/** A refused API call, with the hub's error code (`auth.required`, `runner.busy`, …). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The headers of every API call: JSON both ways (decision 0010). */
export const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  accept: "application/json",
};

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Calls the hub. Bodies are always JSON; a POST without one sends `{}`. */
export async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Promise<T> {
  const res = await fetcher(path, {
    method,
    headers: JSON_HEADERS,
    credentials: "same-origin",
    ...(method === "POST" || method === "PUT" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  if (res.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? `http.${res.status}`,
      error?.message ?? `${method} ${path} failed with ${res.status}`,
    );
  }
  return data as T;
}

const id = (sessionId: string) => encodeURIComponent(sessionId);

export const api = {
  status: () => call<AuthStatus>("GET", "/v1/auth/status"),
  setup: (setupToken: string, password: string) =>
    call<unknown>("POST", "/v1/auth/setup", { setupToken, password }),
  login: (password: string) => call<unknown>("POST", "/v1/auth/login", { password }),
  logout: () => call<unknown>("POST", "/v1/auth/logout"),
  sessions: async () => (await call<{ sessions: Session[] }>("GET", "/v1/sessions")).sessions,
  session: async (sessionId: string) =>
    (await call<{ session: Session }>("GET", `/v1/sessions/${id(sessionId)}`)).session,
  create: async (title: string) =>
    (await call<{ session: Session }>("POST", "/v1/sessions", title ? { title } : {})).session,
  archive: (sessionId: string) => call<unknown>("POST", `/v1/sessions/${id(sessionId)}/archive`),
  send: (sessionId: string, text: string) =>
    call<unknown>("POST", `/v1/sessions/${id(sessionId)}/messages`, { text }),
  interrupt: (sessionId: string) =>
    call<{ interrupted: boolean }>("POST", `/v1/sessions/${id(sessionId)}/interrupt`),
  desktopLock: async (sessionId: string) =>
    (await call<{ lock: DesktopLock }>("GET", `/v1/sessions/${id(sessionId)}/desktop/lock`)).lock,
  takeOver: async (sessionId: string) =>
    (await call<{ lock: DesktopLock }>("POST", `/v1/sessions/${id(sessionId)}/desktop/lock`)).lock,
  releaseDesktop: async (sessionId: string) =>
    (
      await call<{ lock: DesktopLock }>(
        "POST",
        `/v1/sessions/${id(sessionId)}/desktop/lock/release`,
      )
    ).lock,
  events: (sessionId: string, after: number, limit = 500) =>
    call<EventPage>("GET", `/v1/sessions/${id(sessionId)}/events?after=${after}&limit=${limit}`),
  vaultStatus: () => call<VaultStatus>("GET", "/v1/vault/status"),
  secrets: async () => (await call<{ secrets: Secret[] }>("GET", "/v1/secrets")).secrets,
  addSecret: (secret: NewSecret) =>
    call<{ id: string; fingerprint: string; version: number }>("POST", "/v1/secrets", secret),
  /** `use` only for a token: whether box commands may get it (decision 0041). */
  rotateSecret: (
    secretId: string,
    fields: Readonly<Record<string, string>>,
    use?: "hub" | "box-env",
  ) =>
    call<{ fingerprint: string; version: number }>("PUT", `/v1/secrets/${id(secretId)}/value`, {
      fields,
      ...(use === undefined ? {} : { use }),
    }),
  deleteSecret: (secretId: string) => call<unknown>("DELETE", `/v1/secrets/${id(secretId)}`),
  modelSettings: () => call<ModelSettings>("GET", "/v1/settings/model"),
  saveModelSettings: (choice: { provider: string; model: string; keyRef: string | null }) =>
    call<ModelSettings>("PUT", "/v1/settings/model", choice),
  accessMode: () => call<AccessModeSettings>("GET", "/v1/settings/access-mode"),
  saveAccessMode: (mode: AccessMode) =>
    call<AccessModeSettings>("PUT", "/v1/settings/access-mode", { mode }),
  sessionAccessMode: (sessionId: string) =>
    call<SessionAccessMode>("GET", `/v1/sessions/${id(sessionId)}/access-mode`),
  /** `null` follows the global default again. */
  saveSessionAccessMode: (sessionId: string, mode: AccessMode | null) =>
    call<SessionAccessMode>("PUT", `/v1/sessions/${id(sessionId)}/access-mode`, { mode }),
};

/** The desktop WebSocket of a session (decision 0016), on the page's own origin. */
export function desktopUrl(sessionId: string, location: Pick<Location, "protocol" | "host">) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/v1/sessions/${id(sessionId)}/desktop`;
}
