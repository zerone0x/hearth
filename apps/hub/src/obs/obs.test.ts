/**
 * Observability (#80, decision 0021): a faux-provider turn through the real
 * runner, `ToolRpcClient` and box-agent `ToolExecutor` yields a complete
 * trajectory (golden file), a box crash shows as `outcome-unknown` with its
 * trace id, spans reach an in-process OTLP collector with hub → box RPC
 * parent links, and no secret reaches the trajectory, logs or spans.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
import { Hono } from "hono";
import { ToolExecutor } from "../../../box-agent/src/tools/executor";
import type { HubEnv } from "../auth";
import type { BoxConnectionListener } from "../box/connections";
import { ToolRpcClient } from "../box/tool-rpc";
import { redactSecrets, SessionRunner } from "../runner/runner";
import { registerSecret } from "./redaction";
import { mountTrajectoryRoutes, Trajectories } from "./routes";
import { Telemetry } from "./telemetry";
import { buildTrajectory, type TrajectoryRecord, toJsonl } from "./trajectory";

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
  async read(_scope: unknown, _sessionId: string, afterSeq: number, limit: number) {
    const events = this.list.filter((e) => e.seq > afterSeq).slice(0, limit);
    const page: EventPage = {
      events,
      cursor: events.at(-1)?.seq ?? afterSeq,
      hasMore: this.list.length > afterSeq + events.length,
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

interface Setup {
  root: string;
  boxes: FakeBoxes;
  events: MemoryEvents;
  faux: FauxProviderHandle;
  runner: SessionRunner;
  telemetry: Telemetry;
  logs: string[];
}

async function setup(options: { exportTo?: string } = {}): Promise<Setup> {
  const dir = tempDir();
  const root = join(dir, "workspace");
  mkdirSync(root);
  const boxes = new FakeBoxes(root);
  const logs: string[] = [];
  const rpc = new ToolRpcClient({ boxes, log: (l) => logs.push(l) });
  closers.push(() => rpc.close());
  const events = new MemoryEvents();
  const faux = fauxProvider({ provider: "faux" });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
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
  const runner = await SessionRunner.create({
    sessionId: "se_obs",
    scope: { workspaceId: "ws_default" },
    events,
    box: {
      ensureBox: async () => ({ sessionId: "se_obs", boxId: "box_1", release: () => {} }),
      operations: (boxId, callId, trace) => rpc.operations(boxId, callId, trace),
    },
    modelRuntime: runtime,
    model: faux.getModel(),
    denyList: [],
    boxCwd: root,
    log: logger.lines("error"),
    redact,
    telemetry,
    clock: { wall: () => 1_700_000_000_000 + mono, mono: () => (mono += 1) },
    newId: (prefix) => `${prefix}_${++id}`,
  });
  closers.push(() => runner.dispose());
  return { root, boxes, events, faux, runner, telemetry, logs };
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
    // Token counts depend on the system prompt, which names the temp workspace.
    if (key === "tokens" && value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, typeof v === "number" && v >= 0 ? "<n>" : v]),
      );
    }
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
    expect(model).toMatchObject({ error_class: "provider-error" });
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
    await t.label(LOCAL_PRINCIPAL, "se_l", { task_type: "bugfix", outcome: "success" });
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
    const records = await t.trajectory(LOCAL_PRINCIPAL, "se_l");
    expect(records.at(-1)).toMatchObject({ labels: { task_type: "bugfix", outcome: "success" } });
    expect(records.filter((r) => r.kind === "label")).toHaveLength(2);
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
