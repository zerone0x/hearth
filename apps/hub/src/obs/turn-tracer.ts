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
import type { BlobRef } from "@hearth/core";
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
import type { BashVerdict } from "../runner/bash-policy";
import { imageRefs } from "./blobs";
import { type CappedText, capJson, capText, type Redact } from "./cap";
import { spanIds, type Telemetry } from "./telemetry";

export { MAX_TEXT_BYTES } from "./cap";

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
  /**
   * The runner's redactor. Every text the tracer keeps (model output, tool
   * arguments and results, errors) is redacted before it is capped and hashed.
   */
  readonly redact?: Redact;
}

/**
 * What one model request asked for (schema `hearth.trajectory/2`): enough to
 * replay it against the same model. The system prompt's text (redacted, capped
 * like every kept text) is on the first model call of a runner and on each
 * call where it changed; later calls carry only its size and hash, which name
 * the earlier text. Tool schemas are hashed; the messages are the earlier
 * records of the trajectory.
 */
export interface ModelRequest {
  provider: string;
  model: string;
  api: string | null;
  thinking_level: string | null;
  /** Sent in the provider payload (`before_provider_request`); null when pi did not set it. */
  max_tokens: number | null;
  temperature: number | null;
  /** The model's own output limit and context window, from its definition. */
  model_max_tokens: number | null;
  context_window: number | null;
  /** Provider reasoning settings found in the payload (`thinking`, `reasoning`, `reasoning_effort`). */
  reasoning: unknown;
  tools: string[];
  /** sha256 of the tool declarations (name, description, parameters) as sent. */
  tools_sha256: string;
  system_prompt: { bytes: number; sha256: string; text?: CappedText };
  /** Messages in the request's context, system messages excluded. */
  message_count: number;
}

export interface RequestSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly api?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly modelMaxTokens?: number | undefined;
  readonly contextWindow?: number | undefined;
  readonly systemPrompt: string;
  readonly tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>;
  readonly messageCount: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The request record for a snapshot of pi's state just before the call. */
export function modelRequest(s: RequestSnapshot): ModelRequest {
  return {
    provider: s.provider,
    model: s.model,
    api: s.api ?? null,
    thinking_level: s.thinkingLevel ?? null,
    max_tokens: null,
    temperature: null,
    model_max_tokens: numOrNull(s.modelMaxTokens),
    context_window: numOrNull(s.contextWindow),
    reasoning: null,
    tools: s.tools.map((t) => t.name),
    tools_sha256: sha256(
      JSON.stringify(
        s.tools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          parameters: t.parameters ?? null,
        })),
      ),
    ),
    system_prompt: {
      bytes: Buffer.byteLength(s.systemPrompt, "utf8"),
      sha256: sha256(s.systemPrompt),
    },
    message_count: s.messageCount,
  };
}

/** Sampling and limit fields from a provider payload, whatever the API's naming. */
export function payloadParams(payload: unknown): {
  max_tokens: number | null;
  temperature: number | null;
  reasoning: unknown;
} {
  const p = (payload !== null && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const gen = (
    p["generationConfig"] !== null && typeof p["generationConfig"] === "object"
      ? p["generationConfig"]
      : {}
  ) as Record<string, unknown>;
  const reasoning =
    p["thinking"] ?? p["reasoning"] ?? p["reasoning_effort"] ?? gen["thinkingConfig"];
  return {
    max_tokens:
      numOrNull(p["max_tokens"]) ??
      numOrNull(p["max_completion_tokens"]) ??
      numOrNull(p["max_output_tokens"]) ??
      numOrNull(gen["maxOutputTokens"]),
    temperature: numOrNull(p["temperature"]) ?? numOrNull(gen["temperature"]),
    reasoning: reasoning === undefined ? null : reasoning,
  };
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
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
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
  /** The command-rule verdict of a `bash` call (decision 0044). */
  bashPolicy: BashVerdict | undefined;
  /** The code the call was refused with before dispatch (`desktop.locked`). */
  refused: string | undefined;
  /** The access mode the call was preflighted under (decision 0045). */
  accessMode: string | undefined;
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
  model:
    | {
        span: Span;
        stepId: string;
        startedWall: number;
        startedMono: number;
        firstMono: number | undefined;
      }
    | undefined;
  /** The request of the model call in progress (pi's `context` event). */
  request: ModelRequest | undefined;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function textOf(result: unknown): { text: string; images: number; blobs: BlobRef[] } {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) {
    return { text: typeof result === "string" ? result : "", images: 0, blobs: [] };
  }
  let text = "";
  let images = 0;
  for (const part of content as Array<{ type?: string; text?: unknown }>) {
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    else if (part.type === "image") images++;
  }
  return { text, images, blobs: imageRefs(content) };
}

/**
 * The size-capped tool result: redacted head, byte count and sha256 of the
 * full text; with images, their count and `image_blobs`, a reference (sha256,
 * size, sniffed mime) per image, never its bytes (decision 0037).
 */
export function capResult(result: unknown, redact?: Redact): Record<string, unknown> {
  const { text, images, blobs } = textOf(result);
  return {
    ...capText(text, redact),
    ...(images > 0 ? { images } : {}),
    ...(blobs.length > 0 ? { image_blobs: blobs } : {}),
  };
}

/**
 * What the model answered (schema `hearth.trajectory/2`): its text, its
 * thinking and the tool calls it asked for, each redacted and capped.
 */
export function modelOutput(content: unknown, redact?: Redact): Record<string, unknown> {
  let text = "";
  let thinking = "";
  let redactedThinking = 0;
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const part of Array.isArray(content) ? content : []) {
    const p = (part ?? {}) as Record<string, unknown>;
    if (p["type"] === "text" && typeof p["text"] === "string") text += p["text"];
    else if (p["type"] === "thinking") {
      if (p["redacted"] === true) redactedThinking++;
      else if (typeof p["thinking"] === "string") thinking += p["thinking"];
    } else if (p["type"] === "toolCall") {
      toolCalls.push({
        id: typeof p["id"] === "string" ? p["id"] : null,
        name: typeof p["name"] === "string" ? p["name"] : null,
        args: capJson(p["arguments"], redact),
      });
    }
  }
  return {
    text: text === "" ? null : capText(text, redact),
    thinking: thinking === "" ? null : capText(thinking, redact),
    ...(redactedThinking > 0 ? { redacted_thinking_blocks: redactedThinking } : {}),
    tool_calls: toolCalls,
  };
}

/** Why a tool call ended the way it did, from its RPCs and its result. */
export function toolOutcome(
  isError: boolean,
  text: string,
  rpcs: readonly RpcRecord[],
  denied: string | undefined,
  refused?: string,
): string {
  if (denied !== undefined) return "denied";
  if (refused === "desktop.locked") return "desktop-locked";
  if (rpcs.some((r) => r.error_code === "tool.outcome-unknown")) return "outcome-unknown";
  if (rpcs.some((r) => r.error_code === "tool.deadline" || r.error_code === "timed-out"))
    return "timeout";
  if (rpcs.some((r) => r.error_code === "aborted" || r.error_code === "cancelled"))
    return "aborted";
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
  readonly #redact: Redact;
  #turn: Turn | undefined;
  /** sha256 of the last system prompt whose text a model call carried. */
  #promptSha: string | undefined;

  constructor(options: TurnTracerOptions) {
    this.#o = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.#redact = options.redact ?? ((text) => text);
  }

  /** The tracer's clock, so the runner times box waits on the same one. */
  get clock(): Clock {
    return this.#clock;
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
    const span = this.#o.telemetry.startSpan(
      "invoke_agent hearth",
      {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
        [ATTR_GEN_AI_CONVERSATION_ID]: this.#o.sessionId,
        "hearth.session.id": this.#o.sessionId,
        "hearth.turn.id": id,
      },
      undefined,
      startedWall,
    );
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
      request: undefined,
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

  /** The request pi is about to send (its `context` event), for the next model call. */
  onRequest(snapshot: RequestSnapshot): void {
    const turn = this.#turn;
    if (turn === undefined) return;
    turn.request = modelRequest(snapshot);
    // Redacted before it is capped; dropped at the call's end if an earlier call has it.
    turn.request.system_prompt.text = capText(snapshot.systemPrompt, this.#redact);
  }

  /** The provider payload (`before_provider_request`): the sampling and limit fields pi set. */
  onPayload(payload: unknown): void {
    const request = this.#turn?.request;
    if (request === undefined) return;
    Object.assign(request, payloadParams(payload));
  }

  #startModelCall(turn: Turn): void {
    turn.model?.span.end();
    const startedWall = this.#clock.wall();
    turn.model = {
      span: this.#o.telemetry.startSpan(
        "chat",
        {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
          [ATTR_GEN_AI_CONVERSATION_ID]: this.#o.sessionId,
        },
        turn.span,
        startedWall,
      ),
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
    const request = turn.request ?? null;
    turn.request = undefined;
    if (request !== null) {
      // The prompt's text once per version: later calls name it by its hash.
      if (request.system_prompt.sha256 === this.#promptSha) delete request.system_prompt.text;
      else this.#promptSha = request.system_prompt.sha256;
    }
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
    const errorMessage =
      typeof m["errorMessage"] === "string" ? this.#redact(m["errorMessage"]) : undefined;
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
    const ttftMs =
      model.firstMono === undefined ? null : round(model.firstMono - model.startedMono);
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
      errorClass === undefined
        ? undefined
        : { type: errorClass, message: errorMessage ?? stopReason },
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
        request,
        output: modelOutput(m["content"], this.#redact),
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
      span: this.#o.telemetry.startSpan(
        `execute_tool ${name}`,
        {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
          [ATTR_GEN_AI_TOOL_NAME]: name,
          [ATTR_GEN_AI_TOOL_CALL_ID]: toolCallId,
          [ATTR_GEN_AI_CONVERSATION_ID]: this.#o.sessionId,
        },
        turn.span,
        startedWall,
      ),
      stepId: this.#newId("step"),
      name,
      args,
      startedWall,
      startedMono: this.#clock.mono(),
      rpcs: [],
      boxId: undefined,
      boxWaitMs: 0,
      denied: undefined,
      bashPolicy: undefined,
      refused: undefined,
      accessMode: undefined,
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

  /** The access mode the call runs under, read when pi preflighted it (decision 0045). */
  onAccessMode(toolCallId: string, mode: string): void {
    const tool = this.#tools.get(toolCallId);
    if (tool !== undefined) tool.accessMode = mode;
  }

  /** The deny-list blocked the call before it reached the box. */
  onDenied(toolCallId: string, reason: string): void {
    const tool = this.#tools.get(toolCallId);
    if (tool !== undefined) tool.denied = reason;
  }

  /**
   * The command rules' verdict on a `bash` call (decision 0044), recorded on
   * its step as `bash_policy`. `ask` is recorded but not enforced yet.
   */
  onBashVerdict(toolCallId: string, verdict: BashVerdict): void {
    const tool = this.#tools.get(toolCallId);
    if (tool !== undefined) tool.bashPolicy = verdict;
  }

  /**
   * The tool refused the call before it reached the box, with `code`: today
   * only the browser tools, while the owner holds the desktop lock (decision 0035).
   */
  onRefused(toolCallId: string, code: string): void {
    const tool = this.#tools.get(toolCallId);
    if (tool !== undefined) tool.refused = code;
  }

  /** The RPC hooks for one pi tool call: a client span per RPC, its `traceparent` on the frame. */
  rpcTrace(toolCallId: string): RpcTrace | undefined {
    const tool = this.#tools.get(toolCallId);
    if (tool === undefined) return undefined;
    return {
      rpc: (method, rpcId) => {
        const startedMono = this.#clock.mono();
        const span = this.#o.telemetry.startSpan(
          `rpc ${method}`,
          {
            "rpc.system": "hearth",
            "rpc.method": method,
            "hearth.rpc.id": rpcId,
            [ATTR_GEN_AI_TOOL_CALL_ID]: toolCallId,
            ...(tool.boxId === undefined ? {} : { "hearth.box.id": tool.boxId }),
          },
          tool.span,
        );
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
              outcome.ok
                ? undefined
                : { type: outcome.code ?? "error", message: outcome.code ?? "error" },
            );
          },
        };
      },
    };
  }

  #endTool(
    turn: Turn,
    toolCallId: string,
    result: unknown,
    isError: boolean,
  ): TracedEvent | undefined {
    const tool = this.#tools.get(toolCallId);
    if (tool === undefined) return undefined;
    this.#tools.delete(toolCallId);
    const now = this.#clock.mono();
    const capped = capResult(result, this.#redact);
    const outcome = toolOutcome(
      isError,
      String(capped["text"]),
      tool.rpcs,
      tool.denied,
      tool.refused,
    );
    const exec = [...tool.rpcs].reverse().find((r) => r.method === "tool.exec");
    turn.step++;
    turn.toolCalls++;
    if (outcome !== "ok") turn.toolFailures++;
    const t = this.#o.telemetry;
    t.metrics.toolCalls.add(1, { [ATTR_GEN_AI_TOOL_NAME]: tool.name });
    if (outcome !== "ok") {
      t.metrics.toolFailures.add(1, {
        [ATTR_GEN_AI_TOOL_NAME]: tool.name,
        [ATTR_ERROR_TYPE]: outcome,
      });
    }
    t.endSpan(
      tool.span,
      {
        "hearth.tool.outcome": outcome,
        ...(tool.boxId === undefined ? {} : { "hearth.box.id": tool.boxId }),
      },
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
        args: capJson(tool.args, this.#redact),
        result: capped,
        is_error: isError,
        outcome,
        // Every tool call, in both modes (decisions 0043, 0045); null if never preflighted.
        access_mode: tool.accessMode ?? null,
        ...(tool.denied === undefined ? {} : { denied_reason: tool.denied }),
        ...(tool.bashPolicy === undefined
          ? {}
          : { bash_policy: capJson(tool.bashPolicy, this.#redact) }),
        ...(tool.refused === undefined ? {} : { refused_code: tool.refused }),
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
