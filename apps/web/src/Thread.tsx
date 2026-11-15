/**
 * The chat view: assistant-ui's registry `Thread` (thread, messages,
 * composer) over Hearth's event log (`hearthPi.ts`) through
 * `useExternalStoreRuntime`. Hearth plugs its own pieces in through the
 * registry component's slots: tool cards (`ToolFallback`), its notices
 * (`AssistantMessage`, for system messages) and the empty state (`Welcome`).
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
import type { ReactNode } from "react";
import {
  AssistantMessage as RegistryAssistantMessage,
  Thread as RegistryThread,
  type ThreadComponents,
} from "@/components/assistant-ui/elements/thread.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type HearthToolStatus, hearthToolStatus, TOOL_STATUS_LABEL, toolTarget } from "./hearthPi";

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

/** A tool call: assistant-ui's collapsible tool UI with Hearth's status and target. */
export const ToolCard: ToolCallMessagePartComponent = (part) => {
  const status = hearthToolStatus(part);
  const label = TOOL_STATUS_LABEL[status];
  const target = toolTarget(part.toolName, part.args);
  return (
    <ToolFallback.Root
      className="my-2 rounded-md border bg-card px-3 text-sm"
      data-testid="tool-card"
      data-status={status}
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
