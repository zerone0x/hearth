/**
 * Observability (#80, decision 0021): a faux-provider turn through the real
 * runner, `ToolRpcClient` and box-agent `ToolExecutor` yields a complete
 * trajectory (golden file), a box crash shows as `outcome-unknown` with its
 * trace id, spans reach an in-process OTLP collector with hub → box RPC
 * parent links, and no secret reaches the trajectory, logs or spans.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  createProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Provider,
  type Usage,
} from "@earendil-works/pi-ai";
import { type FileEntry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type AppendResult,
  type EventPage,
  type EventStore,
  HearthError,
  LOCAL_PRINCIPAL,
  Logger,
  type NewEvent,
  type StoredEvent,
} from "@hearth/core";
import { parseTraceparent, type RpcFrame, type RpcResultFrame } from "@hearth/protocol";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { Hono } from "hono";
import { ToolExecutor } from "../../../box-agent/src/tools/executor";
import type { HubEnv } from "../auth";
import type { BoxConnectionListener } from "../box/connections";
import { ToolRpcClient } from "../box/tool-rpc";
import { type CompiledDenyRule, compileDenyList } from "../runner/policy";
import { redactSecrets, SessionRunner } from "../runner/runner";
import { capText, MAX_TEXT_BYTES, utf8Head } from "./cap";
import { registerSecret } from "./redaction";
import { mountTrajectoryRoutes, Trajectories } from "./routes";
import { Telemetry } from "./telemetry";
import { buildTrajectory, type TrajectoryRecord, toJsonl } from "./trajectory";
import { payloadParams, TurnTracer } from "./turn-tracer";

const SECRET = "sk-hearth-test-SECRET-0123456789abcdef";
const dirs: string[] = [];
const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-obs-test-"));
  dirs.push(dir);
  return dir;
}

class MemoryEvents implements EventStore {
  readonly list: StoredEvent[] = [];
  async append(_scope: unknown, sessionId: string, event: NewEvent): Promise<AppendResult> {
    const seq = this.list.length + 1;
    this.list.push({
      workspaceId: "ws_default",
      sessionId,
      seq,
      ts: 1_700_000_000_000 + seq,
      type: event.type,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      payload: event.payload,
    });
    return { seq, duplicate: false };
  }
  async read(_scope: unknown, sessionId: string, afterSeq: number, limit: number) {
    const all = this.list.filter((e) => e.sessionId === sessionId && e.seq > afterSeq);
    const events = all.slice(0, limit);
    const page: EventPage = {
      events,
      cursor: events.at(-1)?.seq ?? afterSeq,
      hasMore: all.length > events.length,
    };
    return page;
  }
  async lastSeq() {
    return this.list.length;
  }
}

class FakeBoxes {
  readonly listeners = new Set<BoxConnectionListener>();
  readonly sent: RpcFrame[] = [];
  bootId = "boot_1";
  executor: ToolExecutor;
  constructor(readonly root: string) {
    this.executor = this.#newExecutor();
  }
  #newExecutor(): ToolExecutor {
    return new ToolExecutor({
      root: this.root,
      send: (frame: RpcResultFrame) => {
        for (const l of this.listeners) if (l.rpcResult?.("box_1", frame)) return;
      },
    });
  }
  listen(listener: BoxConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  sendRpc(_boxId: string, frame: RpcFrame): string | undefined {
    this.sent.push(frame);
    queueMicrotask(() => this.executor.handle(frame));
    return this.bootId;
  }
  crash(): void {
    this.executor.abortAll();
    this.executor = this.#newExecutor();
    this.bootId = "boot_2";
    for (const l of this.listeners) l.connected?.("box_1", this.bootId);
  }
}

interface Collected {
  spans: Array<{
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    attributes: Array<{ key: string; value: Record<string, unknown> }>;
  }>;
  bodies: string[];
}

/** An in-process OTLP/HTTP (JSON) collector. */
function collector(): { url: string; got: Collected } {
  const got: Collected = { spans: [], bodies: [] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.text();
      got.bodies.push(body);
      const parsed = JSON.parse(body) as {
        resourceSpans?: Array<{ scopeSpans: Array<{ spans: Collected["spans"] }> }>;
      };
      for (const rs of parsed.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans) got.spans.push(...ss.spans);
      }
      return Response.json({});
    },
  });
  closers.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1/traces`, got };
}

function call(
  name: string,
  args: Parameters<typeof fauxToolCall>[1],
  id: string,
): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

/**
 * Every model call reports this usage and cost (pi-ai's faux provider
 * estimates tokens from the prompt, which names the temp workspace, and its
 * cost is always 0). Costs are powers of two, so sums are exact.
 */
const USAGE: Usage = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 5,
  totalTokens: 155,
  cost: { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 },
};

/** What a real provider would build; pi-ai's faux provider builds no payload. */
const PAYLOAD = { model: "faux-1", max_tokens: 2048, temperature: 0.3 };

/**
 * The faux provider, with `USAGE` on every final message, and the
 * `onPayload` hook called the way pi-ai's HTTP providers call it.
 */
function withFixedUsage(faux: FauxProviderHandle): Provider {
  type Stream = Provider["streamSimple"];
  const wrap =
    (inner: Stream): Stream =>
    (model, context, options) => {
      const out: AssistantMessageEventStream = createAssistantMessageEventStream();
      void (async () => {
        await options?.onPayload?.(structuredClone(PAYLOAD), model);
        const source = inner(model, context, options);
        for await (const event of source) {
          if (event.type === "done") event.message.usage = structuredClone(USAGE);
          if (event.type === "error") event.error.usage = structuredClone(USAGE);
          out.push(event);
        }
        out.end();
      })();
      return out;
    };
  const p = faux.provider;
  return createProvider({
    id: p.id,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: faux.models,
    api: {
      stream: wrap(p.stream.bind(p) as Stream) as Provider["stream"],
      streamSimple: wrap(p.streamSimple.bind(p)),
    },
  });
}

interface Setup {
  root: string;
  boxes: FakeBoxes;
  events: MemoryEvents;
  faux: FauxProviderHandle;
  runner: SessionRunner;
  telemetry: Telemetry;
  logs: string[];
  /** The tool call id of every box lease the runner asked for. */
  leases: string[];
}

interface SetupOptions {
  exportTo?: string;
  denyList?: CompiledDenyRule[];
  /** Box start or wake latency: the test clock moves this far during each lease. */
  leaseWaitMs?: number;
  /** Runs after each lease (the AGENTS.md refresh); a throw fails the runner. */
  prepare?: () => Promise<void>;
  /** A rebuilt runner (hub restart): the old one's event log and pi entries. */
  events?: MemoryEvents;
  entries?: FileEntry[];
}

/** Each box lease takes `leaseWaitMs` on the test clock, plus one tick. */
const LEASE_WAIT_MS = 250;

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const dir = tempDir();
  const root = join(dir, "workspace");
  mkdirSync(root);
  const boxes = new FakeBoxes(root);
  const logs: string[] = [];
  const rpc = new ToolRpcClient({ boxes, log: (l) => logs.push(l) });
  closers.push(() => rpc.close());
  const events = options.events ?? new MemoryEvents();
  const faux = fauxProvider({ provider: "faux" });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(withFixedUsage(faux));
  const redact = (text: string) => redactSecrets(text, [SECRET]);
  const telemetry = new Telemetry({
    ...(options.exportTo === undefined
      ? {}
      : { spanExporter: new OTLPTraceExporter({ url: options.exportTo }) }),
    redact,
  });
  closers.push(() => telemetry.shutdown());
  let mono = 0;
  let id = 0;
  const logger = new Logger({ component: "runner", sink: (l) => logs.push(l), redact });
  const leases: string[] = [];
  const runner = await SessionRunner.create({
    sessionId: "se_obs",
    scope: { workspaceId: "ws_default" },
    events,
    box: {
      ensureBox: async (callId) => {
        leases.push(callId ?? "");
        mono += options.leaseWaitMs ?? LEASE_WAIT_MS;
        return { sessionId: "se_obs", boxId: "box_1", release: () => {} };
      },
      operations: (boxId, callId, trace) => rpc.operations(boxId, callId, trace),
      ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
    },
    modelRuntime: runtime,
    model: faux.getModel(),
    denyList: options.denyList ?? [],
    ...(options.entries === undefined ? {} : { entries: options.entries }),
    boxCwd: root,
    log: logger.lines("error"),
    redact,
    telemetry,
    clock: { wall: () => 1_700_000_000_000 + mono, mono: () => (mono += 1) },
    newId: (prefix) => `${prefix}_${++id}`,
  });
  closers.push(() => runner.dispose());
  return { root, boxes, events, faux, runner, telemetry, logs, leases };
}

async function turn(s: Setup, text: string, steps: FauxResponseStep[]) {
  s.faux.setResponses(steps);
  await s.runner.send(text);
  await s.runner.settled();
}

function trajectory(s: Setup): TrajectoryRecord[] {
  return buildTrajectory(s.events.list, {
    sessionId: "se_obs",
    versions: { pi: "test", hub: "test" },
    now: () => 0,
  });
}

/** Ids and timings vary per run: map ids to stable names by first use, keep links. */
function normalize(records: readonly TrajectoryRecord[], root: string): string {
  const names = new Map<string, string>();
  const name = (kind: string, v: string) => {
    const key = `${kind}:${v}`;
    if (!names.has(key))
      names.set(
        key,
        `<${kind}${[...names.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1}>`,
      );
    return names.get(key) as string;
  };
  const text = JSON.stringify(records, (key, value: unknown) => {
    // The system prompt names the temp workspace; the hub version names the git commit.
    if (key === "system_prompt" && value !== null && typeof value === "object") {
      return { bytes: "<n>", sha256: "<sha>" };
    }
    if (key === "hub_version") return "<hub>";
    if (key === "api") return "<api>";
    // pi streams a varying number of deltas, so event counts and seqs vary.
    if (key === "seq" || key === "events" || key === "last_seq") return "<seq>";
    if (key === "box_wait_ms" && value !== null && typeof value === "object") return "<waits>";
    if (typeof value === "string") {
      if (key === "trace_id") return name("trace", value);
      if (key === "span_id" || key === "parent_span_id") return name("span", value);
      if (key === "rpc_id") return name("rpc", value);
      if (key === "at" || key === "generated_at") return "<at>";
      if (key === "sha256") return value.slice(0, 12);
      return value.split(root).join("<root>");
    }
    if (typeof value === "number" && (key.endsWith("_ms") || key === "mono_ms")) {
      return value >= 0 ? "<ms>" : "<negative!>";
    }
    return value;
  });
  return `${(JSON.parse(text) as unknown[]).map((r) => JSON.stringify(r)).join("\n")}\n`;
}

const GOLDEN = join(import.meta.dir, "testdata", "trajectory.golden.jsonl");

describe("trajectory", () => {
  test("a turn that edits a file and runs a command: every step with ids, timings, tokens and results (golden)", async () => {
    const s = await setup();
    await turn(s, "make a and run it", [
      call("write", { path: "a.txt", content: "one\n" }, "c_write"),
      call("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "two" }] }, "c_edit"),
      call("bash", { command: "cat a.txt; exit 3" }, "c_bash"),
      fauxAssistantMessage("done"),
    ]);
    expect(s.runner.status).toBe("idle");
    const records = trajectory(s);
    const kinds = records.map((r) => r.kind);
    expect(kinds[0]).toBe("session");
    expect(kinds.at(-1)).toBe("summary");
    expect(kinds.filter((k) => k === "model_call")).toHaveLength(4);
    expect(kinds.filter((k) => k === "tool_call")).toHaveLength(3);
    const tools = records.filter((r) => r.kind === "tool_call");
    const bash = tools.find((r) => r["tool_call_id"] === "c_bash") as Record<string, unknown>;
    expect(bash["exit_code"]).toBe(3);
    expect(bash["box_id"]).toBe("box_1");
    expect((bash["result"] as { text: string }).text).toContain("two");
    // Every record of the turn carries the turn's id and trace id.
    const start = records.find((r) => r.kind === "turn_start") as Record<string, unknown>;
    for (const r of records.filter((r) => !["session", "summary"].includes(r.kind))) {
      expect(r["turn_id"]).toBe(start["turn_id"]);
      expect(r["trace_id"]).toBe(start["trace_id"]);
      expect(r["pi_version"]).toBeString();
      expect(r["hub_version"]).toBeString();
    }
    // Steps hang off the turn span; each RPC span is a child of its tool's span.
    for (const r of [...tools, ...records.filter((r) => r.kind === "model_call")]) {
      expect(r["parent_span_id"]).toBe(start["span_id"]);
      expect(r["step_id"]).toMatch(/^step_\d+$/);
    }
    const bashFrames = s.boxes.sent.filter(
      (f) => (f.params as { callId: string }).callId === "c_bash",
    );
    for (const frame of bashFrames) {
      const parent = parseTraceparent(frame.traceparent ?? "");
      expect(parent?.traceId).toBe(start["trace_id"] as string);
      expect((bash["rpcs"] as Array<{ span_id: string }>).map((r) => r.span_id)).toContain(
        parent?.spanId as string,
      );
    }
    // Timings: monotonic, ttft within latency.
    for (const m of records.filter((r) => r.kind === "model_call")) {
      expect(m["latency_ms"] as number).toBeGreaterThan(0);
      expect(m["ttft_ms"] as number).toBeGreaterThan(0);
      expect(m["ttft_ms"] as number).toBeLessThanOrEqual(m["latency_ms"] as number);
    }
    const seqs = records.map((r) => r["seq"]).filter((q): q is number => typeof q === "number");
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    const summary = records.at(-1) as Record<string, unknown>;
    expect(summary).toMatchObject({ turns: 1, model_calls: 4, tool_calls: 3 });
    // The answer and every tool request the model made are in the trajectory.
    const outputs = records.filter((r) => r.kind === "model_call").map((r) => r["output"]);
    expect(outputs.at(-1)).toMatchObject({ text: { text: "done", truncated: false, bytes: 4 } });
    expect(outputs.slice(0, 3)).toMatchObject([
      { text: null, tool_calls: [{ id: "c_write", name: "write" }] },
      { text: null, tool_calls: [{ id: "c_edit", name: "edit" }] },
      { text: null, tool_calls: [{ id: "c_bash", args: { command: "cat a.txt; exit 3" } }] },
    ]);
    expect(records.find((r) => r.kind === "user_input")).toMatchObject({
      prompt: { text: "make a and run it", truncated: false, bytes: 17 },
    });
    const normalized = normalize(records, s.root);
    if (process.env["UPDATE_GOLDEN"] === "1") {
      writeFileSync(GOLDEN, normalized);
    }
    expect(normalized).toBe(readFileSync(GOLDEN, "utf8"));
  });

  test("a box crash mid-tool shows as outcome-unknown with its trace id", async () => {
    const s = await setup();
    s.faux.setResponses([
      call("bash", { command: "sleep 20" }, "c_crash"),
      fauxAssistantMessage("checking"),
    ]);
    await s.runner.send("run it");
    const started = Date.now();
    while (!s.boxes.sent.some((f) => f.method === "tool.exec") && Date.now() - started < 5000) {
      await Bun.sleep(10);
    }
    s.boxes.crash();
    await s.runner.settled();
    const records = trajectory(s);
    const tool = records.find((r) => r.kind === "tool_call") as Record<string, unknown>;
    expect(tool["outcome"]).toBe("outcome-unknown");
    expect(tool["trace_id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(tool["trace_id"]).toBe(
      (records.find((r) => r.kind === "turn_start") as Record<string, unknown>)["trace_id"],
    );
    expect((tool["rpcs"] as Array<{ error_code?: string }>)[0]?.error_code).toBe(
      "tool.outcome-unknown",
    );
    expect(records.at(-1)).toMatchObject({
      outcome_unknown: 1,
      tool_failures_by_class: { "outcome-unknown": 1 },
    });
  });

  test("an interrupt is a user_input record and the turn ends interrupted", async () => {
    const s = await setup();
    s.faux.setResponses([
      call("bash", { command: "sleep 20" }, "c_sleep"),
      fauxAssistantMessage("x"),
    ]);
    await s.runner.send("go");
    const started = Date.now();
    while (!s.boxes.sent.some((f) => f.method === "tool.exec") && Date.now() - started < 5000) {
      await Bun.sleep(10);
    }
    await s.runner.interrupt();
    await s.runner.settled();
    const records = trajectory(s);
    expect(records.some((r) => r.kind === "user_input" && r["input"] === "interrupt")).toBe(true);
    expect(records.find((r) => r.kind === "turn_end")).toMatchObject({ outcome: "interrupted" });
    expect(records.find((r) => r.kind === "tool_call")).toMatchObject({ outcome: "aborted" });
    expect(records.at(-1)).toMatchObject({
      interrupts: 1,
      turns_by_outcome: { interrupted: 1 },
      tool_failures_by_class: { aborted: 1 },
    });
  });
});

describe("trajectory numbers (review of #82)", () => {
  test("tokens, cost, durations and box waits are exact, and the turn and summary sum them", async () => {
    const s = await setup();
    await turn(s, "two tools", [
      call("write", { path: "a.txt", content: "x" }, "c_w"),
      call("bash", { command: "echo hi" }, "c_b"),
      fauxAssistantMessage("ok"),
    ]);
    const records = trajectory(s);
    const models = records.filter((r) => r.kind === "model_call");
    expect(models).toHaveLength(3);
    for (const m of models) {
      expect(m["tokens"]).toEqual({
        input: 100,
        output: 20,
        cache_read: 30,
        cache_write: 5,
        total: 155,
      });
      expect(m["cost_usd"]).toEqual({
        input: 0.5,
        output: 0.25,
        cache_read: 0.125,
        cache_write: 0.0625,
        total: 0.9375,
      });
    }
    const tools = records.filter((r) => r.kind === "tool_call");
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      const leases = s.leases.filter((id) => id === t["tool_call_id"]).length;
      expect(leases).toBeGreaterThan(0);
      // Each lease took LEASE_WAIT_MS plus the clock's own tick; every one is added.
      expect(t["box_wait_ms"]).toBe(leases * (LEASE_WAIT_MS + 1));
      expect(t["duration_ms"] as number).toBeGreaterThan(t["box_wait_ms"] as number);
    }
    const sumTokens = { input: 300, output: 60, cache_read: 90, cache_write: 15 };
    expect(records.find((r) => r.kind === "turn_end")).toMatchObject({
      outcome: "done",
      model_calls: 3,
      tool_calls: 2,
      tool_failures: 0,
      tokens: sumTokens,
      cost_usd: 2.8125,
    });
    const waits = tools.map((t) => t["box_wait_ms"] as number);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(records.at(-1)).toMatchObject({
      kind: "summary",
      turns: 1,
      turns_by_outcome: { done: 1 },
      model_calls: 3,
      model_errors: 0,
      tool_calls: 2,
      tokens: sumTokens,
      cost_usd: 2.8125,
      interrupts: 0,
      outcome_unknown: 0,
      box_wait_ms: { total: sum(waits), max: Math.max(...waits), count: 2 },
      tool_duration_ms: sum(tools.map((t) => t["duration_ms"] as number)),
      model_latency_ms: sum(models.map((m) => m["latency_ms"] as number)),
    });
  });

  test("a denied call and a timed-out command are classified, and counted by class", async () => {
    const s = await setup({
      denyList: compileDenyList([{ tool: "bash", pattern: "rm -rf", reason: "no rm -rf here" }]),
    });
    await turn(s, "go", [
      call("bash", { command: "rm -rf /tmp/nothing" }, "c_deny"),
      call("bash", { command: "sleep 5", timeout: 1 }, "c_slow"),
      fauxAssistantMessage("ok"),
    ]);
    const records = trajectory(s);
    const byId = (id: string) =>
      records.find((r) => r.kind === "tool_call" && r["tool_call_id"] === id);
    expect(byId("c_deny")).toMatchObject({
      outcome: "denied",
      denied_reason: "no rm -rf here",
      is_error: true,
      rpcs: [],
    });
    const slow = byId("c_slow") as Record<string, unknown>;
    expect(slow).toMatchObject({ outcome: "timeout", is_error: true, exit_code: null });
    expect(slow["rpcs"]).toMatchObject([
      { method: "tool.exec", ok: false, error_code: "timed-out" },
    ]);
    expect(records.at(-1)).toMatchObject({
      tool_calls: 2,
      tool_failures_by_class: { denied: 1, timeout: 1 },
    });
    expect(records.find((r) => r.kind === "turn_end")).toMatchObject({ tool_failures: 2 });
  });
});

describe("model calls carry their request and output (schema /2)", () => {
  test("request: model, settings, tools, system prompt and message count, from pi's state", async () => {
    const s = await setup();
    await turn(s, "hi", [call("bash", { command: "echo 1" }, "c_1"), fauxAssistantMessage("ok")]);
    const models = trajectory(s).filter((r) => r.kind === "model_call");
    const prompt = s.runner.systemPrompt;
    const tools = s.runner.activeTools;
    expect(tools.length).toBeGreaterThan(0);
    for (const [i, m] of models.entries()) {
      expect(m["request"]).toMatchObject({
        provider: "faux",
        model: "faux-1",
        thinking_level: "off",
        model_max_tokens: s.faux.getModel().maxTokens,
        context_window: s.faux.getModel().contextWindow,
        tools,
        system_prompt: {
          bytes: Buffer.byteLength(prompt, "utf8"),
          sha256: createHash("sha256").update(prompt).digest("hex"),
        },
        // The prompt, then each assistant message and tool result before the call.
        message_count: 1 + 2 * i,
        // From the provider payload (before_provider_request).
        max_tokens: 2048,
        temperature: 0.3,
      });
      expect((m["request"] as { tools_sha256: string }).tools_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("output: text, thinking and tool calls with their arguments, redacted", async () => {
    const s = await setup();
    await turn(s, "think", [
      fauxAssistantMessage(
        [
          fauxThinking(`plan: use ${SECRET}`),
          fauxText("running it"),
          fauxToolCall("bash", { command: `echo ${SECRET}` }, { id: "c_t" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("all done"),
    ]);
    const records = trajectory(s);
    const [first, last] = records.filter((r) => r.kind === "model_call");
    expect(first?.["output"]).toMatchObject({
      text: { text: "running it", truncated: false, bytes: 10 },
      thinking: { text: "plan: use [redacted]", truncated: false },
      tool_calls: [{ id: "c_t", name: "bash", args: { command: "echo [redacted]" } }],
    });
    expect(last?.["output"]).toMatchObject({
      text: { text: "all done" },
      thinking: null,
      tool_calls: [],
    });
    expect(toJsonl(records)).not.toContain(SECRET);
  });

  test("provider payload fields: max tokens, temperature and reasoning, whatever the API calls them", () => {
    const t = new TurnTracer({
      sessionId: "se_p",
      telemetry: new Telemetry(),
      versions: { pi: "p", hub: "h" },
    });
    t.startTurn();
    t.onRequest({
      provider: "x",
      model: "m",
      systemPrompt: "sys",
      tools: [],
      messageCount: 1,
    });
    t.onPayload({
      max_tokens: 4096,
      temperature: 0.2,
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    t.onEvent({ type: "turn_start" } as never);
    const step = t.onEvent({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop", usage: USAGE },
    } as never);
    expect(step?.payload["request"]).toMatchObject({
      max_tokens: 4096,
      temperature: 0.2,
      reasoning: { type: "enabled", budget_tokens: 1024 },
      system_prompt: { bytes: 3 },
    });
    // A call pi made without a fresh context (none today) gets no stale request.
    t.onEvent({ type: "turn_start" } as never);
    const next = t.onEvent({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop", usage: USAGE },
    } as never);
    expect(next?.payload["request"]).toBeNull();
    expect(payloadParams({ max_output_tokens: 10, reasoning: { effort: "high" } })).toEqual({
      max_tokens: 10,
      temperature: null,
      reasoning: { effort: "high" },
    });
    expect(
      payloadParams({ generationConfig: { maxOutputTokens: 7, temperature: 1 } }),
    ).toMatchObject({ max_tokens: 7, temperature: 1 });
    expect(payloadParams({ max_completion_tokens: 5, reasoning_effort: "low" })).toEqual({
      max_tokens: 5,
      temperature: null,
      reasoning: "low",
    });
  });
});

describe("caps count UTF-8 bytes (review of #82)", () => {
  test("CJK: the kept head is at most 16 KiB of bytes, in whole characters, with the full size and hash", () => {
    const text = "中".repeat(40_000);
    const c = capText(text);
    expect(c.truncated).toBe(true);
    expect(c.bytes).toBe(120_000);
    expect(c.text).toBe("中".repeat(Math.floor(MAX_TEXT_BYTES / 3)));
    expect(Buffer.byteLength(c.text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(c.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(capText("中".repeat(5461)).truncated).toBe(false);
  });

  test("an emoji across the boundary is dropped whole, never split", () => {
    const a = "a".repeat(MAX_TEXT_BYTES - 2);
    const cut = capText(`${a}😀b`);
    expect(cut.text).toBe(a);
    expect(cut.text).not.toContain("�");
    expect(cut.bytes).toBe(MAX_TEXT_BYTES + 3);
    const fits = "a".repeat(MAX_TEXT_BYTES - 4);
    expect(capText(`${fits}😀`)).toMatchObject({ text: `${fits}😀`, truncated: false });
    expect(capText(`${fits}😀b`).text).toBe(`${fits}😀`);
    expect(utf8Head("é😀", 3)).toBe("é");
    expect(utf8Head("é😀", 1)).toBe("");
  });

  test("a secret straddling the cut is redacted before the cut, so no prefix of it is kept", () => {
    const text = `${"a".repeat(MAX_TEXT_BYTES - 10)}${SECRET}`;
    const c = capText(text, (x) => redactSecrets(x, [SECRET]));
    expect(c.text).not.toContain(SECRET.slice(0, 10));
    expect(c.truncated).toBe(false);
  });

  test("through the runner: a secret across the cut of a tool result is redacted before the cut", async () => {
    const s = await setup();
    const big = `${"a".repeat(MAX_TEXT_BYTES - 10)}${SECRET}`;
    writeFileSync(join(s.root, "big.txt"), big);
    await turn(s, "read it", [
      call("read", { path: "big.txt" }, "c_r"),
      fauxAssistantMessage("ok"),
    ]);
    const records = trajectory(s);
    const tool = records.find((r) => r.kind === "tool_call") as Record<string, unknown>;
    const result = tool["result"] as { text: string; truncated: boolean; sha256: string };
    expect(toJsonl(records)).not.toContain(SECRET.slice(0, 10));
    expect(result.text.endsWith("[redacted]")).toBe(true);
    // The hash is of the redacted text the trajectory has, so a reader can check it.
    expect(result.sha256).toBe(createHash("sha256").update(result.text).digest("hex"));
  });

  test("through the runner: a CJK tool result and a long answer are capped by bytes", async () => {
    const s = await setup();
    await turn(s, "big", [
      call("bash", { command: "for i in $(seq 1 8000); do printf '中'; done" }, "c_big"),
      fauxAssistantMessage("文".repeat(7000)),
    ]);
    const records = trajectory(s);
    const tool = records.find((r) => r.kind === "tool_call") as Record<string, unknown>;
    const result = tool["result"] as { text: string; truncated: boolean; bytes: number };
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(24_000);
    expect(result.text).toBe("中".repeat(5461));
    const last = records.filter((r) => r.kind === "model_call").at(-1) as Record<string, unknown>;
    expect((last["output"] as { text: unknown }).text).toMatchObject({
      text: "文".repeat(5461),
      truncated: true,
      bytes: 21_000,
    });
  });
});

describe("failure records (review of #82)", () => {
  test("a runner failure is a runner_failed record and the turn ends failed", async () => {
    const s = await setup({
      prepare: async () => {
        throw new Error("disk full writing runner.context");
      },
    });
    await turn(s, "go", [call("bash", { command: "echo 1" }, "c_1"), fauxAssistantMessage("x")]);
    expect(s.runner.status).toBe("failed");
    const records = trajectory(s);
    expect(records.find((r) => r.kind === "runner_failed")).toMatchObject({
      error: expect.stringContaining("disk full writing runner.context"),
    });
    expect(records.at(-1)).toMatchObject({ kind: "summary" });
  });

  test("a hub restart mid-tool is an outcome_unknown record naming the call", async () => {
    const s = await setup();
    s.faux.setResponses([
      call("bash", { command: "sleep 20" }, "c_mid"),
      fauxAssistantMessage("x"),
    ]);
    await s.runner.send("start");
    const started = Date.now();
    while (!s.boxes.sent.some((f) => f.method === "tool.exec") && Date.now() - started < 5000) {
      await Bun.sleep(10);
    }
    await Bun.sleep(50);
    const snapshot = structuredClone(s.events.list);
    const entries = s.runner.storedEntries();
    const events = new MemoryEvents();
    events.list.push(...snapshot);
    await setup({ events, entries });
    const records = buildTrajectory(events.list, {
      sessionId: "se_obs",
      versions: { pi: "test", hub: "test" },
    });
    const unknown = records.find((r) => r.kind === "outcome_unknown");
    expect(unknown).toMatchObject({ reason: "hub restart", tool_call_ids: ["c_mid"] });
    expect(records.at(-1)).toMatchObject({ outcome_unknown: 1 });
  });
});

describe("OTLP export", () => {
  test("spans reach the collector with turn → step → RPC parent links that match the frames", async () => {
    const { url, got } = collector();
    const s = await setup({ exportTo: url });
    await turn(s, "run", [call("bash", { command: "echo hi" }, "c_1"), fauxAssistantMessage("ok")]);
    await s.telemetry.flush();
    const byName = (prefix: string) => got.spans.filter((sp) => sp.name.startsWith(prefix));
    const [root] = byName("invoke_agent");
    expect(root).toBeDefined();
    expect(root?.parentSpanId ?? "").toBe("");
    const chats = byName("chat");
    expect(chats).toHaveLength(2);
    for (const c of chats) expect(c.parentSpanId).toBe(root?.spanId as string);
    const [tool] = byName("execute_tool bash");
    expect(tool?.parentSpanId).toBe(root?.spanId as string);
    const rpcs = byName("rpc tool.");
    expect(rpcs.length).toBeGreaterThan(0);
    for (const r of rpcs) {
      expect(r.parentSpanId).toBe(tool?.spanId as string);
      expect(r.traceId).toBe(root?.traceId as string);
    }
    // The span the box was told about is the hub's RPC span.
    const exec = s.boxes.sent.find((f) => f.method === "tool.exec");
    const parent = parseTraceparent(exec?.traceparent ?? "");
    expect(rpcs.map((r) => r.spanId)).toContain(parent?.spanId as string);
    const keys = new Set(chats.flatMap((c) => c.attributes.map((a) => a.key)));
    for (const k of [
      "gen_ai.operation.name",
      "gen_ai.request.model",
      "gen_ai.usage.input_tokens",
    ]) {
      expect(keys.has(k)).toBe(true);
    }
  });

  test("off by default: nothing is exported without an exporter", () => {
    expect(new Telemetry().exporting).toBe(false);
  });
});

describe("no secret leaves the hub", () => {
  test("a secret in a prompt, tool args, tool output and a provider error never reaches trajectory, logs or spans", async () => {
    const { url, got } = collector();
    const s = await setup({ exportTo: url });
    writeFileSync(join(s.root, "k.txt"), `key=${SECRET}\n`);
    await turn(s, `use ${SECRET}`, [
      call("bash", { command: `echo ${SECRET}; cat k.txt` }, "c_1"),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `invalid x-api-key ${SECRET}`,
      }),
    ]);
    await s.telemetry.flush();
    const all = [toJsonl(trajectory(s)), ...s.logs, ...got.bodies].join("\n");
    expect(got.bodies.length).toBeGreaterThan(0);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("0123456789abcdef");
    const model = trajectory(s).find((r) => r.kind === "model_call" && r["error_class"] !== null);
    expect(model).toMatchObject({
      error_class: "provider-error",
      error: "invalid x-api-key [redacted]",
    });
    expect(trajectory(s).at(-1)).toMatchObject({ model_calls: 2, model_errors: 1 });
  });

  test("the trajectory API redacts at the sink, even an event that skipped the runner's redaction", async () => {
    registerSecret(SECRET);
    const events = new MemoryEvents();
    await events.append({}, "se_x", { type: "message.user", payload: { text: `raw ${SECRET}` } });
    const app = new Hono<HubEnv>();
    app.use(async (c, next) => {
      c.set("principal", LOCAL_PRINCIPAL);
      await next();
    });
    mountTrajectoryRoutes(
      app,
      new Trajectories({
        authorizer: { authorize: async () => ({ allowed: true, policy: "test" }) },
        events,
        sessions: {
          get: async (_p, id) => {
            if (id !== "se_x") {
              throw new HearthError("no", {
                owner: "user",
                disposition: "give-up",
                code: "session.not-found",
              });
            }
            return {};
          },
        },
        versions: { pi: "p", hub: "h" },
      }),
    );
    const res = await app.request("/v1/sessions/se_x/trajectory");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const body = await res.text();
    expect(body).toContain("raw [redacted]");
    expect(body).not.toContain(SECRET);
    expect((await app.request("/v1/sessions/se_nope/trajectory")).status).toBe(404);
  });
});

describe("span redaction", () => {
  test("string attributes and error status messages are redacted before export", async () => {
    const exporter = new InMemorySpanExporter();
    const t = new Telemetry({ spanExporter: exporter, redact: (x) => redactSecrets(x, [SECRET]) });
    const span = t.startSpan("s", { "a.start": `x ${SECRET}` });
    t.endSpan(
      span,
      { "a.end": SECRET, n: 1 },
      { type: "provider-error", message: `bad ${SECRET}` },
    );
    await t.flush();
    const [done] = exporter.getFinishedSpans();
    expect(done?.attributes).toMatchObject({
      "a.start": "x [redacted]",
      "a.end": "[redacted]",
      n: 1,
    });
    expect(done?.status.message).toBe("bad [redacted]");
    expect(JSON.stringify(done?.attributes)).not.toContain(SECRET);
    await t.shutdown();
  });
});

describe("labels", () => {
  test("labels are validated, authorized and land in the turn and session summary", async () => {
    const events = new MemoryEvents();
    const decisions: string[] = [];
    const t = new Trajectories({
      authorizer: {
        authorize: async (_p, action) => {
          decisions.push(action);
          return { allowed: true, policy: "test" };
        },
      },
      events,
      sessions: { get: async () => ({}) },
      versions: { pi: "p", hub: "h" },
    });
    await events.append({}, "se_l", {
      type: "runner.turn.start",
      turnId: "turn_1",
      payload: { turn_id: "turn_1", trace_id: "t" },
    });
    await events.append({}, "se_l", {
      type: "runner.turn.end",
      turnId: "turn_1",
      payload: { turn_id: "turn_1", outcome: "done" },
    });
    await events.append({}, "se_l", {
      type: "runner.turn.start",
      turnId: "turn_2",
      payload: { turn_id: "turn_2", trace_id: "t2" },
    });
    await t.label(LOCAL_PRINCIPAL, "se_l", { task_type: "bugfix", outcome: "success" });
    // A label for turn 1, set while turn 2 runs, keeps turn 1's trace id.
    await t.label(LOCAL_PRINCIPAL, "se_l", { turn_id: "turn_1", verdict: "good" });
    await expect(t.label(LOCAL_PRINCIPAL, "se_l", { outcome: "great" })).rejects.toThrow(
      /outcome must be/,
    );
    await expect(t.label(LOCAL_PRINCIPAL, "se_l", { colour: "x" })).rejects.toThrow(
      /unknown field/,
    );
    await expect(t.label(LOCAL_PRINCIPAL, "se_l", { turn_id: "turn_1" })).rejects.toThrow(
      /at least one/,
    );
    // A turn label must name a turn of this session.
    await expect(
      t.label(LOCAL_PRINCIPAL, "se_l", { turn_id: "turn_bogus", verdict: "x" }),
    ).rejects.toThrow(/not a turn of this session/);
    await events.append({}, "se_other", {
      type: "runner.turn.start",
      turnId: "turn_9",
      payload: { turn_id: "turn_9" },
    });
    await expect(
      t.label(LOCAL_PRINCIPAL, "se_l", { turn_id: "turn_9", verdict: "x" }),
    ).rejects.toThrow(/not a turn of this session/);
    const records = await t.trajectory(LOCAL_PRINCIPAL, "se_l");
    expect(records.at(-1)).toMatchObject({ labels: { task_type: "bugfix", outcome: "success" } });
    const labels = records.filter((r) => r.kind === "label");
    expect(labels).toHaveLength(2);
    expect(labels[1]).toMatchObject({ turn_id: "turn_1", trace_id: "t" });
    expect(records.find((r) => r.kind === "turn_end")).toMatchObject({
      labels: { verdict: "good" },
    });
    expect(decisions).toContain("session.label");
    expect(decisions).toContain("session.trajectory");
  });

  test("a denied principal gets nothing", async () => {
    const t = new Trajectories({
      authorizer: { authorize: async () => ({ allowed: false, policy: "test", reason: "no" }) },
      events: new MemoryEvents(),
      sessions: { get: async () => ({}) },
      versions: { pi: "p", hub: "h" },
    });
    await expect(t.trajectory(LOCAL_PRINCIPAL, "se_l")).rejects.toThrow(/denied/);
  });
});
