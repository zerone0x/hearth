/**
 * Adapter sketch: Hearth's event log -> assistant-ui's Pi runtime.
 *
 * `@assistant-ui/react-pi` drives the UI from a `PiClient` whose `subscribe`
 * delivers pi AgentSession events plus `{threadId, seq}`. Hearth already
 * records exactly those events as `pi.<type>` with a monotonic `seq`, so the
 * mapping is: strip the prefix, spread the payload, keep the seq.
 *
 * In Hearth `fetchPage` would be `GET /v1/sessions/:id/events?after=<cursor>`
 * polled on an interval (decision 0017). Here it reads a recorded log.
 */
import type { PiClient, PiClientEvent, PiThreadSnapshot } from "@assistant-ui/react-pi";
import type { HubEvent } from "./events";

type FetchPage = (after: number) => Promise<{ events: readonly HubEvent[]; cursor: number }>;

export function toPiClientEvent(threadId: string, event: HubEvent): PiClientEvent | null {
  if (event.type.startsWith("pi.")) {
    const body = event.payload as Record<string, unknown>;
    return { ...body, type: event.type.slice(3), threadId, seq: event.seq } as PiClientEvent;
  }
  if (event.type === "runner.failed") {
    const p = event.payload as { message?: string };
    return { type: "error", error: `The runner failed: ${p.message ?? "unknown error"}`, threadId, seq: event.seq };
  }
  // message.user is mirrored by pi's own user message_start/end; runner.* notices
  // other than failures would become Hearth-specific parts (not shown here).
  return null;
}

export function createHearthPiClient(sessionId: string, fetchPage: FetchPage, pollMs = 1000): PiClient {
  const snapshot = (): PiThreadSnapshot => ({
    metadata: { id: sessionId, title: "Hearth session", status: "idle" },
    messages: [],
    seq: 0,
  });
  const unsupported = (name: string) => () => Promise.reject(new Error(`${name}: not in the Hearth spike`));
  return {
    listThreads: async () => [snapshot().metadata],
    createThread: unsupported("createThread") as PiClient["createThread"],
    getThread: async () => snapshot(),
    sendMessage: unsupported("sendMessage") as PiClient["sendMessage"], // POST /v1/sessions/:id/messages
    cancelRun: unsupported("cancelRun") as PiClient["cancelRun"], // POST /v1/sessions/:id/interrupt
    clearQueue: async () => ({ steering: [], followUp: [] }),
    getAvailableModels: async () => [],
    setModel: unsupported("setModel") as PiClient["setModel"],
    setThinkingLevel: unsupported("setThinkingLevel") as PiClient["setThinkingLevel"],
    renameThread: unsupported("renameThread") as PiClient["renameThread"],
    archiveThread: unsupported("archiveThread") as PiClient["archiveThread"],
    unarchiveThread: unsupported("unarchiveThread") as PiClient["unarchiveThread"],
    deleteThread: unsupported("deleteThread") as PiClient["deleteThread"],
    respondToHostUiRequest: unsupported("respondToHostUiRequest") as PiClient["respondToHostUiRequest"],
    subscribe(threadId, listener, options) {
      let cursor = 0;
      let stopped = false;
      if (options?.includeSnapshot !== false) {
        listener({ type: "snapshot", snapshot: snapshot(), threadId, seq: 0 });
      }
      const tick = async () => {
        if (stopped) return;
        const page = await fetchPage(cursor);
        for (const e of page.events) {
          const mapped = toPiClientEvent(threadId, e);
          if (mapped) listener(mapped);
        }
        cursor = page.cursor;
        if (!stopped) timer = setTimeout(tick, pollMs);
      };
      let timer = setTimeout(tick, 0);
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}
