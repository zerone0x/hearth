/**
 * Turns, steps, ids and timings for one session's runner (decision 0021).
 *
 * The runner feeds it pi's session events and the box lease and tool RPC
 * hooks; it opens OpenTelemetry spans (GenAI conventions: `invoke_agent` per
 * turn, `chat` per model call, `execute_tool` per tool call, and a client span
 * per tool RPC) and hands back the `runner.turn.start`, `runner.step` and
 * `runner.turn.end` events the trajectory is built from. It never throws into
 * pi: the runner wraps every call.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Span } from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
} from "@opentelemetry/semantic-conventions/incubating";
import type { RpcOutcome, RpcTrace } from "../box/tool-rpc";
import { spanIds, type Telemetry } from "./telemetry";

/** Bytes of a tool result kept in the trajectory; the rest is summarized by size and hash. */
export const MAX_RESULT_CHARS = 16 * 1024;

export interface Clock {
  /** Wall time, epoch ms. */
  wall(): number;
  /** Monotonic ms (`performance.now()`), for durations. */
  mono(): number;
}

export const SYSTEM_CLOCK: Clock = { wall: () => Date.now(), mono: () => performance.now() };

export interface TurnTracerOptions {
  readonly sessionId: string;
  readonly telemetry: Telemetry;
  readonly versions: { readonly pi: string; readonly hub: string };
  readonly clock?: Clock;
  readonly newId?: (prefix: string) => string;
}

/** What the runner records: a type and a payload, under the current turn. */
export interface TracedEvent {
  readonly type: "runner.turn.start" | "runner.step" | "runner.turn.end";
  readonly payload: Record<string, unknown>;
}

export type TurnOutcome = "done" | "interrupted" | "failed" | "error";

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

interface RpcRecord {
  method: string;
  rpc_id: string;
  span_id: string;
  duration_ms: number;
  ok: boolean;
  error_code?: string;
  exit_code?: number | null;
}

interface ToolState {
  readonly span: Span;
  readonly stepId: string;
  readonly name: string;
  readonly args: unknown;
  readonly startedWall: number;
  readonly startedMono: number;
  readonly rpcs: RpcRecord[];
  boxId: string | undefined;
  boxWaitMs: number;
  denied: string | undefined;
}

interface Turn {
  readonly id: string;
  readonly span: Span;
  readonly startedWall: number;
  readonly startedMono: number;
  step: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  cost: number;
  model: { span: Span; stepId: string; startedWall: number; startedMono: number; firstMono: number | undefined } | undefined;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function textOf(result: unknown): { text: string; images: number } {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return { text: typeof result === "string" ? result : "", images: 0 };
  let text = "";
  let images = 0;
  for (const part of content as Array<{ type?: string; text?: unknown }>) {
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    else if (part.type === "image") images++;
  }
  return { text, images };
}

/** The size-capped tool result: head, byte count and sha256 of the full text. */
export function capResult(result: unknown): Record<string, unknown> {
  const { text, images } = textOf(result);
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    text: text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) : text,
    truncated: text.length > MAX_RESULT_CHARS,
    bytes,
    sha256: createHash("sha256").update(text).digest("hex"),
    ...(images > 0 ? { images } : {}),
  };
}

/** Why a tool call ended the way it did, from its RPCs and its result. */
export function toolOutcome(isError: boolean, text: string, rpcs: readonly RpcRecord[], denied: string | undefined): string {
  if (denied !== undefined) return "denied";
  if (rpcs.some((r) => r.error_code === "tool.outcome-unknown")) return "outcome-unknown";
  if (rpcs.some((r) => r.error_code === "tool.deadline" || r.error_code === "timed-out")) return "timeout";
  if (rpcs.some((r) => r.error_code === "aborted" || r.error_code === "cancelled")) return "aborted";
  if (!isError) return "ok";
  if (/^Command aborted/m.test(text)) return "aborted";
  if (/^Command timed out/m.test(text)) return "timeout";
  return "error";
}

export class TurnTracer {
  readonly #o: TurnTracerOptions;
  readonly #clock: Clock;
  readonly #newId: (prefix: string) => string;
  readonly #tools = new Map<string, ToolState>();
  #turn: Turn | undefined;

  constructor(options: TurnTracerOptions) {
    this.#o = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  get turnId(): string | undefined {
    return this.#turn?.id;
  }

  #stamp(at: number, mono: number) {
    return {
      at: new Date(at).toISOString(),
      mono_ms: round(mono),
    };
  }

  /** A user message starts a turn (one `invoke_agent` span). */
  startTurn(): TracedEvent {
    const startedWall = this.#clock.wall();
    const startedMono = this.#clock.mono();
    const id = this.#newId("turn");
    const span = this.#o.telemetry.startSpan("invoke_agent hearth", {
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
      [ATTR_GEN_AI_CONVERSATION_ID]: this.#o.sessionId,
      "hearth.session.id": this.#o.sessionId,
      "hearth.turn.id": id,
    }, undefined, startedWall);
    this.#turn = {
      id,
      span,
      startedWall,
      startedMono,
      step: 0,
      modelCalls: 0,
      toolCalls: 0,
      toolFailures: 0,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      cost: 0,
      model: undefined,
    };
    const ids = spanIds(span);
    return {
      type: "runner.turn.start",
      payload: {
        turn_id: id,
        trace_id: ids.traceId,
        span_id: ids.spanId,
        pi_version: this.#o.versions.pi,
        hub_version: this.#o.versions.hub,
        ...this.#stamp(startedWall, startedMono),
      },
    };
  }

  /** The turn ended: closes open spans and sums it up. */
  endTurn(outcome: TurnOutcome, error?: string): TracedEvent | undefined {
    const turn = this.#turn;
    if (turn === undefined) return undefined;
    this.#turn = undefined;
    const now = this.#clock.mono();
    turn.model?.span.end();
    for (const tool of this.#tools.values()) tool.span.end();
    this.#tools.clear();
    const t = this.#o.telemetry;
    t.metrics.turns.add(1, { "hearth.turn.outcome": outcome });
    t.endSpan(
      turn.span,
      { "hearth.turn.outcome": outcome },
      outcome === "done" ? undefined : { type: outcome, message: error ?? outcome },
    );
    return {
      type: "runner.turn.end",
      payload: {
        turn_id: turn.id,
        outcome,
        ...(error === undefined ? {} : { error }),
        duration_ms: round(now - turn.startedMono),
        model_calls: turn.modelCalls,
        tool_calls: turn.toolCalls,
        tool_failures: turn.toolFailures,
        tokens: turn.tokens,
        cost_usd: turn.cost,
        ...this.#stamp(this.#clock.wall(), now),
      },
    };
  }

  /** A pi session event; returns the step it completed, if any. */
  onEvent(event: AgentSessionEvent): TracedEvent | undefined {
    const turn = this.#turn;
    if (turn === undefined) return undefined;
    switch (event.type) {
      case "turn_start":
        this.#startModelCall(turn);
        return undefined;
      case "message_update":
        if (turn.model !== undefined && turn.model.firstMono === undefined) {
          turn.model.firstMono = this.#clock.mono();
        }
        return undefined;
      case "message_end":
        if (event.message.role !== "assistant") return undefined;
        return this.#endModelCall(turn, event.message as unknown as Record<string, unknown>);
      case "tool_execution_start":
        this.#startTool(turn, event.toolCallId, event.toolName, event.args);
        return undefined;
      case "tool_execution_end":
        return this.#endTool(turn, event.toolCallId, event.result, event.isError);
      default:
        return undefined;
    }
  }

  #startModelCall(turn: Turn): void {
    turn.model?.span.end();
    const startedWall = this.#clock.wall();
    turn.model = {
      span: this.#o.telemetry.startSpan("chat", {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
        [ATTR_GEN_AI_CONVERSATION_ID]: this.#o.sessionId,
      }, turn.span, startedWall),
      stepId: this.#newId("step"),
      startedWall,
      startedMono: this.#clock.mono(),
      firstMono: undefined,
    };
  }

  #endModelCall(turn: Turn, m: Record<string, unknown>): TracedEvent {
    if (turn.model === undefined) this.#startModelCall(turn);
    const model = turn.model as NonNullable<Turn["model"]>;
    turn.model = undefined;
    const now = this.#clock.mono();
    const usage = (m["usage"] ?? {}) as Usage;
    const tokens = {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cache_read: usage.cacheRead ?? 0,
      cache_write: usage.cacheWrite ?? 0,
      total: usage.totalTokens ?? 0,
    };
    const cost = {
      input: usage.cost?.input ?? 0,
      output: usage.cost?.output ?? 0,
      cache_read: usage.cost?.cacheRead ?? 0,
      cache_write: usage.cost?.cacheWrite ?? 0,
      total: usage.cost?.total ?? 0,
    };
    const stopReason = typeof m["stopReason"] === "string" ? m["stopReason"] : "unknown";
    const errorMessage = typeof m["errorMessage"] === "string" ? m["errorMessage"] : undefined;
    const errorClass =
      stopReason === "aborted" ? "aborted" : stopReason === "error" ? "provider-error" : undefined;
    const provider = String(m["provider"] ?? "unknown");
    const modelId = String(m["model"] ?? "unknown");
    turn.step++;
    turn.modelCalls++;
    turn.tokens.input += tokens.input;
    turn.tokens.output += tokens.output;
    turn.tokens.cache_read += tokens.cache_read;
    turn.tokens.cache_write += tokens.cache_write;
    turn.cost += cost.total;
    const latencyMs = round(now - model.startedMono);
    const ttftMs = model.firstMono === undefined ? null : round(model.firstMono - model.startedMono);
    const t = this.#o.telemetry;
    const attrs = {
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
      [ATTR_GEN_AI_PROVIDER_NAME]: provider,
      [ATTR_GEN_AI_REQUEST_MODEL]: modelId,
    };
    t.metrics.tokenUsage.record(tokens.input, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: "input" });
    t.metrics.tokenUsage.record(tokens.output, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: "output" });
    t.metrics.modelDuration.record(latencyMs / 1000, {
      ...attrs,
      ...(errorClass === undefined ? {} : { [ATTR_ERROR_TYPE]: errorClass }),
    });
    if (cost.total > 0) t.metrics.cost.add(cost.total, attrs);
    model.span.updateName(`chat ${modelId}`);
    t.endSpan(
      model.span,
      {
        ...attrs,
        [ATTR_GEN_AI_RESPONSE_MODEL]: modelId,
        [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [stopReason],
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: tokens.input,
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: tokens.output,
        [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: tokens.cache_read,
        [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: tokens.cache_write,
      },
      errorClass === undefined ? undefined : { type: errorClass, message: errorMessage ?? stopReason },
    );
    const ids = spanIds(model.span);
    return {
      type: "runner.step",
      payload: {
        kind: "model_call",
        turn_id: turn.id,
        step_id: model.stepId,
        step_index: turn.step,
        trace_id: ids.traceId,
        span_id: ids.spanId,
        parent_span_id: spanIds(turn.span).spanId,
        provider,
        model: modelId,
        api: typeof m["api"] === "string" ? m["api"] : null,
        tokens,
        cost_usd: cost,
        latency_ms: latencyMs,
        ttft_ms: ttftMs,
        stop_reason: stopReason,
        error_class: errorClass ?? null,
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
        started: this.#stamp(model.startedWall, model.startedMono),
        ...this.#stamp(this.#clock.wall(), now),
      },
    };
  }

  #startTool(turn: Turn, toolCallId: string, name: string, args: unknown): void {
    if (this.#tools.has(toolCallId)) return;
    const startedWall = this.#clock.wall();
    this.#tools.set(toolCallId, {
      span: this.#o.telemetry.startSpan(`execute_tool ${name}`, {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
        [ATTR_GEN_AI_TOOL_NAME]: name,
        [ATTR_GEN_AI_TOOL_CALL_ID]: toolCallId,
        [ATTR_GEN_AI_CONVERSATION_ID]: this.#o.sessionId,
      }, turn.span, startedWall),
      stepId: this.#newId("step"),
      name,
      args,
      startedWall,
      startedMono: this.#clock.mono(),
      rpcs: [],
      boxId: undefined,
      boxWaitMs: 0,
      denied: undefined,
    });
  }

  /** The tool's box lease came after `waitMs` (box start or wake latency). */
  onLease(toolCallId: string | undefined, boxId: string, waitMs: number): void {
    const tool = toolCallId === undefined ? undefined : this.#tools.get(toolCallId);
    this.#o.telemetry.metrics.boxWait.record(waitMs / 1000);
    if (tool === undefined) return;
    tool.boxId = boxId;
    tool.boxWaitMs += waitMs;
  }

  /** The deny-list blocked the call before it reached the box. */
  onDenied(toolCallId: string, reason: string): void {
    const tool = this.#tools.get(toolCallId);
    if (tool !== undefined) tool.denied = reason;
  }

  /** The RPC hooks for one pi tool call: a client span per RPC, its `traceparent` on the frame. */
  rpcTrace(toolCallId: string): RpcTrace | undefined {
    const tool = this.#tools.get(toolCallId);
    if (tool === undefined) return undefined;
    return {
      rpc: (method, rpcId) => {
        const startedMono = this.#clock.mono();
        const span = this.#o.telemetry.startSpan(`rpc ${method}`, {
          "rpc.system": "hearth",
          "rpc.method": method,
          "hearth.rpc.id": rpcId,
          [ATTR_GEN_AI_TOOL_CALL_ID]: toolCallId,
          ...(tool.boxId === undefined ? {} : { "hearth.box.id": tool.boxId }),
        }, tool.span);
        const ids = spanIds(span);
        return {
          traceparent: ids.traceparent,
          end: (outcome: RpcOutcome) => {
            tool.rpcs.push({
              method,
              rpc_id: rpcId,
              span_id: ids.spanId,
              duration_ms: round(this.#clock.mono() - startedMono),
              ok: outcome.ok,
              ...(outcome.code === undefined ? {} : { error_code: outcome.code }),
              ...(outcome.exitCode === undefined ? {} : { exit_code: outcome.exitCode }),
            });
            this.#o.telemetry.endSpan(
              span,
              outcome.exitCode === undefined || outcome.exitCode === null
                ? {}
                : { "process.exit.code": outcome.exitCode },
              outcome.ok ? undefined : { type: outcome.code ?? "error", message: outcome.code ?? "error" },
            );
          },
        };
      },
    };
  }

  #endTool(turn: Turn, toolCallId: string, result: unknown, isError: boolean): TracedEvent | undefined {
    const tool = this.#tools.get(toolCallId);
    if (tool === undefined) return undefined;
    this.#tools.delete(toolCallId);
    const now = this.#clock.mono();
    const capped = capResult(result);
    const outcome = toolOutcome(isError, String(capped["text"]), tool.rpcs, tool.denied);
    const exec = [...tool.rpcs].reverse().find((r) => r.method === "tool.exec");
    turn.step++;
    turn.toolCalls++;
    if (outcome !== "ok") turn.toolFailures++;
    const t = this.#o.telemetry;
    t.metrics.toolCalls.add(1, { [ATTR_GEN_AI_TOOL_NAME]: tool.name });
    if (outcome !== "ok") {
      t.metrics.toolFailures.add(1, { [ATTR_GEN_AI_TOOL_NAME]: tool.name, [ATTR_ERROR_TYPE]: outcome });
    }
    t.endSpan(
      tool.span,
      { "hearth.tool.outcome": outcome, ...(tool.boxId === undefined ? {} : { "hearth.box.id": tool.boxId }) },
      outcome === "ok" ? undefined : { type: outcome, message: `${tool.name}: ${outcome}` },
    );
    const ids = spanIds(tool.span);
    return {
      type: "runner.step",
      payload: {
        kind: "tool_call",
        turn_id: turn.id,
        step_id: tool.stepId,
        step_index: turn.step,
        tool_call_id: toolCallId,
        trace_id: ids.traceId,
        span_id: ids.spanId,
        parent_span_id: spanIds(turn.span).spanId,
        name: tool.name,
        args: tool.args ?? null,
        result: capped,
        is_error: isError,
        outcome,
        ...(tool.denied === undefined ? {} : { denied_reason: tool.denied }),
        exit_code: exec?.exit_code ?? null,
        box_id: tool.boxId ?? null,
        box_wait_ms: round(tool.boxWaitMs),
        duration_ms: round(now - tool.startedMono),
        rpcs: tool.rpcs,
        started: this.#stamp(tool.startedWall, tool.startedMono),
        ...this.#stamp(this.#clock.wall(), now),
      },
    };
  }
}
