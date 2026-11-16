/**
 * One pi runner per session, in the hub (PRD §8.2.1; decisions 0009, 0015).
 *
 * - `createAgentSession` with an in-memory `SettingsManager`, an empty
 *   `agentDir` the runner owns, and a `DefaultResourceLoader` with every kind
 *   of discovery off. Extensions: `hearth-tools` (tools.ts), the allowlisted
 *   pinned ones (extensions.ts), and pi's `codemode` when the session asks.
 * - Every pi event is appended to the session's event log as `pi.<type>`;
 *   `runner.entry` carries the session entries a rebuild needs, and
 *   `runner.header` the pi session header.
 * - A turn runs in the background. Anything it throws, and any failure to
 *   record an event, becomes a visible session failure (`runner.failed`, the
 *   runner's `failure`), never an exception that escapes to the hub.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  type FileEntry,
  type ModelRuntime,
  VERSION as PI_VERSION,
  SessionManager as PiSessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type EventStore,
  HearthError,
  type JsonValue,
  type SessionId,
  type WorkspaceScope,
} from "@hearth/core";
import { Telemetry } from "../obs/telemetry";
import { type Clock, SYSTEM_CLOCK, type TracedEvent, TurnTracer } from "../obs/turn-tracer";
import { HUB_VERSION } from "../obs/version";
import { BROWSER_TOOLS } from "./browser-tools";
import type { PinnedExtension } from "./extensions";
import { liveToolOutput } from "./live-output";
import type { CompiledDenyRule } from "./policy";
import { hearthToolsExtension, ROUTED_TOOLS, type RunnerBox } from "./tools";

export const BOX_CWD = "/workspace";

/** A context file as the box has it (`AGENTS.md`), fed to pi through `agentsFilesOverride`. */
export interface ContextFile {
  readonly path: string;
  readonly content: string;
}

export interface SessionRunnerOptions {
  readonly sessionId: SessionId;
  readonly scope: WorkspaceScope;
  readonly events: EventStore;
  readonly box: RunnerBox;
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<string>;
  readonly denyList: readonly CompiledDenyRule[];
  /** Already filtered by the allowlist. */
  readonly extensions?: readonly PinnedExtension[];
  /** pi's codemode tool (decision 0015). Off by default. */
  readonly codemode?: boolean;
  /** `[header, ...entries]` from the event log, to rebuild after a hub restart. */
  readonly entries?: readonly FileEntry[];
  /** The hub's cached copy of the box's context files (decision 0015). */
  readonly contextFiles?: () => readonly ContextFile[];
  readonly boxCwd?: string;
  readonly hubTempDir?: string;
  readonly log?: (line: string) => void;
  /** Removes the secrets the runner uses (the model key) from text it stores or logs. */
  readonly redact?: (text: string) => string;
  /**
   * Called once when the runner fails, after `runner.failed` is recorded: the
   * hub moves the session row to `failed` through the session manager.
   */
  readonly onFailure?: (message: string) => Promise<unknown>;
  /** Spans and metrics (decision 0021). Defaults to a hub-wide one that exports nothing. */
  readonly telemetry?: Telemetry;
  /** Tests pin time and ids for golden trajectories. */
  readonly clock?: Clock;
  readonly newId?: (prefix: string) => string;
}

let defaultTelemetry: Telemetry | undefined;

export type RunnerStatus = "idle" | "running" | "failed";

/** Largest payload the runner writes for one event; bigger ones are cut. */
export const MAX_RUNNER_EVENT_BYTES = 1024 * 1024;

/** Fields of a pi event that repeat what other events already carry. */
const BULKY_FIELDS = new Set(["partial", "messages", "toolResults"]);

export const REDACTED = "[redacted]";

/**
 * `text` with every secret replaced, raw and as it appears inside a JSON
 * string. Provider errors can echo the key (`invalid x-api-key sk-...`).
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(REDACTED);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join(REDACTED);
  }
  return out;
}

/** The text a rebuilt runner gives a tool call that a hub restart cut off. */
export const RESTART_OUTCOME_UNKNOWN =
  "The hub restarted while this tool call was running: its outcome is unknown and it was not re-run. Check the box's state before running it again.";

const identity = (text: string): string => text;

function jsonSafe(value: unknown, redact: (text: string) => string = identity): JsonValue {
  const raw = JSON.stringify(value, (key, v: unknown) =>
    BULKY_FIELDS.has(key) ? undefined : typeof v === "bigint" ? String(v) : v,
  );
  if (raw === undefined) return null;
  const text = redact(raw);
  if (text.length > MAX_RUNNER_EVENT_BYTES) {
    return { truncated: true, bytes: text.length, head: text.slice(0, 4096) };
  }
  return JSON.parse(text) as JsonValue;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tool calls on the session branch with no tool result. */
function orphanedToolCalls(branch: readonly unknown[]): Array<{ id: string; name: string }> {
  const calls: Array<{ id: string; name: string }> = [];
  const answered = new Set<string>();
  for (const entry of branch as Array<{ type?: string; message?: unknown }>) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown; toolCallId?: unknown };
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      answered.add(message.toolCallId);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Array<{
        type?: string;
        id?: unknown;
        name?: unknown;
      }>) {
        if (part.type === "toolCall" && typeof part.id === "string") {
          calls.push({ id: part.id, name: typeof part.name === "string" ? part.name : "unknown" });
        }
      }
    }
  }
  return calls.filter((c) => !answered.has(c.id));
}

export class SessionRunner {
  readonly sessionId: SessionId;
  readonly #o: SessionRunnerOptions;
  readonly #session: AgentSession;
  readonly #pi: PiSessionManager;
  readonly #agentDir: string;
  #status: RunnerStatus = "idle";
  #failure: string | undefined;
  #chain: Promise<void> = Promise.resolve();
  #turn: Promise<void> = Promise.resolve();
  #contextKey: string;
  /** How many pi session entries are already in the event log. */
  #persisted: number;
  #unsubscribe: () => void;
  #failing: Promise<void> = Promise.resolve();
  readonly tracer: TurnTracer;
  #interrupted = false;

  private constructor(
    options: SessionRunnerOptions,
    session: AgentSession,
    pi: PiSessionManager,
    agentDir: string,
    persisted: number,
  ) {
    this.sessionId = options.sessionId;
    this.#o = options;
    this.#session = session;
    this.#pi = pi;
    this.#agentDir = agentDir;
    this.#contextKey = JSON.stringify(options.contextFiles?.() ?? []);
    this.#persisted = persisted;
    this.tracer = tracerFor(options);
    this.#unsubscribe = session.subscribe((event) => this.#onEvent(event));
  }

  static async create(options: SessionRunnerOptions): Promise<SessionRunner> {
    const boxCwd = options.boxCwd ?? BOX_CWD;
    // pi reads settings, auth and context from agentDir: give it an empty one it owns.
    const agentDir = mkdtempSync(join(tmpdir(), "hearth-runner-"));
    let self: SessionRunner | undefined;
    const inner = options.box;
    // A failed prepare (the AGENTS.md refresh: its `runner.context` append)
    // fails the call, which releases the lease, and fails the runner (0015).
    // The lease wait (box start or wake) and each RPC's span go to the tracer.
    const box: RunnerBox = {
      ensureBox: async (callId) => {
        // Timed on the tracer's clock, like the tool call it is part of.
        const clock = options.clock ?? SYSTEM_CLOCK;
        const started = clock.mono();
        const lease = await inner.ensureBox(callId);
        self?.observe(() => self?.tracer.onLease(callId, lease.boxId, clock.mono() - started));
        return lease;
      },
      operations: (boxId, callId, trace) =>
        inner.operations(
          boxId,
          callId,
          trace ?? self?.observe(() => self?.tracer.rpcTrace(callId)),
        ),
      prepare: async (lease) => {
        try {
          await inner.prepare?.(lease);
        } catch (error) {
          if (self !== undefined) void self.#fail(error);
          throw error;
        }
      },
    };
    try {
      const settingsManager = SettingsManager.inMemory({});
      const extensionFactories = [
        {
          name: "hearth-tools",
          factory: hearthToolsExtension({
            box,
            boxCwd,
            denyList: options.denyList,
            onDenied: (_name, toolCallId, reason) =>
              self?.observe(() => self?.tracer.onDenied(toolCallId, reason)),
            liveOutput: (toolCallId) =>
              liveToolOutput(options, toolCallId, () => self?.tracer.turnId),
            ...(options.hubTempDir === undefined ? {} : { hubTempDir: options.hubTempDir }),
          }),
        },
        ...(options.extensions ?? []).map((e) => ({ name: e.name, factory: e.factory })),
        // QuickJS runs on the hub; its `tools.*` calls go through hearth-tools, so to
        // the box. `models` is off: scripts may not spend the session's key on other models.
        ...(options.codemode === true
          ? [{ name: "codemode", factory: createCodemodeExtension({ models: false }) }]
          : []),
        // Last, so it sees each request as the other extensions left it (decision 0021).
        {
          name: "hearth-trace",
          factory: (pi: ExtensionAPI) => {
            pi.on("context", (event) => {
              self?.observe(() => self?.observeRequest(event.messages.length));
              return undefined;
            });
            pi.on("before_provider_request", (event) => {
              self?.observe(() => self?.tracer.onPayload(event.payload));
              return undefined;
            });
          },
        },
      ];
      const loader = new DefaultResourceLoader({
        cwd: boxCwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        agentsFilesOverride: () => ({ agentsFiles: [...(options.contextFiles?.() ?? [])] }),
        extensionFactories,
      });
      await loader.reload();
      const pi = PiSessionManager.inMemory(
        boxCwd,
        undefined,
        options.entries === undefined ? undefined : [...options.entries],
      );
      const persisted = pi.getEntries().length;
      // A hub restart cut these calls off: give each an explicit outcome-unknown
      // result, so the model does not get pi-ai's "No result provided" and
      // re-run a command that may already have run in the box.
      const orphans = options.entries === undefined ? [] : orphanedToolCalls(pi.getBranch());
      for (const orphan of orphans) {
        pi.appendMessage({
          role: "toolResult",
          toolCallId: orphan.id,
          toolName: orphan.name,
          content: [{ type: "text", text: RESTART_OUTCOME_UNKNOWN }],
          isError: true,
          timestamp: Date.now(),
        });
      }
      const { session } = await createAgentSession({
        cwd: boxCwd,
        agentDir,
        modelRuntime: options.modelRuntime,
        model: options.model,
        resourceLoader: loader,
        sessionManager: pi,
        settingsManager,
        tools: [
          ...ROUTED_TOOLS,
          ...BROWSER_TOOLS,
          ...(options.codemode === true ? ["codemode"] : []),
        ],
      });
      const runner = new SessionRunner(options, session, pi, agentDir, persisted);
      self = runner;
      if (options.entries === undefined) {
        const header = pi.getHeader();
        if (header !== null && header !== undefined) {
          await options.events.append(options.scope, options.sessionId, {
            type: "runner.header",
            payload: jsonSafe(header, options.redact),
          });
        }
      }
      if (orphans.length > 0) {
        runner.#record("runner.outcome-unknown", {
          reason: "hub restart",
          toolCallIds: orphans.map((o) => o.id),
        });
        runner.#flushEntries();
        await runner.#chain;
      }
      return runner;
    } catch (error) {
      rmSync(agentDir, { recursive: true, force: true });
      throw error;
    }
  }

  get status(): RunnerStatus {
    return this.#status;
  }

  /** Why the runner failed, when `status` is `failed`. */
  get failure(): string | undefined {
    return this.#failure;
  }

  get activeTools(): string[] {
    return this.#session.getActiveToolNames();
  }

  get systemPrompt(): string {
    return this.#session.systemPrompt;
  }

  get messages(): AgentSession["messages"] {
    return this.#session.messages;
  }

  /** Resolves when the current turn and its event writes are done. Never rejects. */
  async settled(): Promise<void> {
    await this.#turn;
    await this.#chain;
    await this.#failing;
  }

  /**
   * Record the user's message and start a turn in the background. Rejects with
   * `runner.busy` while a turn runs and `runner.failed` after a failure.
   */
  async send(text: string): Promise<void> {
    if (this.#status === "failed") {
      throw new HearthError(`session ${this.sessionId} runner failed: ${this.#failure}`, {
        owner: "hub",
        disposition: "give-up",
        code: "runner.failed",
      });
    }
    if (this.#status === "running") {
      throw new HearthError(`session ${this.sessionId} is already running a turn`, {
        owner: "user",
        disposition: "retry",
        code: "runner.busy",
      });
    }
    this.#status = "running";
    this.#interrupted = false;
    const start = this.tracer.startTurn();
    const turnId = String(start.payload["turn_id"]);
    try {
      await this.#o.events.append(this.#o.scope, this.sessionId, {
        type: start.type,
        turnId,
        payload: jsonSafe(start.payload, this.#o.redact),
      });
      await this.#o.events.append(this.#o.scope, this.sessionId, {
        type: "message.user",
        turnId,
        payload: { text: this.#redact(text) },
      });
    } catch (error) {
      this.#status = "idle";
      this.tracer.endTurn("error", "could not record the message");
      throw error;
    }
    this.#turn = this.#runTurn(text);
  }

  /** Abort the running turn; the session stays usable. */
  async interrupt(): Promise<boolean> {
    if (this.#status !== "running") return false;
    this.#interrupted = true;
    this.#record("runner.interrupted", { reason: "interrupted by the user" });
    await this.#session.abort();
    return true;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#session.dispose();
    rmSync(this.#agentDir, { recursive: true, force: true });
  }

  async #runTurn(text: string): Promise<void> {
    try {
      await this.#refreshContext();
      await this.#session.prompt(text);
      this.#flushEntries();
      this.#endTurn(this.#interrupted ? "interrupted" : "done");
      await this.#chain;
      if (this.#status === "running") this.#status = "idle";
    } catch (error) {
      this.#endTurn("failed", this.#redact(errorText(error)));
      await this.#fail(error);
    }
  }

  /** Pick up a changed cached AGENTS.md before the turn (decision 0015). */
  async #refreshContext(): Promise<void> {
    const key = JSON.stringify(this.#o.contextFiles?.() ?? []);
    if (key === this.#contextKey) return;
    this.#contextKey = key;
    await this.#session.reload();
  }

  #onEvent(event: AgentSessionEvent): void {
    try {
      if (event.type === "message_end" && event.message.role === "assistant") {
        // A provider error can echo the key; the session keeps only the redacted text.
        const m = event.message as { errorMessage?: string };
        if (typeof m.errorMessage === "string") m.errorMessage = this.#redact(m.errorMessage);
      }
      this.#record(`pi.${event.type}`, event);
      const step = this.#safe(() => this.tracer.onEvent(event));
      if (step !== undefined) this.#record(step.type, step.payload);
      if (event.type === "message_end" || event.type === "agent_end") this.#flushEntries();
      if (event.type === "message_end" && event.message.role === "assistant") {
        const m = event.message;
        this.#record("runner.usage", {
          provider: m.provider,
          model: m.model,
          usage: m.usage,
          stopReason: m.stopReason,
        });
      }
    } catch (error) {
      void this.#fail(error);
    }
  }

  /**
   * Record the pi session entries appended since the last flush as
   * `runner.entry`: the rebuild reads them back (`SessionManager.inMemory`).
   * Runs in the event chain, after pi appended the entry for the event.
   */
  #flushEntries(): void {
    this.#chain = this.#chain
      .then(async () => {
        if (this.#status === "failed") return;
        const entries = this.#pi.getEntries();
        while (this.#persisted < entries.length) {
          const entry = entries[this.#persisted];
          await this.#o.events.append(this.#o.scope, this.sessionId, {
            type: "runner.entry",
            payload: { entry: jsonSafe(entry, this.#o.redact) },
          });
          this.#persisted++;
        }
      })
      .catch((error: unknown) => this.#fail(error));
  }

  #endTurn(outcome: "done" | "interrupted" | "failed", error?: string): void {
    const end: TracedEvent | undefined = this.#safe(() => this.tracer.endTurn(outcome, error));
    if (end === undefined) return;
    // Recorded even after a failure: the turn's end belongs in its trajectory.
    const event = {
      type: end.type,
      turnId: String(end.payload["turn_id"]),
      payload: jsonSafe(end.payload, this.#o.redact),
    };
    this.#chain = this.#chain
      .then(() => this.#o.events.append(this.#o.scope, this.sessionId, event))
      .then(
        () => undefined,
        (error: unknown) => {
          (this.#o.log ?? console.error)(
            `session ${this.sessionId}: could not record the turn end: ${this.#redact(errorText(error))}`,
          );
        },
      );
  }

  /** Observability never breaks a turn: a throwing hook is logged and ignored. */
  #safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      (this.#o.log ?? console.error)(
        `session ${this.sessionId}: tracer: ${this.#redact(errorText(error))}`,
      );
      return undefined;
    }
  }

  /** What the next model request asks for: pi's model, settings, prompt and tools. */
  observeRequest(messageCount: number): void {
    const s = this.#session;
    const model = s.model;
    this.tracer.onRequest({
      provider: String(model?.provider ?? "unknown"),
      model: String(model?.id ?? "unknown"),
      api: typeof model?.api === "string" ? model.api : undefined,
      thinkingLevel: s.thinkingLevel,
      modelMaxTokens: model?.maxTokens,
      contextWindow: model?.contextWindow,
      systemPrompt: s.systemPrompt,
      tools: s.state.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      messageCount,
    });
  }

  /** Run an observability hook; never throws (see `#safe`). */
  observe<T>(fn: () => T): T | undefined {
    return this.#safe(fn);
  }

  /** Append in order; a failed append fails the session, visibly. */
  #record(type: string, payload: unknown): void {
    const turnId = this.tracer?.turnId;
    const event = {
      type,
      ...(turnId === undefined ? {} : { turnId }),
      payload: jsonSafe(payload, this.#o.redact),
    };
    this.#chain = this.#chain
      .then(async () => {
        if (this.#status === "failed") return;
        await this.#o.events.append(this.#o.scope, this.sessionId, event);
      })
      .catch((error: unknown) => this.#fail(error));
  }

  #redact(text: string): string {
    return this.#o.redact === undefined ? text : this.#o.redact(text);
  }

  /** Mark the runner failed (once) and record it; `settled()` waits for the record. */
  #fail(error: unknown): Promise<void> {
    if (this.#status === "failed") return this.#failing;
    this.#status = "failed";
    this.#failure = this.#redact(errorText(error));
    this.#failing = this.#recordFailure();
    return this.#failing;
  }

  async #recordFailure(): Promise<void> {
    if (this.#failure === undefined) return;
    (this.#o.log ?? ((line: string) => console.error(line)))(
      `session ${this.sessionId}: runner failed: ${this.#failure}`,
    );
    try {
      await this.#session.abort();
    } catch {
      // The session is failed either way.
    }
    try {
      await this.#o.events.append(this.#o.scope, this.sessionId, {
        type: "runner.failed",
        payload: { message: this.#failure },
      });
    } catch (appendError) {
      (this.#o.log ?? console.error)(
        `session ${this.sessionId}: could not record the failure: ${this.#redact(errorText(appendError))}`,
      );
    }
    try {
      await this.#o.onFailure?.(this.#failure);
    } catch (stateError) {
      (this.#o.log ?? console.error)(
        `session ${this.sessionId}: could not mark the session failed: ${this.#redact(errorText(stateError))}`,
      );
    }
  }

  /** `[header, ...entries]`, as a rebuild would read them. */
  storedEntries(): FileEntry[] {
    const header = this.#pi.getHeader();
    return JSON.parse(JSON.stringify([header, ...this.#pi.getEntries()])) as FileEntry[];
  }
}

function tracerFor(options: SessionRunnerOptions): TurnTracer {
  defaultTelemetry ??= new Telemetry({ serviceVersion: HUB_VERSION });
  return new TurnTracer({
    sessionId: options.sessionId,
    telemetry: options.telemetry ?? defaultTelemetry,
    versions: { pi: PI_VERSION, hub: HUB_VERSION },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
    ...(options.redact === undefined ? {} : { redact: options.redact }),
  });
}
