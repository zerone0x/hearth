import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, Fragment, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { api } from "./api";
import { DesktopPanel } from "./Desktop";
import { emptyChat, isRunning, projectChat } from "./hearthPi";
import { keys, useAuth, useChat, useSession, useSessions } from "./queries";
import { ChatRuntime, Thread } from "./Thread";

function errorText(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
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

function ErrorAlert({ error }: { error: unknown }) {
  const text = errorText(error);
  if (text === undefined) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

export function App() {
  const auth = useAuth();
  const route = useRoute();
  const client = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => client.setQueryData(keys.auth, { setupRequired: false, authenticated: false }),
  });

  if (auth.data === undefined) {
    return <Shell>{auth.isError ? <ErrorAlert error={auth.error} /> : "Loading…"}</Shell>;
  }
  if (!auth.data.authenticated) {
    return (
      <Shell>
        <AuthForm mode={auth.data.setupRequired ? "setup" : "login"} />
      </Shell>
    );
  }
  const match = /^\/s\/([^/]+)$/.exec(route);
  if (match?.[1] !== undefined) {
    return <SessionPage sessionId={decodeURIComponent(match[1])} />;
  }
  return (
    <Shell
      action={
        <Button variant="link" onClick={() => logout.mutate()}>
          Sign out
        </Button>
      }
    >
      <SessionList />
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

function AuthForm({ mode }: { mode: "setup" | "login" }) {
  const client = useQueryClient();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const submit = useMutation({
    mutationFn: () => (mode === "setup" ? api.setup(token.trim(), password) : api.login(password)),
    onSuccess: () => client.setQueryData(keys.auth, { setupRequired: false, authenticated: true }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit.mutate();
  }

  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{mode === "setup" ? "Set up Hearth" : "Sign in"}</h1>
        </CardTitle>
        {mode === "setup" ? (
          <CardDescription>
            The hub printed a one-time setup token when it started. Paste it here and choose the
            owner password (at least 12 characters).
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          {mode === "setup" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-token">Setup token</Label>
              <Input
                id="setup-token"
                className="font-mono"
                name="setupToken"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              name="password"
              autoComplete={mode === "setup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <ErrorAlert error={submit.error} />
          <Button type="submit" disabled={submit.isPending}>
            {mode === "setup" ? "Set password" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionList() {
  const client = useQueryClient();
  const sessions = useSessions();
  const [title, setTitle] = useState("");
  const create = useMutation({
    mutationFn: () => api.create(title.trim()),
    onSuccess: (session) => {
      window.location.hash = `#/s/${encodeURIComponent(session.id)}`;
    },
  });
  const archive = useMutation({
    mutationFn: api.archive,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sessions }),
  });

  function onCreate(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  const open = sessions.data?.filter((s) => s.archivedAt === null) ?? [];
  return (
    <>
      <form className="flex gap-2" onSubmit={onCreate}>
        <Input
          aria-label="New session title"
          placeholder="New session title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" className="shrink-0" disabled={create.isPending}>
          New session
        </Button>
      </form>
      <ErrorAlert error={create.error ?? archive.error ?? sessions.error} />
      {sessions.data === undefined ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : open.length === 0 ? (
        <p className="text-muted-foreground">No sessions yet.</p>
      ) : (
        <ItemGroup aria-label="Sessions" className="rounded-xl border bg-card">
          {open.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 ? <ItemSeparator /> : null}
              <Item role="listitem" size="sm" data-testid="session-row">
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full">
                    <a className="truncate" href={`#/s/${encodeURIComponent(s.id)}`}>
                      {s.title || s.id}
                    </a>
                  </ItemTitle>
                  <ItemDescription className="text-xs">
                    {s.state} · {new Date(s.lastActivityAt).toLocaleString()}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="ghost" size="sm" onClick={() => archive.mutate(s.id)}>
                    Archive
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </ItemGroup>
      )}
    </>
  );
}

function SessionPage({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const session = useSession(sessionId);
  const chat = useChat(sessionId, client);
  const [showDesktop, setShowDesktop] = useState(false);
  const state = useMemo(() => chat.data ?? emptyChat(sessionId), [chat.data, sessionId]);
  const messages = useMemo(() => projectChat(state), [state]);
  const running = isRunning(state);

  // The reply arrives through the event log: poll it now rather than at the next tick.
  const refetchChat = () => client.refetchQueries({ queryKey: keys.events(sessionId) });
  const send = useMutation({
    mutationFn: (text: string) => api.send(sessionId, text),
    onSuccess: refetchChat,
  });
  const interrupt = useMutation({
    mutationFn: () => api.interrupt(sessionId),
    onSuccess: refetchChat,
  });

  const error = send.error ?? interrupt.error ?? chat.error ?? session.error;
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b bg-card px-4 py-2">
        <Button variant="link" size="sm" className="px-0" asChild>
          <a href="#/">Sessions</a>
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-semibold">
          {session.data?.title || sessionId}
        </h1>
        <span className="text-muted-foreground text-xs" data-testid="session-state">
          {running ? "working" : (session.data?.state ?? "")}
        </span>
        <Button
          variant="link"
          size="sm"
          className="lg:hidden"
          onClick={() => setShowDesktop((v) => !v)}
        >
          {showDesktop ? "Hide desktop" : "Desktop"}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col">
          {error === null ? null : (
            <div className="px-4 pt-3">
              <ErrorAlert error={error} />
            </div>
          )}
          <ChatRuntime
            messages={messages}
            isRunning={running}
            onSend={async (text) => {
              await send.mutateAsync(text);
            }}
            onInterrupt={async () => {
              await interrupt.mutateAsync();
            }}
          >
            <Thread />
          </ChatRuntime>
        </div>
        <aside
          className={`${showDesktop ? "flex" : "hidden"} h-72 flex-col p-3 lg:flex lg:h-auto lg:w-[45%] lg:border-l`}
        >
          <DesktopPanel sessionId={sessionId} />
        </aside>
      </div>
    </div>
  );
}
