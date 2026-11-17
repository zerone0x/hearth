/**
 * The chat view: assistant-ui's registry `Thread` (thread, messages,
 * composer) over Hearth's event log (`hearthPi.ts`) through
 * `useExternalStoreRuntime`. Hearth plugs its own pieces in through the
 * registry component's slots: tool cards (`ToolFallback`), its notices
 * (`AssistantMessage`, for system messages) and the empty state (`Welcome`).
 *
 * A tool call the access gate holds for the owner (decision 0048) is a branch
 * of the same card: what it does, the rule, the time left, and Approve/Deny
 * as plain buttons in the card (no dialog or portal, so the CSP stays as
 * decision 0038 left it). After it ends the card says who decided and when,
 * or that it expired.
 */

import {
  type AppendMessage,
  type AssistantRuntime,
  AssistantRuntimeProvider,
  MessagePrimitive,
  type ThreadMessageLike,
  type ToolCallMessagePartComponent,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import {
  AssistantMessage as RegistryAssistantMessage,
  Thread as RegistryThread,
  type ThreadComponents,
} from "@/components/assistant-ui/elements/thread.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type ApprovalCard,
  type HearthToolStatus,
  hearthToolStatus,
  liveOutputOf,
  TOOL_STATUS_LABEL,
  toolTarget,
  wasInterrupted,
} from "./hearthPi";

const STATUS_VARIANT: Record<
  HearthToolStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  running: "secondary",
  ok: "outline",
  error: "destructive",
  "outcome-unknown": "destructive",
  interrupted: "secondary",
};

/** What the cards need to show and decide approvals: from the session page. */
export interface ApprovalActions {
  /** The approval of each held tool call, by tool call id. */
  readonly approvals: Readonly<Record<string, ApprovalCard>>;
  readonly decide: (approvalId: string, decision: "approve" | "deny") => Promise<unknown>;
}

const NO_APPROVALS: ApprovalActions = { approvals: {}, decide: async () => undefined };

export const ApprovalContext = createContext<ApprovalActions>(NO_APPROVALS);

/** The current time, ticking every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** `m:ss` of a duration in ms, never negative. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** How an ended approval reads on its card. */
export function approvalEnding(card: ApprovalCard): string {
  const when = card.at === null ? "" : ` at ${new Date(card.at).toLocaleTimeString()}`;
  switch (card.status) {
    case "approved":
      return `Approved by ${card.by ?? "the owner"}${when}.`;
    case "denied":
      return `Denied by ${card.by ?? "the owner"}${when}. Not run.`;
    case "expired":
      return `Expired${when}: no decision in time. Not run.`;
    case "cancelled":
      return `Cancelled${when}${card.why === null ? "" : ` (${card.why})`}. Not run.`;
    case "interrupted":
      return "The hub restarted before a decision. Not run.";
    default:
      return "";
  }
}

/** The approval branch of a tool card: pending (buttons, countdown) or how it ended. */
function ApprovalPanel({ card }: { card: ApprovalCard }) {
  const { decide } = useContext(ApprovalContext);
  const pending = card.status === "pending";
  const now = useNow(pending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      await decide(card.id, decision);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!pending) {
    return (
      <p className="mb-2 text-muted-foreground text-xs" data-testid="approval-ended">
        {approvalEnding(card)}
      </p>
    );
  }
  return (
    <section
      aria-label="Approval needed"
      data-testid="approval"
      className="mb-2 flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-2"
    >
      <p className="font-medium">
        Approve this {card.rule === "marked-secret" ? "use" : "command"}?
      </p>
      <code
        className="break-all rounded-sm bg-amber-500/15 px-1 font-mono text-xs"
        data-testid="approval-summary"
      >
        {card.summary}
      </code>
      {card.hiddenChars ? (
        <p className="font-medium text-amber-600 text-xs" data-testid="approval-hidden-chars">
          Contains hidden characters (shown as ⟨U+XXXX⟩): read it closely.
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Rule <code className="font-mono">{card.rule}</code>
        {card.reason === "" ? null : `: ${card.reason}`}
      </p>
      {card.command === "" ? null : (
        // The whole command, never cut (research m3 Q3): the matched part
        // alone could hide `; touch x` or a pipe to `curl`. Wrapped, not
        // scrolled or clipped, so nothing is out of sight.
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            {card.command === card.summary
              ? "Full command:"
              : "Full command (Approve runs all of it, not only the part above):"}
          </p>
          <pre
            className="whitespace-pre-wrap break-all rounded-sm border bg-muted/40 p-1 font-mono text-xs"
            data-testid="approval-command"
          >
            {card.command}
          </pre>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Denied automatically in{" "}
        <span data-testid="approval-countdown">{countdown(card.expiresAt - now)}</span>
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void act("approve")}>
          Approve
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("deny")}>
          Deny
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </section>
  );
}

/** A tool call: assistant-ui's collapsible tool UI with Hearth's status and target. */
export const ToolCard: ToolCallMessagePartComponent = (part) => {
  const approval = useContext(ApprovalContext).approvals[part.toolCallId];
  const interrupted = useAuiState((s) =>
    wasInterrupted(s.message.metadata.custom, part.toolCallId),
  );
  const status = hearthToolStatus(part, interrupted);
  // Two primitive selections, so the card re-renders only when they change.
  const liveText = useAuiState(
    (s) => liveOutputOf(s.message.metadata.custom, part.toolCallId)?.text,
  );
  const liveCapped = useAuiState(
    (s) => liveOutputOf(s.message.metadata.custom, part.toolCallId)?.truncated === true,
  );
  const waiting = approval?.status === "pending" && status === "running";
  const label = waiting ? "needs approval" : TOOL_STATUS_LABEL[status];
  const target = toolTarget(part.toolName, part.args);
  return (
    <ToolFallback.Root
      className="my-2 rounded-md border bg-card px-3 text-sm"
      data-testid="tool-card"
      data-status={waiting ? "approval" : status}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ToolFallback.Trigger
          toolName={part.toolName}
          status={
            status === "interrupted"
              ? { type: "incomplete", reason: "cancelled" }
              : status === "running"
                ? { type: "running" }
                : { type: "complete" }
          }
          isError={status === "error" || status === "outcome-unknown"}
          aria-label={`Tool call ${part.toolName}: ${label}`}
          className="shrink-0"
        />
        <code className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{target}</code>
        <Badge variant={STATUS_VARIANT[status]} className="shrink-0">
          {label}
        </Badge>
      </div>
      {approval === undefined || (approval.status === "pending" && !waiting) ? null : (
        <ApprovalPanel card={approval} />
      )}
      {status === "running" && liveText !== undefined ? (
        // Live output (decision 0036): outside the collapsed details, so it shows
        // while the call runs. The result replaces it when the call ends.
        <pre
          role="log"
          aria-label={`Live output of ${part.toolName}`}
          data-testid="live-output"
          className="mb-2 max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-foreground/90 text-xs break-words whitespace-pre-wrap"
        >
          {liveText}
          {liveCapped ? "\n… (live output stopped at its cap; the result has the rest)" : null}
        </pre>
      ) : null}
      <ToolFallback.Content>
        {status === "outcome-unknown" ? (
          <Alert variant="destructive" data-testid="outcome-unknown">
            <AlertDescription>
              The box restarted during this call. It may or may not have taken effect, and it was
              not run again.
            </AlertDescription>
          </Alert>
        ) : null}
        <ToolFallback.Args argsText={part.argsText} />
        {part.result === undefined ? (
          <p className="text-muted-foreground text-xs">
            {status === "running" ? "…" : "(no output)"}
          </p>
        ) : (
          <ToolFallback.Result result={part.result} />
        )}
      </ToolFallback.Content>
    </ToolFallback.Root>
  );
};

/** Hearth's own notices (runner failed, interrupted) arrive as system messages. */
export function NoticeMessage({ tone }: { tone: unknown }) {
  return (
    <MessagePrimitive.Root
      className={cn(
        "px-2 text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      role={tone === "error" ? "alert" : undefined}
      data-testid="notice"
    >
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

/** The registry's assistant message, or Hearth's notice for a system message. */
function AssistantOrNotice() {
  const role = useAuiState((s) => s.message.role);
  const tone = useAuiState((s) => s.message.metadata.custom["tone"]);
  return role === "system" ? <NoticeMessage tone={tone} /> : <RegistryAssistantMessage />;
}

function EmptyThread() {
  return (
    <p className="mb-6 px-2 text-muted-foreground">No messages yet. Ask for something below.</p>
  );
}

/**
 * Tool calls stay flat, one card each, so every card keeps its stable name
 * (`Tool call <tool>: <status>`) on screen instead of inside a collapsed group.
 */
function FlatToolGroup({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

const THREAD_COMPONENTS: ThreadComponents = {
  AssistantMessage: AssistantOrNotice,
  ToolFallback: ToolCard,
  ToolGroup: FlatToolGroup,
  Welcome: EmptyThread,
};

/** The text of a composer message, trimmed. */
export function messageText(message: Pick<AppendMessage, "content">): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

/**
 * Sends what the composer submitted. assistant-ui clears the composer before
 * `onNew` runs, so a send that fails puts the text back (unless something new
 * was typed meanwhile); the page shows the error.
 */
export async function sendFromComposer(
  text: string,
  send: (text: string) => Promise<void>,
  composer: { getState(): { text: string }; setText(text: string): void },
): Promise<void> {
  if (text === "") return;
  try {
    await send(text);
  } catch {
    if (composer.getState().text === "") composer.setText(text);
  }
}

export interface ChatRuntimeProps {
  readonly messages: readonly ThreadMessageLike[];
  readonly isRunning: boolean;
  readonly onSend: (text: string) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly children: ReactNode;
}

/** Hearth owns the messages; assistant-ui renders them and drives the composer. */
export function ChatRuntime({
  messages,
  isRunning,
  onSend,
  onInterrupt,
  children,
}: ChatRuntimeProps) {
  const runtime: AssistantRuntime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    isRunning,
    onNew: (message) => sendFromComposer(messageText(message), onSend, runtime.thread.composer),
    onCancel: onInterrupt,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** The registry thread with Hearth's slots; no autofocus, so a phone keyboard stays down on load. */
export function Thread() {
  return <RegistryThread components={THREAD_COMPONENTS} autoFocus={false} />;
}
