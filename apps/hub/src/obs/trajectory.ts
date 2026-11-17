/**
 * The session trajectory (decision 0021): a projection of the append-only
 * event log, schema `hearth.trajectory/2`, one JSON object per line.
 *
 * Lines, in event order: one `session` header; `user_input`, `context` (the
 * AGENTS.md files the runner read from the box), `turn_start`, `model_call`, `tool_call`, `turn_end`, `box`, `outcome_unknown`,
 * `runner_failed` and `label` records; one `summary` at the end. Every record
 * carries `session_id`, `seq`, `at` (wall clock), `turn_id`, `step_id`,
 * `tool_call_id`, `box_id`, `trace_id`, `span_id`, `pi_version` and
 * `hub_version` (null where they do not apply). Model and tool steps add
 * `mono_ms` (monotonic) and their durations.
 *
 * `/2` (rework of #80): a `model_call` carries its `request` (model, thinking
 * level, max tokens, temperature, tool names and hash, system prompt size and
 * hash, and its text on the first call of each prompt version, message count) and its `output` (text, thinking, tool calls with their
 * arguments); `user_input` prompts and every kept text are capped at 16 KiB of
 * UTF-8 with their byte count and sha256. Events written before `/2` project
 * with `request: null` and `output: null`. A `tool_call` carries
 * `access_mode` (`yolo` or `ask`, decision 0045), an added field; calls
 * recorded before it project with `access_mode: null`. A call the access
 * gate held for the owner also carries `approval` (`id`, `rule`, `decision`,
 * `decided_by`, `waited_ms`), and each `approval.*` event is an `approval`
 * record (decision 0048); both are added fields and kinds under `/2`.
 *
 * Built at read time, so older sessions get the current projection and the
 * log stays the only source of truth. Payloads were redacted when written:
 * the runner's events by the runner, and an `approval.requested` event's
 * `summary`, `command` and `reason` by the access gate, with the runner's
 * redaction, before `Approvals.request` records them (access.ts
 * `shownVerdict`); the other `approval.*` events hold ids, times and fixed
 * reasons only.
 */

import type { StoredEvent } from "@hearth/core";
import { capText, type Redact } from "./cap";

export const TRAJECTORY_SCHEMA = "hearth.trajectory/2";

/** Outcome labels (issue #80): placeholders the UI or the API sets, Retro later. */
export const LABEL_OUTCOMES = ["success", "partial", "fail", "abandoned"] as const;
export type LabelOutcome = (typeof LABEL_OUTCOMES)[number];

export interface Label {
  readonly task_type?: string;
  readonly outcome?: LabelOutcome;
  readonly verdict?: string;
}

export type TrajectoryRecord = Record<string, unknown> & {
  readonly schema: typeof TRAJECTORY_SCHEMA;
  readonly kind: string;
  readonly session_id: string;
};

type Payload = Record<string, unknown>;

const BOX_EVENTS = new Set([
  "session.state",
  "session.operation",
  "box.failed",
  "box.restarted",
  // The hub declared the box connection dead (decision 0028).
  "box.connection-dead",
]);

function obj(value: unknown): Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface TrajectoryOptions {
  readonly sessionId: string;
  /** Used before the first turn records its own. */
  readonly versions: { readonly pi: string; readonly hub: string };
  readonly now?: () => number;
  /**
   * Applied to texts the runner did not redact when it wrote them (the
   * AGENTS.md content of `runner.context`), before they are capped.
   */
  readonly redact?: Redact;
}

/** Build the trajectory from a session's events, oldest first. */
export function buildTrajectory(
  events: readonly StoredEvent[],
  options: TrajectoryOptions,
): TrajectoryRecord[] {
  const out: TrajectoryRecord[] = [];
  let versions = { pi: options.versions.pi, hub: options.versions.hub };
  let traceId: string | null = null;
  let boxId: string | null = null;
  const turnTrace = new Map<string, string>();
  const sessionLabel: Record<string, unknown> = {};
  const turnLabels = new Map<string, Record<string, unknown>>();
  const sum = {
    turns: 0,
    turns_by_outcome: {} as Record<string, number>,
    model_calls: 0,
    model_errors: 0,
    tool_calls: 0,
    tool_failures_by_class: {} as Record<string, number>,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost_usd: 0,
    model_latency_ms: 0,
    tool_duration_ms: 0,
    box_wait_ms: { total: 0, max: 0, count: 0 },
    interrupts: 0,
    outcome_unknown: 0,
  };

  const base = (e: StoredEvent, extra: Payload = {}): TrajectoryRecord => {
    const turnId = e.turnId ?? str(extra["turn_id"]) ?? null;
    return {
      schema: TRAJECTORY_SCHEMA,
      kind: "unknown",
      session_id: e.sessionId,
      seq: e.seq,
      at: new Date(e.ts).toISOString(),
      turn_id: turnId,
      step_id: null,
      tool_call_id: null,
      box_id: boxId,
      trace_id: (turnId === null ? null : turnTrace.get(turnId)) ?? traceId,
      span_id: null,
      pi_version: versions.pi,
      hub_version: versions.hub,
      ...extra,
    };
  };

  for (const e of events) {
    const p = obj(e.payload);
    switch (e.type) {
      case "message.user":
        out.push({
          ...base(e),
          kind: "user_input",
          input: "prompt",
          prompt: typeof p["text"] === "string" ? capText(p["text"]) : null,
        });
        break;
      case "runner.interrupted":
        sum.interrupts++;
        out.push({
          ...base(e),
          kind: "user_input",
          input: "interrupt",
          reason: p["reason"] ?? null,
        });
        break;
      case "runner.turn.start": {
        versions = {
          pi: str(p["pi_version"]) ?? versions.pi,
          hub: str(p["hub_version"]) ?? versions.hub,
        };
        traceId = str(p["trace_id"]);
        const turnId = str(p["turn_id"]);
        if (turnId !== null && traceId !== null) turnTrace.set(turnId, traceId);
        out.push({ ...base(e, p), kind: "turn_start" });
        break;
      }
      case "runner.turn.end": {
        sum.turns++;
        const outcome = String(p["outcome"] ?? "unknown");
        sum.turns_by_outcome[outcome] = (sum.turns_by_outcome[outcome] ?? 0) + 1;
        const turnId = str(p["turn_id"]);
        out.push({
          ...base(e, p),
          kind: "turn_end",
          labels: (turnId === null ? undefined : turnLabels.get(turnId)) ?? null,
        });
        break;
      }
      case "runner.step": {
        const kind = p["kind"] === "tool_call" ? "tool_call" : "model_call";
        if (kind === "tool_call") {
          if (typeof p["box_id"] === "string") boxId = p["box_id"];
          sum.tool_calls++;
          const outcome = String(p["outcome"] ?? "unknown");
          if (outcome !== "ok") {
            sum.tool_failures_by_class[outcome] = (sum.tool_failures_by_class[outcome] ?? 0) + 1;
          }
          if (outcome === "outcome-unknown") sum.outcome_unknown++;
          sum.tool_duration_ms += num(p["duration_ms"]);
          const wait = num(p["box_wait_ms"]);
          sum.box_wait_ms.total += wait;
          sum.box_wait_ms.max = Math.max(sum.box_wait_ms.max, wait);
          sum.box_wait_ms.count++;
        } else {
          sum.model_calls++;
          if (p["error_class"] !== null && p["error_class"] !== undefined) sum.model_errors++;
          const t = obj(p["tokens"]);
          sum.tokens.input += num(t["input"]);
          sum.tokens.output += num(t["output"]);
          sum.tokens.cache_read += num(t["cache_read"]);
          sum.tokens.cache_write += num(t["cache_write"]);
          sum.cost_usd += num(obj(p["cost_usd"])["total"]);
          sum.model_latency_ms += num(p["latency_ms"]);
        }
        const { kind: _kind, ...rest } = p;
        out.push({
          ...base(e, rest),
          kind,
          ...(kind === "model_call"
            ? { request: p["request"] ?? null, output: p["output"] ?? null }
            : // Added in /2 (decision 0045): null on calls recorded before the setting.
              { access_mode: p["access_mode"] ?? null }),
        });
        break;
      }
      case "runner.outcome-unknown":
        sum.outcome_unknown += Array.isArray(p["toolCallIds"]) ? p["toolCallIds"].length : 1;
        out.push({
          ...base(e),
          kind: "outcome_unknown",
          reason: p["reason"] ?? null,
          tool_call_ids: p["toolCallIds"] ?? [],
        });
        break;
      case "runner.context": {
        // What pi read as context files: the system prompt is built from them.
        const files = Array.isArray(p["files"]) ? (p["files"] as unknown[]) : [];
        out.push({
          ...base(e),
          kind: "context",
          files: files.map((f) => {
            const file = obj(f);
            const content = str(file["content"]);
            return {
              path: str(file["path"]),
              content: content === null ? null : capText(content, options.redact),
            };
          }),
        });
        break;
      }
      case "runner.failed":
        out.push({ ...base(e), kind: "runner_failed", error: p["message"] ?? null });
        break;
      case "trajectory.label": {
        const turnId = str(p["turn_id"]);
        const { turn_id: _t, ...label } = p;
        if (turnId === null) Object.assign(sessionLabel, label);
        else turnLabels.set(turnId, { ...turnLabels.get(turnId), ...label });
        out.push({ ...base(e), kind: "label", turn_id: turnId, label });
        break;
      }
      default:
        if (e.type.startsWith("approval.")) {
          // The approval lifecycle (decision 0048): who decided what, and when (`at`).
          const { approvalId, toolCallId, ...detail } = p;
          out.push({
            ...base(e),
            kind: "approval",
            event: e.type.slice("approval.".length),
            approval_id: approvalId ?? null,
            tool_call_id: toolCallId ?? null,
            detail,
          });
        } else if (BOX_EVENTS.has(e.type)) {
          const id = str(p["boxId"]) ?? str(p["box_id"]);
          if (id !== null) boxId = id;
          out.push({ ...base(e), kind: "box", op: e.type, detail: e.payload });
        }
    }
  }

  // A label set after its turn ended still belongs on the turn's end record.
  for (const [i, r] of out.entries()) {
    const turnId = r["turn_id"];
    if (r.kind === "turn_end" && typeof turnId === "string" && turnLabels.has(turnId)) {
      out[i] = { ...r, labels: turnLabels.get(turnId) };
    }
  }
  const sessionId = options.sessionId;
  const header: TrajectoryRecord = {
    schema: TRAJECTORY_SCHEMA,
    kind: "session",
    session_id: sessionId,
    generated_at: new Date((options.now ?? Date.now)()).toISOString(),
    events: events.length,
    last_seq: events.at(-1)?.seq ?? 0,
    pi_version: versions.pi,
    hub_version: versions.hub,
  };
  const summary: TrajectoryRecord = {
    schema: TRAJECTORY_SCHEMA,
    kind: "summary",
    session_id: sessionId,
    ...sum,
    labels: Object.keys(sessionLabel).length === 0 ? null : sessionLabel,
    pi_version: versions.pi,
    hub_version: versions.hub,
  };
  return [header, ...out, summary];
}

/** JSON Lines, one record per line, with a final newline. */
export function toJsonl(records: readonly TrajectoryRecord[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}
