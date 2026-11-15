/** Presentational pieces of the chat, kept free of fetching so they can be tested by rendering. */

import type { ChatItem, ToolStatus } from "./chat";

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: "running",
  ok: "done",
  error: "error",
  "outcome-unknown": "outcome unknown",
  interrupted: "interrupted",
};

const STATUS_CLASS: Record<ToolStatus, string> = {
  running: "bg-sky-100 text-sky-800",
  ok: "bg-emerald-100 text-emerald-800",
  error: "bg-red-100 text-red-800",
  "outcome-unknown": "bg-amber-100 text-amber-900",
  interrupted: "bg-stone-200 text-stone-700",
};

export function ToolCard({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  return (
    <details
      className="rounded-md border border-stone-300 bg-white text-sm"
      data-testid="tool-card"
      data-status={item.status}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <span className="font-mono font-semibold">{item.name}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-stone-600">{item.target}</code>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[item.status]}`}>
          {STATUS_LABEL[item.status]}
        </span>
      </summary>
      {item.status === "outcome-unknown" ? (
        <p className="border-t border-stone-200 px-3 py-2 text-amber-900">
          The box restarted during this call. It may or may not have taken effect, and it was not
          run again.
        </p>
      ) : null}
      <pre className="max-h-80 overflow-auto border-t border-stone-200 bg-stone-900 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-stone-100">
        {item.output || (item.status === "running" ? "…" : "(no output)")}
      </pre>
    </details>
  );
}

export function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-auto max-w-[85%] rounded-lg bg-stone-800 px-3 py-2 whitespace-pre-wrap text-white">
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <div className="max-w-[95%] whitespace-pre-wrap" data-testid="assistant">
          {item.text}
          {item.streaming ? <span className="text-stone-400"> ▍</span> : null}
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "notice":
      return (
        <p
          className={`text-sm ${item.tone === "error" ? "text-red-700" : "text-stone-500"}`}
          role={item.tone === "error" ? "alert" : undefined}
        >
          {item.text}
        </p>
      );
  }
}

export function ChatList({ items }: { items: readonly ChatItem[] }) {
  if (items.length === 0) {
    return <p className="text-stone-500">No messages yet. Ask for something below.</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col">
          <ChatItemView item={item} />
        </li>
      ))}
    </ol>
  );
}

/** What the desktop panel shows when it is not streaming. */
export type DesktopPhase =
  | { readonly kind: "closed" }
  | { readonly kind: "connecting" }
  | { readonly kind: "open" }
  | { readonly kind: "asleep" }
  | { readonly kind: "ended"; readonly reason: string };

/** Close codes of the desktop WebSocket (decision 0016). */
export const DESKTOP_CLOSE_ASLEEP = 4410;

export function desktopPhaseFor(code: number, reason: string): DesktopPhase {
  if (code === DESKTOP_CLOSE_ASLEEP) return { kind: "asleep" };
  if (code === 4401) return { kind: "ended", reason: "Signed out. Sign in again to watch." };
  if (code === 4408) return { kind: "ended", reason: "The connection was too slow to keep up." };
  if (code === 1001) return { kind: "ended", reason: "The hub is shutting down." };
  return { kind: "ended", reason: reason || `The desktop closed (code ${code}).` };
}

export function DesktopStatus({ phase, onWake }: { phase: DesktopPhase; onWake: () => void }) {
  switch (phase.kind) {
    case "open":
      return null;
    case "connecting":
      return <p className="text-stone-300">Connecting to the desktop…</p>;
    case "asleep":
      return (
        <div className="flex flex-col items-center gap-2 text-center" data-testid="desktop-asleep">
          <p className="text-stone-100">Box asleep — send a message or click Wake to reconnect.</p>
          <button
            type="button"
            className="rounded bg-white px-3 py-1 text-stone-900"
            onClick={onWake}
          >
            Wake
          </button>
        </div>
      );
    case "ended":
      return (
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-stone-100">{phase.reason}</p>
          <button
            type="button"
            className="rounded bg-white px-3 py-1 text-stone-900"
            onClick={onWake}
          >
            Reconnect
          </button>
        </div>
      );
    case "closed":
      return (
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-stone-300">View-only. Opening the desktop starts the box.</p>
          <button
            type="button"
            className="rounded bg-white px-3 py-1 text-stone-900"
            onClick={onWake}
          >
            Open desktop
          </button>
        </div>
      );
  }
}
