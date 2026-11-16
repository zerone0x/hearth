/**
 * The hub's runners: one `SessionRunner` per session, created on the first
 * message and rebuilt from the event log after a hub restart (decision 0015).
 *
 * - Every call authorizes first (`session.message`, `session.interrupt`,
 *   `session.events`, `session.configure`), then checks the session exists.
 * - The model key comes from the `SecretStore` and is applied in memory with
 *   `ModelRuntime.setRuntimeApiKey`: the `direct` model gateway of PRD §6.4.
 *   No auth file, no hub environment variable reaches pi. The key is
 *   redacted from everything the runners store or log.
 * - AGENTS.md: the hub keeps the last copy read from the box (`runner.context`
 *   in the event log) and refreshes it on the first box lease of each turn. It
 *   never starts a box just to read it.
 * - Crash isolation: a runner that throws fails its own session (status and a
 *   `runner.failed` event); other sessions and the hub keep going.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type FileEntry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  type EventPage,
  type EventStore,
  HearthError,
  type Principal,
  type SecretRef,
  type SecretStore,
  type SessionId,
  type WorkspaceScope,
} from "@hearth/core";
import type { BoxToolOperations, RpcTrace } from "../box/tool-rpc";
import type { DesktopLockCheck } from "../desktop/lock";
import { registerSecret } from "../obs/redaction";
import type { Telemetry } from "../obs/telemetry";
import { bodyOf, type RequestBody } from "../request-body";
import type { BoxLease, SessionView } from "../session/manager";
import { type ExtensionPin, type PinnedExtension, selectExtensions } from "./extensions";
import { type CompiledDenyRule, compileDenyList, type DenyRule } from "./policy";
import {
  BOX_CWD,
  type ContextFile,
  type RunnerStatus,
  redactSecrets,
  SessionRunner,
} from "./runner";
import type { RunnerBox } from "./tools";

/** The runner's config (hub config; see docs/runner.md). */
export interface RunnerConfig {
  /** pi provider id, e.g. `anthropic`. */
  readonly provider: string;
  /** pi model id, e.g. `claude-sonnet-5-5`. */
  readonly model: string;
  /** SecretStore reference of the provider key, e.g. `env:ANTHROPIC_API_KEY`. */
  readonly apiKeyRef?: SecretRef;
  readonly denyList?: readonly DenyRule[];
  /** Allowlisted pinned extensions (#56). Empty by default. */
  readonly extensionAllowlist?: readonly ExtensionPin[];
  /**
   * A pi `models.json` (`HEARTH_MODELS_FILE`, decision 0020): providers and
   * models beyond pi's built-in ones, such as an OpenAI-compatible endpoint.
   * Unset: built-in models only.
   */
  readonly modelsFile?: string;
}

export interface RunnerSessions {
  ensureBox(sessionId: SessionId): Promise<BoxLease>;
  get(principal: Principal, sessionId: SessionId): Promise<SessionView>;
  /** Move the session to `failed` through the state machine (the runner failed). */
  fail(sessionId: SessionId, reason: string): Promise<unknown>;
}

export interface SessionRunnersOptions {
  readonly authorizer: Authorizer;
  readonly events: EventStore;
  readonly sessions: RunnerSessions;
  readonly tools: {
    operations(boxId: string, callId: string, trace?: RpcTrace): BoxToolOperations;
  };
  readonly secrets: SecretStore;
  readonly config: RunnerConfig;
  /** Tests pass a runtime with pi-ai's faux provider; otherwise one is created. */
  readonly modelRuntime?: ModelRuntime;
  /** Extensions bundled with the hub; only allowlisted ones load. */
  readonly availableExtensions?: readonly PinnedExtension[];
  readonly boxCwd?: string;
  readonly hubTempDir?: string;
  readonly log?: (line: string) => void;
  /** Spans and metrics (decision 0021); exports nothing unless configured. */
  readonly telemetry?: Telemetry;
  /**
   * The desktop lock (decision 0033): the browser tools refuse with
   * `desktop.locked` while a person holds the session's desktop. Unset (tests
   * without a desktop), nothing is locked.
   */
  readonly desktopLocks?: DesktopLockCheck;
}

export interface RunnerOptionsInput {
  /** pi's codemode tool, off by default (decision 0015). */
  readonly codemode?: boolean;
}

export interface RunnerView {
  readonly status: RunnerStatus | "none";
  readonly failure: string | null;
  readonly codemode: boolean;
}

/** Context files the hub reads from the box, in pi's order. */
export const CONTEXT_FILE_NAMES = ["AGENTS.md"] as const;

function failure(code: string, message: string, owner: "user" | "hub" = "user"): HearthError {
  return new HearthError(message, {
    owner,
    disposition: owner === "user" ? "give-up" : "retry",
    code,
  });
}

export class SessionRunners {
  readonly #o: SessionRunnersOptions;
  readonly #scope: WorkspaceScope = { workspaceId: DEFAULT_WORKSPACE_ID };
  readonly #runners = new Map<SessionId, Promise<SessionRunner>>();
  readonly #context = new Map<SessionId, readonly ContextFile[]>();
  readonly #contextFresh = new Set<SessionId>();
  readonly #denyList: readonly CompiledDenyRule[];
  readonly #extensions: readonly PinnedExtension[];
  #runtime: Promise<ModelRuntime> | undefined;
  /** SecretStore values the runners use (the model key): redacted from stored and logged text. */
  readonly #secretValues = new Set<string>();

  constructor(options: SessionRunnersOptions) {
    this.#o = options;
    this.#denyList = compileDenyList(options.config.denyList ?? []);
    const selection = selectExtensions(
      options.availableExtensions ?? [],
      options.config.extensionAllowlist ?? [],
    );
    for (const r of selection.refused) {
      (options.log ?? console.error)(`runner: extension ${r.name} not loaded: ${r.reason}`);
    }
    this.#extensions = selection.loaded;
  }

  /** `text` with every secret the runners use replaced (decision 0015). */
  redact(text: string): string {
    return redactSecrets(text, this.#secretValues);
  }

  #log(line: string): void {
    (this.#o.log ?? console.error)(this.redact(line));
  }

  /** Names of the extensions that load besides Hearth's own. */
  get loadedExtensions(): string[] {
    return this.#extensions.map((e) => e.name);
  }

  async configure(
    principal: Principal,
    sessionId: SessionId,
    body: RunnerOptionsInput | RequestBody<RunnerOptionsInput>,
  ): Promise<RunnerView> {
    await this.#authorize(principal, "session.configure", sessionId);
    // A `RequestBody` is read only now, after `authorize` (#32).
    const input = await bodyOf(body);
    if (this.#runners.has(sessionId) || (await this.#readLog(sessionId)).header !== undefined) {
      throw failure("runner.configured", "runner options are set before the first message");
    }
    await this.#o.events.append(this.#scope, sessionId, {
      type: "runner.options",
      payload: { codemode: input.codemode === true },
    });
    return this.view(principal, sessionId);
  }

  async view(principal: Principal, sessionId: SessionId): Promise<RunnerView> {
    await this.#authorize(principal, "session.read", sessionId);
    const pending = this.#runners.get(sessionId);
    const log = await this.#readLog(sessionId);
    if (pending === undefined) {
      return { status: "none", failure: null, codemode: log.codemode };
    }
    const runner = await pending.catch(() => undefined);
    return {
      status: runner?.status ?? "failed",
      failure: runner?.failure ?? null,
      codemode: log.codemode,
    };
  }

  /** Send a user message: starts a turn in the background. */
  async send(
    principal: Principal,
    sessionId: SessionId,
    message: string | RequestBody<string>,
  ): Promise<void> {
    const session = await this.#authorize(principal, "session.message", sessionId);
    // A `RequestBody` is read only now, after `authorize` (#32).
    const text = await bodyOf(message);
    if (session.state === "failed" || session.state === "archived") {
      throw new HearthError(`session ${sessionId} is ${session.state}`, {
        owner: "hub",
        disposition: "give-up",
        code: "runner.failed",
      });
    }
    if (text.length === 0) throw failure("request.invalid", "the message is empty");
    const runner = await this.runner(sessionId);
    this.#contextFresh.delete(sessionId);
    await runner.send(text);
  }

  /** Interrupt the running turn. Resolves `false` when nothing was running. */
  async interrupt(principal: Principal, sessionId: SessionId): Promise<boolean> {
    await this.#authorize(principal, "session.interrupt", sessionId);
    const pending = this.#runners.get(sessionId);
    if (pending === undefined) return false;
    return (await pending).interrupt();
  }

  /** Events after `cursor` (cursor resume, PRD §6.1). */
  async events(
    principal: Principal,
    sessionId: SessionId,
    cursor: number,
    limit: number,
  ): Promise<EventPage> {
    await this.#authorize(principal, "session.events", sessionId);
    return this.#o.events.read(this.#scope, sessionId, cursor, limit);
  }

  /** The session's runner, created or rebuilt from the event log on first use. */
  runner(sessionId: SessionId): Promise<SessionRunner> {
    let pending = this.#runners.get(sessionId);
    if (pending === undefined) {
      pending = this.#create(sessionId);
      this.#runners.set(sessionId, pending);
      pending.catch(() => this.#runners.delete(sessionId));
    }
    return pending;
  }

  /** Drop every runner (hub stop). */
  async close(): Promise<void> {
    const all = [...this.#runners.values()];
    this.#runners.clear();
    for (const pending of all) {
      const runner = await pending.catch(() => undefined);
      runner?.dispose();
    }
  }

  async #create(sessionId: SessionId): Promise<SessionRunner> {
    const log = await this.#readLog(sessionId);
    if (log.context !== undefined) this.#context.set(sessionId, log.context);
    const runtime = await this.#modelRuntime();
    const model = runtime.getModel(this.#o.config.provider, this.#o.config.model);
    if (model === undefined) {
      throw failure(
        "runner.unknown-model",
        `model ${this.#o.config.provider}/${this.#o.config.model} is not known to pi`,
      );
    }
    return SessionRunner.create({
      sessionId,
      scope: this.#scope,
      events: this.#o.events,
      box: this.#box(sessionId),
      modelRuntime: runtime,
      model: model as Model<string>,
      denyList: this.#denyList,
      extensions: this.#extensions,
      codemode: log.codemode,
      ...(log.header === undefined ? {} : { entries: [log.header, ...log.entries] }),
      contextFiles: () => this.#context.get(sessionId) ?? [],
      ...(this.#o.boxCwd === undefined ? {} : { boxCwd: this.#o.boxCwd }),
      ...(this.#o.hubTempDir === undefined ? {} : { hubTempDir: this.#o.hubTempDir }),
      log: (line) => this.#log(line),
      redact: (text) => this.redact(text),
      ...(this.#o.telemetry === undefined ? {} : { telemetry: this.#o.telemetry }),
      onFailure: (message) => this.#o.sessions.fail(sessionId, `runner failed: ${message}`),
    });
  }

  #modelRuntime(): Promise<ModelRuntime> {
    this.#runtime ??= (async () => {
      const runtime =
        this.#o.modelRuntime ??
        (await ModelRuntime.create({
          // An empty file of the hub's own: no `~/.pi/agent/auth.json`.
          authPath: join(mkdtempSync(join(tmpdir(), "hearth-auth-")), "auth.json"),
          modelsPath: this.#o.config.modelsFile ?? null,
          refreshOnCreate: false,
        }));
      if (this.#o.config.apiKeyRef !== undefined) {
        const key = (await this.#o.secrets.resolve(this.#o.config.apiKeyRef)).reveal();
        this.#secretValues.add(key);
        registerSecret(key);
        await runtime.setRuntimeApiKey(this.#o.config.provider, key);
      }
      return runtime;
    })();
    this.#runtime.catch(() => {
      this.#runtime = undefined;
    });
    return this.#runtime;
  }

  #box(sessionId: SessionId): RunnerBox {
    const boxCwd = this.#o.boxCwd ?? BOX_CWD;
    return {
      ensureBox: () => this.#o.sessions.ensureBox(sessionId),
      // Inside the call's lease try/finally: a failed `runner.context` append
      // releases the lease and fails the runner (runner.ts).
      prepare: async (lease) => {
        if (this.#contextFresh.has(sessionId)) return;
        this.#contextFresh.add(sessionId);
        await this.#refreshContext(sessionId, lease, boxCwd);
      },
      operations: (boxId, callId, trace) => this.#o.tools.operations(boxId, callId, trace),
      // The browser tools refuse while the owner holds the desktop (decisions 0033, 0035).
      assertDesktopUnlocked: () => this.#o.desktopLocks?.assertUnlocked(sessionId),
    };
  }

  /** Read AGENTS.md from the box while a lease is held; keep the last good copy. */
  async #refreshContext(sessionId: SessionId, lease: BoxLease, boxCwd: string): Promise<void> {
    const ops = this.#o.tools.operations(lease.boxId, `context_${randomUUID()}`);
    const files: ContextFile[] = [];
    for (const name of CONTEXT_FILE_NAMES) {
      const path = `${boxCwd}/${name}`;
      try {
        if (!(await ops.ls.exists(path))) continue;
        files.push({ path, content: (await ops.read.readFile(path)).toString("utf8") });
      } catch (error) {
        this.#log(`session ${sessionId}: could not read ${path} from the box: ${String(error)}`);
        return;
      }
    }
    if (JSON.stringify(files) === JSON.stringify(this.#context.get(sessionId) ?? [])) return;
    this.#context.set(sessionId, files);
    await this.#o.events.append(this.#scope, sessionId, {
      type: "runner.context",
      payload: { files: files.map((f) => ({ path: f.path, content: f.content })) },
    });
  }

  async #readLog(sessionId: SessionId): Promise<{
    header: FileEntry | undefined;
    entries: FileEntry[];
    codemode: boolean;
    context: ContextFile[] | undefined;
  }> {
    let header: FileEntry | undefined;
    const entries: FileEntry[] = [];
    let codemode = false;
    let context: ContextFile[] | undefined;
    let cursor = 0;
    for (;;) {
      const page = await this.#o.events.read(this.#scope, sessionId, cursor, 1000);
      for (const event of page.events) {
        const payload = event.payload as {
          entry?: unknown;
          codemode?: unknown;
          files?: unknown;
        } | null;
        if (event.type === "runner.header") header = payload as unknown as FileEntry;
        else if (event.type === "runner.entry" && payload !== null) {
          entries.push(payload.entry as FileEntry);
        } else if (event.type === "runner.options" && payload !== null) {
          codemode = payload.codemode === true;
        } else if (event.type === "runner.context" && payload !== null) {
          context = payload.files as ContextFile[];
        }
      }
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    return { header, entries, codemode, context };
  }

  async #authorize(
    principal: Principal,
    action: `${string}.${string}`,
    sessionId: SessionId,
  ): Promise<SessionView> {
    const decision = await this.#o.authorizer.authorize(principal, action, {
      workspaceId: this.#scope.workspaceId,
      type: "session",
      id: sessionId,
    });
    if (!decision.allowed) {
      throw new HearthError(`${action} denied: ${decision.reason}`, {
        owner: "user",
        disposition: "give-up",
        code: "authz.denied",
      });
    }
    // Throws session.not-found for an unknown session.
    return await this.#o.sessions.get(principal, sessionId);
  }
}
