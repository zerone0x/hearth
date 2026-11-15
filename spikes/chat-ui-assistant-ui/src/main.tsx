// zod (an @assistant-ui/react dependency) probes `new Function` on its first
// object schema; under `script-src 'self'` that logs a CSP violation even
// though zod recovers. Jitless mode skips the probe. Must run first.
import "./zod-jitless";
import "./index.css";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { createPiThreadState, projectPiThreadMessages, reducePiThreadState } from "@assistant-ui/react-pi";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { RECORDED_LOG } from "./events";
import { createHearthPiClient } from "./hearthPiClient";

type ToolStatus = { type: string; reason?: string };

function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("");
  }
  return result === undefined ? "" : JSON.stringify(result, null, 2);
}

function statusOf(status: ToolStatus, isError: boolean | undefined): [string, string] {
  if (status.type === "running") return ["running", "bg-sky-100 text-sky-800"];
  if (status.type === "requires-action") return ["needs approval", "bg-amber-100 text-amber-900"];
  if (status.type === "incomplete") return [status.reason === "cancelled" ? "interrupted" : "error", "bg-red-100 text-red-800"];
  if (isError) return ["error", "bg-red-100 text-red-800"];
  return ["done", "bg-emerald-100 text-emerald-800"];
}

function ToolCard(props: { toolName: string; args: unknown; result?: unknown; isError?: boolean | undefined; status: ToolStatus }) {
  const args = (props.args ?? {}) as Record<string, unknown>;
  const target = String(args["command"] ?? args["path"] ?? args["pattern"] ?? "");
  const [label, cls] = statusOf(props.status, props.isError);
  return (
    <details className="my-1 rounded-md border border-stone-300 bg-white text-sm" data-testid="tool-card">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <span className="font-mono font-semibold">{props.toolName}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-stone-600">{target}</code>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${cls}`}>{label}</span>
      </summary>
      <pre className="max-h-80 overflow-auto border-t border-stone-200 bg-stone-900 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-stone-100">
        {textOf(props.result) || (props.status.type === "running" ? "…" : "(no output)")}
      </pre>
    </details>
  );
}

function ToolGroup({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button type="button" className="text-sm text-stone-500 hover:text-stone-800" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "▾" : "▸"} Ran {count} tools
      </button>
      {open ? <div className="ml-3 border-l border-stone-200 pl-3">{children}</div> : null}
    </div>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="max-w-[95%]" data-testid="assistant">
      <MessagePrimitive.GroupedParts groupBy={groupPartByType({ "tool-call": ["group-tool"] })}>
        {({ part, children }) => {
          switch (part.type) {
            case "group-tool":
              return part.indices.length === 1 ? <>{children}</> : <ToolGroup count={part.indices.length}>{children}</ToolGroup>;
            case "text":
              return <p className="whitespace-pre-wrap">{part.text}</p>;
            case "tool-call":
              return <ToolCard {...part} />;
            default:
              return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ml-auto max-w-[85%] rounded-lg bg-stone-800 px-3 py-2 whitespace-pre-wrap text-white">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function Thread() {
  return (
    <ThreadPrimitive.Root className="mx-auto flex h-full max-w-2xl flex-col">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="flex gap-2 border-t border-stone-300 p-3">
        <ComposerPrimitive.Input className="flex-1 rounded border border-stone-300 px-2 py-1" placeholder="Ask for something" />
        <ComposerPrimitive.Send className="rounded bg-stone-800 px-3 py-1 text-white">Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

/**
 * Hearth keeps its own transport (cursor polling of the event log) and feeds the
 * pi events into react-pi's pure reducer; assistant-ui's ExternalStoreRuntime
 * renders the projection. No AI SDK, no server runtime.
 */
function useHearthChat(sessionId: string) {
  const [state, setState] = useState(() => createPiThreadState(sessionId));
  useEffect(() => {
    const client = createHearthPiClient(sessionId, async (after) => {
      // Hearth: GET /v1/sessions/:id/events?after=<after>
      const events = RECORDED_LOG.filter((e) => e.seq > after);
      return { events, cursor: RECORDED_LOG.at(-1)?.seq ?? after };
    });
    return client.subscribe(sessionId, (event) => setState((s) => reducePiThreadState(s, event)), {
      includeSnapshot: false,
    });
  }, [sessionId]);
  const messages = useMemo(
    () =>
      projectPiThreadMessages({
        messages: state.messages,
        toolExecutions: state.toolExecutions,
        runStatus: state.runStatus,
        hostUiRequests: state.hostUiRequests ?? [],
      }),
    [state],
  );
  return useExternalStoreRuntime({
    messages,
    convertMessage: (m: ThreadMessageLike) => m,
    isRunning: state.runStatus === "running",
    onNew: async () => {
      // Hearth: POST /v1/sessions/:id/messages; the reply arrives through the log.
    },
    onCancel: async () => {
      // Hearth: POST /v1/sessions/:id/interrupt
    },
  });
}

function App() {
  const runtime = useHearthChat("se_demo");
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="h-screen bg-stone-50 text-stone-900">
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
