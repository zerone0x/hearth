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
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Promise<T> {
  const res = await fetcher(path, {
    method,
    headers: JSON_HEADERS,
    credentials: "same-origin",
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
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
  events: (sessionId: string, after: number, limit = 500) =>
    call<EventPage>("GET", `/v1/sessions/${id(sessionId)}/events?after=${after}&limit=${limit}`),
};

/** The desktop WebSocket of a session (decision 0016), on the page's own origin. */
export function desktopUrl(sessionId: string, location: Pick<Location, "protocol" | "host">) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/v1/sessions/${id(sessionId)}/desktop`;
}
