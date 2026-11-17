/**
 * One session: the chat and the desktop panel. App.tsx loads this module
 * lazily, so the chat (assistant-ui, markdown) stays out of the first load;
 * the desktop panel loads noVNC only when it connects (#84).
 *
 * The header shows the session's access mode (decision 0045) as a native
 * select (CSP: no Radix scroll lock): follow the global default, or `ask` /
 * `yolo` for this session only. A change applies from the next tool call.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { type AccessMode, api } from "./api";
import { DesktopPanel } from "./Desktop";
import { ErrorAlert } from "./ErrorAlert";
import { emptyChat, isRunning, projectChat } from "./hearthPi";
import { keys, useChat, useSession } from "./queries";
import { ChatRuntime, Thread } from "./Thread";

export default function SessionPage({ sessionId }: { sessionId: string }) {
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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card px-4 py-2">
        <Button variant="link" size="sm" className="px-0" asChild>
          <a href="#/">Sessions</a>
        </Button>
        <h1 className="min-w-32 flex-1 truncate font-semibold">
          {session.data?.title || sessionId}
        </h1>
        <AccessModeSelect sessionId={sessionId} />
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

/** The select's value for "follow the global default". */
const FOLLOW = "default";

/** The session's access mode: its own, or the global default's (decision 0045). */
export function AccessModeSelect({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const current = useQuery({
    queryKey: keys.sessionAccessMode(sessionId),
    queryFn: () => api.sessionAccessMode(sessionId),
  });
  const save = useMutation({
    mutationFn: (mode: AccessMode | null) => api.saveSessionAccessMode(sessionId, mode),
    onSuccess: (saved) => client.setQueryData(keys.sessionAccessMode(sessionId), saved),
  });
  const data = current.data;
  const failed = save.error ?? current.error;
  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      data-testid="access-mode"
      data-mode={data?.mode}
    >
      <label
        htmlFor="session-access-mode"
        className="sr-only text-muted-foreground text-xs sm:not-sr-only"
      >
        Access
      </label>
      <NativeSelect
        id="session-access-mode"
        size="sm"
        value={data === undefined ? FOLLOW : (data.override ?? FOLLOW)}
        disabled={data === undefined || save.isPending}
        aria-describedby={failed === null ? undefined : "session-access-mode-error"}
        aria-invalid={failed === null ? undefined : true}
        title={data === undefined ? undefined : `Tool calls run in ${data.mode}`}
        onChange={(e) => {
          const value = e.target.value;
          save.mutate(value === "ask" || value === "yolo" ? value : null);
        }}
      >
        <NativeSelectOption value={FOLLOW}>
          {data === undefined ? "Default" : `Default (${data.global})`}
        </NativeSelectOption>
        <NativeSelectOption value="ask">Ask</NativeSelectOption>
        <NativeSelectOption value="yolo">Yolo</NativeSelectOption>
      </NativeSelect>
      {failed === null ? null : (
        <span id="session-access-mode-error" role="alert" className="text-destructive text-xs">
          {failed.message}
        </span>
      )}
    </div>
  );
}
