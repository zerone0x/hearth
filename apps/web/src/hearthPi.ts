/**
 * Hearth's event log (decision 0015) as assistant-ui messages.
 *
 * The runner records every pi AgentSession event as `pi.<type>` with a
 * monotonic `seq`. `@assistant-ui/react-pi` ships a pure reducer over exactly
 * those events and a projection into assistant-ui's `ThreadMessageLike`, so
 * this module only adapts the envelope (strip `pi.`, keep the seq) and adds
 * what pi has no notion of:
 *
 * - `message.user`, recorded by the hub before the runner starts: shown as a
 *   pending user message until pi's own user `message_start` arrives;
 * - a tool call the user interrupted: the hub records `runner.interrupted`
 *   and then aborts pi, so pi ends the call in flight as an error; a call
 *   that ends with an error after `runner.interrupted` and before the turn
 *   ends shows as interrupted, not as a failure;
 * - `runner.gateway` (the model gateway refused a call: budget or rate limit,
 *   decision 0047) shows as an error notice; the session stays usable.
 * - `runner.failed` (an error that ends the turn) and `runner.interrupted`
 *   (a notice), shown as system messages where they happened;
 * - Hearth's tool states (`hearthToolStatus`): done, error, outcome unknown
 *   (PRD §6.3) and interrupted (still running when the turn ended);
 * - the 64 KiB cap on a tool's output;
 * - live output of a running `bash` call (`tool.output`, decision 0036),
 *   shown until the call's result replaces it;
 * - the approvals of calls the access gate held (`approval.*`, decision
 *   0048), by tool call id, for the card's Approve/Deny branch.
 *
 * Pure, so a reload rebuilds the same chat from the log and then continues
 * from the cursor.
 */

import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  createPiThreadState,
  type PiClientEvent,
  type PiThreadState,
  projectPiThreadMessages,
  reducePiThreadState,
} from "@assistant-ui/react-pi";
import { escapeHidden } from "@hearth/core";
import type { HubEvent } from "./api";

/** At most this much of a tool's output is kept per card. */
export const MAX_TOOL_OUTPUT = 64 * 1024;

/** A tool error that means the box restarted mid-call (PRD §6.3, protocol `tool.outcome-unknown`). */
const OUTCOME_UNKNOWN = /tool\.outcome-unknown|outcome (?:of this call )?is unknown/i;

export interface Notice {
  readonly seq: number;
  readonly tone: "info" | "error";
  readonly text: string;
  /** How many pi transcript messages existed when it happened: where it shows. */
  readonly at: number;
}

export interface HearthChat {
  readonly pi: PiThreadState;
  /** Seq of the last event applied, of any kind: the cursor to resume from. */
  readonly cursor: number;
  /** `message.user` texts not yet mirrored by pi's own user message. */
  readonly pending: readonly { readonly seq: number; readonly text: string }[];
  readonly notices: readonly Notice[];
  /** A `runner.interrupted` arrived and the turn has not ended yet. */
  readonly interrupting: boolean;
  /** Tool calls the interrupt cut off: they ended with an error while `interrupting`. */
  readonly interruptedCalls: readonly string[];
  /** Live output of running tool calls by tool call id, until each one ends. */
  readonly live: Readonly<Record<string, LiveOutput>>;
  /** The approval of each tool call the access gate held, by tool call id (decision 0048). */
  readonly approvals: Readonly<Record<string, ApprovalCard>>;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "interrupted";

/** One approval as the card shows it, folded from its `approval.*` events. */
export interface ApprovalCard {
  readonly id: string;
  readonly toolCallId: string;
  /** The part that decided (the matched sub-command), redacted by the hub. */
  readonly summary: string;
  /** The whole command (redacted by the hub), always shown; "" for a tool without one. */
  readonly command: string;
  readonly rule: string;
  readonly reason: string;
  /** The shown text holds hidden characters the hub wrote out as `⟨U+XXXX⟩` (#165). */
  readonly hiddenChars: boolean;
  /** Each simple command the hub's parser found, escaped; listed under the full command (#169). */
  readonly steps: readonly string[];
  /** How many steps the hub's cap left out of `steps` (#171). */
  readonly stepsOmitted: number;
  /** The command holds a non-ASCII character (#169). */
  readonly nonAscii: boolean;
  readonly expiresAt: number;
  readonly status: ApprovalStatus;
  /** Who decided (`user:<id>`), for approved and denied. */
  readonly by: string | null;
  /** When it ended (epoch ms). */
  readonly at: number | null;
  /** Why it was cancelled (`new message`, `stopped`). */
  readonly why: string | null;
}

const APPROVAL_ENDS: ReadonlySet<string> = new Set([
  "approved",
  "denied",
  "expired",
  "cancelled",
  "interrupted",
]);

/** The streamed output of a running call so far (redacted by the hub). */
export interface LiveOutput {
  readonly text: string;
  /** The hub stopped streaming at its cap; the result will have the rest. */
  readonly truncated: boolean;
}

export function emptyChat(sessionId: string): HearthChat {
  return {
    pi: createPiThreadState(sessionId),
    cursor: 0,
    pending: [],
    notices: [],
    interrupting: false,
    interruptedCalls: [],
    live: {},
    approvals: {},
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A Hearth `pi.<type>` event as react-pi's client event; anything else is not pi's. */
export function toPiClientEvent(threadId: string, event: HubEvent): PiClientEvent | null {
  if (!event.type.startsWith("pi.")) return null;
  return {
    ...record(event.payload),
    type: event.type.slice("pi.".length),
    threadId,
    seq: event.seq,
  } as PiClientEvent;
}

/** Applies one event. Events at or before the cursor are ignored, so a page can be re-read safely. */
export function applyHubEvent(chat: HearthChat, event: HubEvent): HearthChat {
  if (event.seq <= chat.cursor) return chat;
  const p = record(event.payload);
  let { pi, pending, notices, interrupting, interruptedCalls, live, approvals } = chat;
  const notice = (tone: Notice["tone"], text: string) => [
    ...notices,
    { seq: event.seq, tone, text, at: pi.messages.length },
  ];
  switch (event.type) {
    case "message.user":
      pending = [
        ...pending,
        { seq: event.seq, text: typeof p["text"] === "string" ? p["text"] : "" },
      ];
      break;
    case "runner.interrupted":
      notices = notice("info", "Interrupted.");
      interrupting = true;
      break;
    case "tool.output": {
      const id = p["toolCallId"];
      // A late chunk of a call that already ended is dropped: its result is in.
      const state = typeof id === "string" ? pi.toolExecutions[id]?.status : undefined;
      if (typeof id !== "string" || (state !== undefined && state !== "running")) break;
      const before = live[id] ?? { text: "", truncated: false };
      const text = before.text + (typeof p["text"] === "string" ? p["text"] : "");
      live = {
        ...live,
        [id]: {
          text: text.length > MAX_TOOL_OUTPUT ? text.slice(text.length - MAX_TOOL_OUTPUT) : text,
          truncated: before.truncated || p["truncated"] === true,
        },
      };
      break;
    }
    case "runner.gateway":
      // The model gateway refused a call (402 budget, 429 rate limit; decision 0047).
      notices = notice(
        "error",
        typeof p["message"] === "string" ? p["message"] : "The model gateway refused the call.",
      );
      break;
    case "approval.requested": {
      const call = p["toolCallId"];
      const id = p["approvalId"];
      if (typeof call !== "string" || typeof id !== "string") break;
      const text = (key: string) => (typeof p[key] === "string" ? (p[key] as string) : "");
      approvals = {
        ...approvals,
        [call]: {
          id,
          toolCallId: call,
          summary: text("summary"),
          command: text("command"),
          rule: text("rule"),
          reason: text("reason"),
          hiddenChars: p["hidden_chars"] === true,
          steps: Array.isArray(p["steps"])
            ? p["steps"].filter((s): s is string => typeof s === "string")
            : [],
          stepsOmitted: typeof p["steps_omitted"] === "number" ? p["steps_omitted"] : 0,
          nonAscii: p["non_ascii"] === true,
          expiresAt: typeof p["expiresAt"] === "number" ? p["expiresAt"] : event.ts,
          status: "pending",
          by: null,
          at: null,
          why: null,
        },
      };
      break;
    }
    case "approval.approved":
    case "approval.denied":
    case "approval.expired":
    case "approval.cancelled":
    case "approval.interrupted": {
      const call = p["toolCallId"];
      const status = event.type.slice("approval.".length);
      const before = typeof call === "string" ? approvals[call] : undefined;
      if (before === undefined || before.id !== p["approvalId"] || !APPROVAL_ENDS.has(status)) {
        break;
      }
      approvals = {
        ...approvals,
        [before.toolCallId]: {
          ...before,
          status: status as ApprovalStatus,
          by: typeof p["by"] === "string" ? p["by"] : null,
          at: typeof p["at"] === "number" ? p["at"] : event.ts,
          why: typeof p["why"] === "string" ? p["why"] : null,
        },
      };
      break;
    }
    case "runner.failed":
      notices = notice(
        "error",
        `The runner failed: ${typeof p["message"] === "string" ? p["message"] : "unknown error"}`,
      );
      pending = [];
      pi = reducePiThreadState(pi, {
        type: "error",
        error: "runner.failed",
        threadId: pi.threadId,
        seq: event.seq,
      });
      break;
    default: {
      const piEvent = toPiClientEvent(pi.threadId, event);
      if (piEvent === null) break;
      if (piEvent.type === "message_start" && record(piEvent.message)["role"] === "user") {
        pending = pending.slice(1);
      }
      if (piEvent.type === "agent_start" || piEvent.type === "agent_end") interrupting = false;
      if (piEvent.type === "agent_end") pending = [];
      if (
        interrupting &&
        piEvent.type === "tool_execution_end" &&
        piEvent.isError === true &&
        typeof piEvent.toolCallId === "string"
      ) {
        interruptedCalls = [...interruptedCalls, piEvent.toolCallId];
      }
      if (
        (piEvent.type === "tool_execution_end" && typeof piEvent.toolCallId === "string") ||
        piEvent.type === "agent_end"
      ) {
        live = dropLive(live, piEvent.type === "agent_end" ? null : String(piEvent.toolCallId));
      }
      pi = reducePiThreadState(pi, piEvent);
    }
  }
  return {
    pi,
    cursor: event.seq,
    pending,
    notices,
    interrupting,
    interruptedCalls,
    live,
    approvals,
  };
}

/** `live` without `toolCallId`'s entry, or empty for `null`. */
function dropLive(live: HearthChat["live"], toolCallId: string | null): HearthChat["live"] {
  if (toolCallId === null) return Object.keys(live).length === 0 ? live : {};
  if (!(toolCallId in live)) return live;
  const { [toolCallId]: _gone, ...rest } = live;
  return rest;
}

export function applyHubEvents(chat: HearthChat, events: readonly HubEvent[]): HearthChat {
  return events.reduce(applyHubEvent, chat);
}

/** Whether a tool call of this chat waits for the owner's approval now. */
export function hasPendingApproval(chat: HearthChat): boolean {
  return Object.values(chat.approvals).some((a) => a.status === "pending");
}

/** A turn is in flight: a message was sent and the agent has not ended. */
export function isRunning(chat: HearthChat): boolean {
  return chat.pi.runStatus === "running" || chat.pending.length > 0;
}

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)` : text;
}

/** The index of the first pi message a projected message came from (`pi-msg:<n>`). */
function sourceIndex(message: ThreadMessageLike): number {
  const n = Number(/^pi-msg:(\d+)$/.exec(message.id ?? "")?.[1]);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

/** The chat as assistant-ui messages: pi's projection plus Hearth's notices and pending sends. */
export function projectChat(chat: HearthChat): ThreadMessageLike[] {
  const projected = projectPiThreadMessages({
    messages: chat.pi.messages,
    toolExecutions: chat.pi.toolExecutions,
    runStatus: chat.pi.runStatus,
    hostUiRequests: chat.pi.hostUiRequests,
  }).map((message): ThreadMessageLike => {
    if (typeof message.content === "string") return message;
    const streaming: Record<string, LiveOutput> = {};
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolCallId === undefined) continue;
      const output = chat.live[part.toolCallId];
      const final = part.result !== undefined && part.isPreliminary !== true;
      if (output !== undefined && !final) streaming[part.toolCallId] = output;
    }
    const cut = message.content.flatMap((part) =>
      part.type === "tool-call" &&
      part.toolCallId !== undefined &&
      chat.interruptedCalls.includes(part.toolCallId)
        ? [part.toolCallId]
        : [],
    );
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-call" && typeof part.result === "string"
          ? { ...part, result: clip(part.result) }
          : part,
      ),
      ...(cut.length === 0 && Object.keys(streaming).length === 0
        ? {}
        : {
            metadata: {
              ...message.metadata,
              custom: {
                ...message.metadata?.custom,
                ...(cut.length === 0 ? {} : { [INTERRUPTED_CALLS]: cut }),
                ...(Object.keys(streaming).length === 0 ? {} : { [LIVE_OUTPUT]: streaming }),
              },
            },
          }),
    };
  });
  const out: ThreadMessageLike[] = [];
  let next = 0;
  for (const message of projected) {
    while (
      next < chat.notices.length &&
      (chat.notices[next] as Notice).at <= sourceIndex(message)
    ) {
      out.push(noticeMessage(chat.notices[next] as Notice));
      next += 1;
    }
    out.push(message);
  }
  for (const notice of chat.notices.slice(next)) out.push(noticeMessage(notice));
  for (const { seq, text } of chat.pending) {
    out.push({ id: `hearth-pending:${seq}`, role: "user", content: [{ type: "text", text }] });
  }
  return out;
}

function noticeMessage(notice: Notice): ThreadMessageLike {
  return {
    id: `hearth-notice:${notice.seq}`,
    role: "system",
    content: [{ type: "text", text: notice.text }],
    metadata: { custom: { tone: notice.tone } },
  };
}

export type HearthToolStatus = "running" | "ok" | "error" | "outcome-unknown" | "interrupted";

/** The label each tool status shows. */
export const TOOL_STATUS_LABEL: Readonly<Record<HearthToolStatus, string>> = {
  running: "running",
  ok: "done",
  error: "error",
  "outcome-unknown": "outcome unknown",
  interrupted: "interrupted",
};

/**
 * The key in an assistant message's `metadata.custom` that lists its tool
 * calls the user interrupted (see `HearthChat.interruptedCalls`).
 */
export const INTERRUPTED_CALLS = "hearthInterruptedCalls";

/** The key in an assistant message's `metadata.custom` with its running calls' live output. */
export const LIVE_OUTPUT = "hearthLiveOutput";

/** A running call's live output from its message's `metadata.custom`, if any. */
export function liveOutputOf(custom: unknown, toolCallId: string): LiveOutput | undefined {
  const all = record(record(custom)[LIVE_OUTPUT]);
  const entry = record(all[toolCallId]);
  return typeof entry["text"] === "string"
    ? { text: entry["text"], truncated: entry["truncated"] === true }
    : undefined;
}

/** Whether a message's `metadata.custom` lists `toolCallId` as interrupted by the user. */
export function wasInterrupted(custom: unknown, toolCallId: string): boolean {
  const ids = record(custom)[INTERRUPTED_CALLS];
  return Array.isArray(ids) && ids.includes(toolCallId);
}

/**
 * Hearth's status of a tool-call part. assistant-ui gives a call without a
 * final result its message's status, so a call with no result in a message
 * that is no longer running was cut off by the end of the turn. A call the
 * user interrupted (`interrupted`) ends as an error in pi; it shows as
 * interrupted unless the box says its outcome is unknown.
 */
export function hearthToolStatus(
  part: {
    readonly result?: unknown;
    readonly isError?: boolean | undefined;
    readonly isPreliminary?: boolean | undefined;
    readonly status: { readonly type: string };
  },
  interrupted = false,
): HearthToolStatus {
  if (part.result === undefined || part.isPreliminary === true) {
    return part.status.type === "running" ? "running" : "interrupted";
  }
  if (part.isError !== true) return "ok";
  if (OUTCOME_UNKNOWN.test(String(part.result))) return "outcome-unknown";
  return interrupted ? "interrupted" : "error";
}

/** What a tool call acts on: the shell command, else the path, else the pattern. */
export function toolTarget(name: string, args: unknown): string {
  // Hidden characters written out, as on the approval card: the header sits right above it (#167).
  return escapeHidden(rawToolTarget(name, args));
}

function rawToolTarget(name: string, args: unknown): string {
  const a = record(args);
  const str = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : undefined);
  if (name === "bash") return str("command") ?? "";
  const path = str("path");
  const pattern = str("pattern");
  if (pattern !== undefined) return path === undefined ? pattern : `${pattern} in ${path}`;
  return path ?? "";
}
