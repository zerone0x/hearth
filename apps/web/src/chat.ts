/**
 * Builds the chat from the session's event log (decision 0015): the user's
 * `message.user`, pi's `pi.*` events and the runner's `runner.*` notices.
 * Pure, so a reload rebuilds the same chat from the log and then continues
 * from the last cursor.
 */

import type { HubEvent } from "./api";

export type ToolStatus = "running" | "ok" | "error" | "outcome-unknown" | "interrupted";

export type ChatItem =
  | { readonly kind: "user"; readonly key: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly callId: string;
      readonly name: string;
      /** The command or path the call acts on, for the card's title. */
      readonly target: string;
      readonly output: string;
      readonly status: ToolStatus;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly tone: "info" | "error";
      readonly text: string;
    };

export interface ChatState {
  readonly items: readonly ChatItem[];
  /** Seq of the last event applied: the cursor to resume from. */
  readonly cursor: number;
  /** A turn is in flight (a message was sent and the agent has not ended). */
  readonly running: boolean;
}

export const EMPTY_CHAT: ChatState = { items: [], cursor: 0, running: false };

/** A tool error that means the box restarted mid-call (PRD §6.3, protocol `tool.outcome-unknown`). */
const OUTCOME_UNKNOWN = /tool\.outcome-unknown|outcome (?:of this call )?is unknown/i;

/** At most this much of a tool's output is kept per card. */
export const MAX_TOOL_OUTPUT = 64 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The text parts of a pi message or tool result (`content: [{type: "text", text}]`). */
export function textOf(value: unknown): string {
  const content = record(value)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = record(part);
      return p["type"] === "text" && typeof p["text"] === "string" ? p["text"] : "";
    })
    .join("");
}

/** What a tool call acts on: the shell command, else the path, else the pattern. */
export function toolTarget(name: string, args: unknown): string {
  const a = record(args);
  const str = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : undefined);
  if (name === "bash") return str("command") ?? "";
  const path = str("path");
  const pattern = str("pattern");
  if (pattern !== undefined) return path === undefined ? pattern : `${pattern} in ${path}`;
  return path ?? "";
}

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)` : text;
}

function replaceLast(
  items: readonly ChatItem[],
  match: (item: ChatItem) => boolean,
  update: (item: ChatItem) => ChatItem,
): readonly ChatItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as ChatItem;
    if (match(item)) return [...items.slice(0, i), update(item), ...items.slice(i + 1)];
  }
  return items;
}

/** Applies one event. Events at or before the cursor are ignored, so a page can be re-read safely. */
export function applyEvent(state: ChatState, event: HubEvent): ChatState {
  if (event.seq <= state.cursor) return state;
  const p = record(event.payload);
  const key = `e${event.seq}`;
  let { items, running } = state;
  switch (event.type) {
    case "message.user":
      items = [
        ...items,
        { kind: "user", key, text: typeof p["text"] === "string" ? p["text"] : "" },
      ];
      running = true;
      break;
    case "pi.agent_start":
      running = true;
      break;
    case "pi.message_start":
    case "pi.message_update":
    case "pi.message_end": {
      const message = record(p["message"]);
      if (message["role"] !== "assistant") break;
      const text = textOf(message);
      const streaming = event.type !== "pi.message_end";
      const last = items.at(-1);
      if (event.type !== "pi.message_start" && last?.kind === "assistant" && last.streaming) {
        items = [...items.slice(0, -1), { ...last, text, streaming }];
      } else {
        items = [...items, { kind: "assistant", key, text, streaming }];
      }
      break;
    }
    case "pi.tool_execution_start": {
      const name = typeof p["toolName"] === "string" ? p["toolName"] : "tool";
      items = [
        ...items,
        {
          kind: "tool",
          key,
          callId: String(p["toolCallId"] ?? key),
          name,
          target: toolTarget(name, p["args"]),
          output: "",
          status: "running",
        },
      ];
      break;
    }
    case "pi.tool_execution_update":
    case "pi.tool_execution_end": {
      const callId = String(p["toolCallId"] ?? "");
      const end = event.type === "pi.tool_execution_end";
      const output = clip(textOf(end ? p["result"] : p["partialResult"]));
      items = replaceLast(
        items,
        (item) => item.kind === "tool" && item.callId === callId,
        (item) => {
          if (item.kind !== "tool") return item;
          if (!end) return { ...item, output };
          const status: ToolStatus =
            p["isError"] === true
              ? OUTCOME_UNKNOWN.test(output)
                ? "outcome-unknown"
                : "error"
              : "ok";
          return { ...item, output, status };
        },
      );
      break;
    }
    case "pi.agent_end":
      running = false;
      items = items.map((item) =>
        item.kind === "tool" && item.status === "running"
          ? { ...item, status: "interrupted" }
          : item.kind === "assistant" && item.streaming
            ? { ...item, streaming: false }
            : item,
      );
      break;
    case "runner.interrupted":
      items = [...items, { kind: "notice", key, tone: "info", text: "Interrupted." }];
      break;
    case "runner.failed":
      running = false;
      items = [
        ...items,
        {
          kind: "notice",
          key,
          tone: "error",
          text: `The runner failed: ${typeof p["message"] === "string" ? p["message"] : "unknown error"}`,
        },
      ];
      break;
    default:
      break;
  }
  return { items, cursor: event.seq, running };
}

export function applyEvents(state: ChatState, events: readonly HubEvent[]): ChatState {
  return events.reduce(applyEvent, state);
}
