import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Session } from "./api";
import { applyEvents, type ChatState, EMPTY_CHAT } from "./chat";
import { ChatList } from "./components";
import { DesktopPanel } from "./Desktop";

/** How often the open session polls for new events: fast while a turn runs. */
const POLL_RUNNING_MS = 700;
const POLL_IDLE_MS = 3000;

type Auth = "loading" | "setup" | "login" | "in";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The route is in the hash (`#/s/<id>`), so the hub serves one HTML file. */
function useRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

export function App() {
  const [auth, setAuth] = useState<Auth>("loading");
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const status = await api.status();
      setAuth(status.setupRequired ? "setup" : status.authenticated ? "in" : "login");
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any 401 from a page means the login ended: back to the login form.
  const onAuthError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setAuth("login");
  }, []);

  const route = useRoute();
  if (error !== undefined) return <Shell>{error}</Shell>;
  if (auth === "loading") return <Shell>Loading…</Shell>;
  if (auth === "setup" || auth === "login") {
    return (
      <Shell>
        <AuthForm mode={auth} onDone={() => setAuth("in")} />
      </Shell>
    );
  }
  const match = /^\/s\/([^/]+)$/.exec(route);
  if (match?.[1] !== undefined) {
    return <SessionPage sessionId={decodeURIComponent(match[1])} onAuthError={onAuthError} />;
  }
  return (
    <Shell
      action={
        <button
          type="button"
          className="text-sm text-stone-600 underline"
          onClick={() => void api.logout().finally(() => setAuth("login"))}
        >
          Sign out
        </button>
      }
    >
      <SessionList onAuthError={onAuthError} />
    </Shell>
  );
}

function Shell({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <a href="#/" className="text-lg font-semibold">
          Hearth
        </a>
        {action}
      </header>
      <main className="flex flex-col gap-4">{children}</main>
    </div>
  );
}

const input =
  "w-full rounded-md border border-stone-300 bg-white px-3 py-2 focus:border-stone-500 focus:outline-none";
const primary =
  "rounded-md bg-stone-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50";

function AuthForm({ mode, onDone }: { mode: "setup" | "login"; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "setup") await api.setup(token.trim(), password);
      else await api.login(password);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex max-w-sm flex-col gap-3" onSubmit={submit}>
      <h1 className="text-xl font-semibold">{mode === "setup" ? "Set up Hearth" : "Sign in"}</h1>
      {mode === "setup" ? (
        <>
          <p className="text-sm text-stone-600">
            The hub printed a one-time setup token when it started. Paste it here and choose the
            owner password (at least 12 characters).
          </p>
          <label className="flex flex-col gap-1 text-sm">
            Setup token
            <input
              className={`${input} font-mono`}
              name="setupToken"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </label>
        </>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          className={input}
          type="password"
          name="password"
          autoComplete={mode === "setup" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error === undefined ? null : (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={primary} disabled={busy}>
        {mode === "setup" ? "Set password" : "Sign in"}
      </button>
    </form>
  );
}

function SessionList({ onAuthError }: { onAuthError: (e: unknown) => void }) {
  const [sessions, setSessions] = useState<Session[]>();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setSessions(await api.sessions());
    } catch (e) {
      onAuthError(e);
      setError(errorText(e));
    }
  }, [onAuthError]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      const session = await api.create(title.trim());
      window.location.hash = `#/s/${encodeURIComponent(session.id)}`;
    } catch (e) {
      onAuthError(e);
      setError(errorText(e));
    }
  }

  async function archive(id: string) {
    try {
      await api.archive(id);
      await load();
    } catch (e) {
      onAuthError(e);
      setError(errorText(e));
    }
  }

  const open = sessions?.filter((s) => s.archivedAt === null) ?? [];
  return (
    <>
      <form className="flex gap-2" onSubmit={create}>
        <input
          className={input}
          aria-label="New session title"
          placeholder="New session title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" className={`${primary} shrink-0`}>
          New session
        </button>
      </form>
      {error === undefined ? null : (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {sessions === undefined ? (
        <p className="text-stone-500">Loading…</p>
      ) : open.length === 0 ? (
        <p className="text-stone-500">No sessions yet.</p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white">
          {open.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2" data-testid="session-row">
              <a className="min-w-0 flex-1" href={`#/s/${encodeURIComponent(s.id)}`}>
                <span className="block truncate font-medium">{s.title || s.id}</span>
                <span className="text-xs text-stone-500">
                  {s.state} · {new Date(s.lastActivityAt).toLocaleString()}
                </span>
              </a>
              <button
                type="button"
                className="text-sm text-stone-600 underline"
                onClick={() => void archive(s.id)}
              >
                Archive
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SessionPage({
  sessionId,
  onAuthError,
}: {
  sessionId: string;
  onAuthError: (e: unknown) => void;
}) {
  const [session, setSession] = useState<Session>();
  const [chat, setChat] = useState<ChatState>(EMPTY_CHAT);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [showDesktop, setShowDesktop] = useState(false);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.session(sessionId).then(setSession, (e: unknown) => {
      onAuthError(e);
      setError(errorText(e));
    });
  }, [sessionId, onAuthError]);

  // The event log is the chat: read it page by page from the last cursor,
  // then keep polling from there. A reload starts at 0 and rebuilds the same
  // chat, then continues from the log's end.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        for (;;) {
          const page = await api.events(sessionId, chatRef.current.cursor);
          if (stopped) return;
          if (page.events.length > 0) {
            const next = applyEvents(chatRef.current, page.events);
            chatRef.current = next;
            setChat(next);
          }
          if (!page.hasMore) break;
        }
        setError(undefined);
      } catch (e) {
        if (stopped) return;
        onAuthError(e);
        setError(errorText(e));
      }
      if (!stopped) {
        timer = setTimeout(poll, chatRef.current.running ? POLL_RUNNING_MS : POLL_IDLE_MS);
      }
    }
    chatRef.current = EMPTY_CHAT;
    setChat(EMPTY_CHAT);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionId, onAuthError]);

  const count = chat.items.length;
  useEffect(() => {
    if (count > 0) bottom.current?.scrollIntoView?.({ block: "end" });
  }, [count]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const message = text.trim();
    if (message === "") return;
    try {
      await api.send(sessionId, message);
      setText("");
      setError(undefined);
      setChat((c) => ({ ...c, running: true }));
    } catch (e) {
      onAuthError(e);
      setError(errorText(e));
    }
  }

  async function interrupt() {
    try {
      await api.interrupt(sessionId);
    } catch (e) {
      onAuthError(e);
      setError(errorText(e));
    }
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2">
        <a href="#/" className="text-sm text-stone-600 underline">
          Sessions
        </a>
        <h1 className="min-w-0 flex-1 truncate font-semibold">{session?.title || sessionId}</h1>
        <span className="text-xs text-stone-500" data-testid="session-state">
          {chat.running ? "working" : (session?.state ?? "")}
        </span>
        <button
          type="button"
          className="text-sm text-stone-600 underline lg:hidden"
          onClick={() => setShowDesktop((v) => !v)}
        >
          {showDesktop ? "Hide desktop" : "Desktop"}
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="chat">
            <ChatList items={chat.items} />
            <div ref={bottom} />
          </div>
          {error === undefined ? null : (
            <p className="px-4 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          <form
            className="flex items-end gap-2 border-t border-stone-200 bg-white p-3"
            onSubmit={send}
          >
            <textarea
              className={`${input} max-h-40 min-h-11 resize-y`}
              aria-label="Message"
              placeholder="Message"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {chat.running ? (
              <button type="button" className={`${primary} bg-red-700`} onClick={interrupt}>
                Interrupt
              </button>
            ) : (
              <button type="submit" className={primary} disabled={text.trim() === ""}>
                Send
              </button>
            )}
          </form>
        </div>
        <aside
          className={`${showDesktop ? "flex" : "hidden"} h-72 flex-col border-stone-200 p-3 lg:flex lg:h-auto lg:w-[45%] lg:border-l`}
        >
          <DesktopPanel sessionId={sessionId} />
        </aside>
      </div>
    </div>
  );
}
