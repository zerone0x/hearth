/**
 * Data fetching and polling with TanStack Query: retries, deduplication of
 * in-flight requests and the poll interval are the library's, not ours.
 */

import { QueryCache, QueryClient, useQuery } from "@tanstack/react-query";
import { ApiError, type AuthStatus, api } from "./api";
import { applyHubEvents, emptyChat, type HearthChat, isRunning } from "./hearthPi";

/** How often the open session polls for new events: fast while a turn runs. */
export const POLL_RUNNING_MS = 700;
export const POLL_IDLE_MS = 3000;

export const keys = {
  auth: ["auth"] as const,
  sessions: ["sessions"] as const,
  session: (id: string) => ["session", id] as const,
  events: (id: string) => ["events", id] as const,
  desktopLock: (id: string) => ["desktop-lock", id] as const,
  vaultStatus: ["vault-status"] as const,
  secrets: ["secrets"] as const,
  modelSettings: ["model-settings"] as const,
};

/** How often an open desktop re-reads its lock: a lease can lapse or be taken meanwhile. */
export const POLL_DESKTOP_LOCK_MS = 3000;

const SIGNED_OUT: AuthStatus = { setupRequired: false, authenticated: false };

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    // Any 401 means the login ended: back to the login form.
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) {
          client.setQueryData(keys.auth, SIGNED_OUT);
        }
      },
    }),
    defaultOptions: {
      queries: {
        // A refusal (4xx) will not change on retry; a network blip or 5xx may.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
  client.getMutationCache().config.onError = (error) => {
    if (error instanceof ApiError && error.status === 401)
      client.setQueryData(keys.auth, SIGNED_OUT);
  };
  return client;
}

export function useAuth() {
  return useQuery({ queryKey: keys.auth, queryFn: api.status });
}

export function useSessions() {
  return useQuery({ queryKey: keys.sessions, queryFn: api.sessions });
}

export function useSession(sessionId: string) {
  return useQuery({ queryKey: keys.session(sessionId), queryFn: () => api.session(sessionId) });
}

/**
 * Reads every page after `chat`'s cursor and folds it in. The event log is the
 * chat: a fresh page view starts at cursor 0 and rebuilds it, then the poll
 * continues from the log's end.
 */
export async function readNewEvents(
  chat: HearthChat,
  events: typeof api.events = api.events,
): Promise<HearthChat> {
  let next = chat;
  for (;;) {
    const page = await events(chat.pi.threadId, next.cursor);
    next = applyHubEvents(next, page.events);
    if (!page.hasMore) return next;
  }
}

/** How long until the next poll of a chat. */
export function pollInterval(chat: HearthChat | undefined): number {
  return chat !== undefined && isRunning(chat) ? POLL_RUNNING_MS : POLL_IDLE_MS;
}

/** The session's chat, polled from the last cursor: every 0.7 s while a turn runs, else every 3 s. */
export function useChat(sessionId: string, client: QueryClient) {
  return useQuery({
    queryKey: keys.events(sessionId),
    queryFn: () =>
      readNewEvents(
        client.getQueryData<HearthChat>(keys.events(sessionId)) ?? emptyChat(sessionId),
      ),
    // The chat is folded state, not a server snapshot: keep every reference as returned.
    structuralSharing: false,
    // Leaving the page drops the chat; coming back rebuilds it from the log.
    gcTime: 0,
    refetchInterval: (query) => pollInterval(query.state.data),
    refetchIntervalInBackground: true,
  });
}
