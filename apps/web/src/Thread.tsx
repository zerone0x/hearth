/**
 * The chat view: assistant-ui's primitives over Hearth's event log
 * (`hearthPi.ts`) through `useExternalStoreRuntime`. Tool calls render with
 * assistant-ui's tool-call UI (`ToolFallback`, from its shadcn registry),
 * labelled with Hearth's tool states.
 */

import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      className="rounded-md border bg-card px-3 text-sm"
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
          <Alert variant="destructive">
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

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-primary-foreground">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      className="flex max-w-[95%] flex-col gap-2 whitespace-pre-wrap"
      data-testid="assistant"
    >
      <MessagePrimitive.Parts components={{ tools: { Fallback: ToolCard } }} />
    </MessagePrimitive.Root>
  );
}

/** Hearth's own notices (runner failed, interrupted) arrive as system messages. */
function NoticeMessage({ tone }: { tone: unknown }) {
  return (
    <MessagePrimitive.Root
      className={cn("text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}
      role={tone === "error" ? "alert" : undefined}
    >
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
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
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    isRunning,
    onNew: async (message) => {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      if (text !== "") await onSend(text);
    },
    onCancel: onInterrupt,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function Thread({ error }: { error?: string | undefined }) {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        data-testid="chat"
      >
        <ThreadPrimitive.Empty>
          <p className="text-muted-foreground">No messages yet. Ask for something below.</p>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? (
              <UserMessage />
            ) : message.role === "system" ? (
              <NoticeMessage tone={message.metadata.custom["tone"]} />
            ) : (
              <AssistantMessage />
            )
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      {error === undefined ? null : (
        <Alert variant="destructive" className="mx-4 w-auto" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ComposerPrimitive.Root className="flex items-end gap-2 border-t bg-card p-3">
        <ComposerPrimitive.Input
          aria-label="Message"
          placeholder="Message"
          rows={2}
          className="max-h-40 min-h-11 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
        />
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <Button>
              <ArrowUpIcon aria-hidden />
              Send
            </Button>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button variant="destructive">
              <SquareIcon aria-hidden />
              Interrupt
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
