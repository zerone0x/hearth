/**
 * One session: the chat and the desktop panel. App.tsx loads this module
 * lazily, so the chat (assistant-ui, markdown) stays out of the first load;
 * the desktop panel loads noVNC only when it connects (#84).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "./api";
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
