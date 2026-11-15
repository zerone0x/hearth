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
  type FileEntry,
  type ModelRuntime,
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
import type { PinnedExtension } from "./extensions";
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
  /**
   * Called once when the runner fails, after `runner.failed` is recorded: the
   * hub moves the session row to `failed` through the session manager.
   */
  readonly onFailure?: (message: string) => Promise<unknown>;
}

export type RunnerStatus = "idle" | "running" | "failed";

/** Largest payload the runner writes for one event; bigger ones are cut. */
export const MAX_RUNNER_EVENT_BYTES = 1024 * 1024;

/** Fields of a pi event that repeat what other events already carry. */
const BULKY_FIELDS = new Set(["partial", "messages", "toolResults"]);

function jsonSafe(value: unknown): JsonValue {
  const text = JSON.stringify(value, (key, v: unknown) =>
    BULKY_FIELDS.has(key) ? undefined : typeof v === "bigint" ? String(v) : v,
  );
  if (text === undefined) return null;
  if (text.length > MAX_RUNNER_EVENT_BYTES) {
    return { truncated: true, bytes: text.length, head: text.slice(0, 4096) };
  }
  return JSON.parse(text) as JsonValue;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  private constructor(
    options: SessionRunnerOptions,
    session: AgentSession,
    pi: PiSessionManager,
    agentDir: string,
  ) {
    this.sessionId = options.sessionId;
    this.#o = options;
    this.#session = session;
    this.#pi = pi;
    this.#agentDir = agentDir;
    this.#contextKey = JSON.stringify(options.contextFiles?.() ?? []);
    this.#persisted = pi.getEntries().length;
    this.#unsubscribe = session.subscribe((event) => this.#onEvent(event));
  }

  static async create(options: SessionRunnerOptions): Promise<SessionRunner> {
    const boxCwd = options.boxCwd ?? BOX_CWD;
    // pi reads settings, auth and context from agentDir: give it an empty one it owns.
    const agentDir = mkdtempSync(join(tmpdir(), "hearth-runner-"));
    try {
      const settingsManager = SettingsManager.inMemory({});
      const extensionFactories = [
        {
          name: "hearth-tools",
          factory: hearthToolsExtension({
            box: options.box,
            boxCwd,
            denyList: options.denyList,
            ...(options.hubTempDir === undefined ? {} : { hubTempDir: options.hubTempDir }),
          }),
        },
        ...(options.extensions ?? []).map((e) => ({ name: e.name, factory: e.factory })),
        // QuickJS runs on the hub; its `tools.*` calls go through hearth-tools, so to
        // the box. `models` is off: scripts may not spend the session's key on other models.
        ...(options.codemode === true
          ? [{ name: "codemode", factory: createCodemodeExtension({ models: false }) }]
          : []),
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
      const { session } = await createAgentSession({
        cwd: boxCwd,
        agentDir,
        modelRuntime: options.modelRuntime,
        model: options.model,
        resourceLoader: loader,
        sessionManager: pi,
        settingsManager,
        tools: [...ROUTED_TOOLS, ...(options.codemode === true ? ["codemode"] : [])],
      });
      const runner = new SessionRunner(options, session, pi, agentDir);
      if (options.entries === undefined) {
        const header = pi.getHeader();
        if (header !== null && header !== undefined) {
          await options.events.append(options.scope, options.sessionId, {
            type: "runner.header",
            payload: jsonSafe(header),
          });
        }
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
    try {
      await this.#o.events.append(this.#o.scope, this.sessionId, {
        type: "message.user",
        payload: { text },
      });
    } catch (error) {
      this.#status = "idle";
      throw error;
    }
    this.#turn = this.#runTurn(text);
  }

  /** Abort the running turn; the session stays usable. */
  async interrupt(): Promise<boolean> {
    if (this.#status !== "running") return false;
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
      await this.#chain;
      if (this.#status === "running") this.#status = "idle";
    } catch (error) {
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
      this.#record(`pi.${event.type}`, event);
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
            payload: { entry: jsonSafe(entry) },
          });
          this.#persisted++;
        }
      })
      .catch((error: unknown) => this.#fail(error));
  }

  /** Append in order; a failed append fails the session, visibly. */
  #record(type: string, payload: unknown): void {
    const event = { type, payload: jsonSafe(payload) };
    this.#chain = this.#chain
      .then(async () => {
        if (this.#status === "failed") return;
        await this.#o.events.append(this.#o.scope, this.sessionId, event);
      })
      .catch((error: unknown) => this.#fail(error));
  }

  async #fail(error: unknown): Promise<void> {
    if (this.#status === "failed") return;
    this.#status = "failed";
    this.#failure = errorText(error);
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
        `session ${this.sessionId}: could not record the failure: ${errorText(appendError)}`,
      );
    }
    try {
      await this.#o.onFailure?.(this.#failure);
    } catch (stateError) {
      (this.#o.log ?? console.error)(
        `session ${this.sessionId}: could not mark the session failed: ${errorText(stateError)}`,
      );
    }
  }

  /** `[header, ...entries]`, as a rebuild would read them. */
  storedEntries(): FileEntry[] {
    const header = this.#pi.getHeader();
    return JSON.parse(JSON.stringify([header, ...this.#pi.getEntries()])) as FileEntry[];
  }
}
