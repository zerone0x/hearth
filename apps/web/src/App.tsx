import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, Fragment, lazy, Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { ErrorAlert } from "./ErrorAlert";
import { keys, useApprovals, useAuth, useSessions } from "./queries";

/**
 * The session page (chat, markdown, desktop) is its own chunk: sign-in and the
 * session list load without it (#84).
 */
const SessionPage = lazy(() => import("./SessionPage"));
/** Settings (decision 0038): its own chunk too, loaded only when opened. */
const SettingsPage = lazy(() => import("./SettingsPage"));

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
  const signOut = (
    <nav className="flex items-center">
      <Button variant="link" asChild>
        <a href="#/settings">Settings</a>
      </Button>
      <Button variant="link" onClick={() => logout.mutate()}>
        Sign out
      </Button>
    </nav>
  );
  if (route === "/settings") {
    return (
      <Shell action={signOut}>
        <ErrorBoundary fallback={<SessionPageFailed page="settings" />}>
          <Suspense fallback="Loading…">
            <SettingsPage />
          </Suspense>
        </ErrorBoundary>
      </Shell>
    );
  }
  const match = /^\/s\/([^/]+)$/.exec(route);
  if (match?.[1] !== undefined) {
    // A chunk that fails to load (a hub upgrade replaced the hashed files while
    // the tab was open) must not blank the app: the shell stays, with a way out.
    return (
      <ErrorBoundary
        fallback={
          <Shell action={signOut}>
            <SessionPageFailed page="session" />
          </Shell>
        }
      >
        <Suspense fallback={<Shell action={signOut}>Loading…</Shell>}>
          <SessionPage sessionId={decodeURIComponent(match[1])} />
        </Suspense>
      </ErrorBoundary>
    );
  }
  return (
    <Shell action={signOut}>
      <SessionList />
    </Shell>
  );
}

/**
 * React.lazy keeps a failed import, so only a page reload fetches the chunk again
 * (and the new index.html, after a hub upgrade).
 */
function SessionPageFailed({ page }: { page: "session" | "settings" }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>The {page} page did not load.</AlertTitle>
      <AlertDescription>
        <p>The hub may have been upgraded since this tab opened.</p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Button variant="link" size="sm" asChild>
            <a href="#/">Sessions</a>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
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
  // Sessions with a tool call waiting for the owner (decision 0048).
  const approvals = useApprovals();
  const waiting = new Set((approvals.data ?? []).map((a) => a.sessionId));
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
                    {waiting.has(s.id) ? (
                      <Badge variant="destructive" data-testid="approval-pending">
                        Approval needed
                      </Badge>
                    ) : null}
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
