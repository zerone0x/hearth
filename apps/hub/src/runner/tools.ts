/**
 * The Hearth extension (PRD §8.2.1; decisions 0009, 0011): registers pi's
 * seven file and shell tools under their built-in names, so they replace the
 * built-ins, and routes each one to the session's box through the tool RPC.
 *
 * - Every tool call first takes a box lease (`SessionManager.ensureBox`: lazy
 *   start, wake, in-flight accounting) and releases it when the call ends,
 *   whatever the outcome.
 * - The operations are built per call, so every box call carries pi's tool
 *   call id.
 * - `bash` drops pi's `env` (the hub's environment). Its own optional `env`
 *   (decision 0041) maps variable names to `vault:` references of tokens
 *   opted in to box commands; the hub resolves them through the vault
 *   (audited first) and sends the values in that one `tool.exec` only. Each
 *   value joins the session's scrub set before it is sent, and the command's
 *   output is scrubbed before pi sees it.
 * - `grep` replaces `execute()` as a whole: pi's own grep always runs the
 *   hub's `rg`.
 * - `tool_call` rewrites `~` to the box workspace and applies the deny-list;
 *   `tool_result` rewrites hub temp paths (policy.ts).
 * - The `browser_*` tools (browser-tools.ts, decision 0032) go to the box the
 *   same way, as `browser.*` methods of the tool RPC, and refuse while the
 *   owner holds the desktop lock (decision 0035).
 * - Every value `browser_fill` filled (decision 0039) or `bash` passed in its
 *   env (decision 0041) is replaced in the text of every later tool result of
 *   the session, whatever the tool, before the model reads it. The scrub uses
 *   every secret the hub knows (`knownSecrets`: the vault registers each stored
 *   value when it opens) on top of the values this runner used, so it holds
 *   after the runner is rebuilt (a model switch, decision 0038, or a restart).
 */

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  type BoxId,
  HearthError,
  LOG_REDACTED,
  redactValues,
  type SecretValue,
  type VaultKind,
  type VaultPolicy,
} from "@hearth/core";
import { Type } from "typebox";
import { type BoxToolOperations, NO_SECRET_ENV_IN_BOX, type RpcTrace } from "../box/tool-rpc";
import { knownSecrets } from "../obs/redaction";
import type { BoxLease } from "../session/manager";
import { BASH_ENV_HINT, BASH_ENV_PARAMETER, envRefusal, parseEnvRefs } from "./bash-env";
import { registerBrowserTools } from "./browser-tools";
import {
  type CompiledDenyRule,
  denied,
  PATH_TOOLS,
  rewriteHome,
  scrubHubTempPaths,
} from "./policy";

/** The tools the runner routes to the box. */
export const ROUTED_TOOLS = ["read", "write", "edit", "bash", "ls", "find", "grep"] as const;

/** What the extension needs from the hub for one session. */
export interface RunnerBox {
  /** `SessionManager.ensureBox` for this session; `callId` is the pi tool call it is for. */
  ensureBox(callId?: string): Promise<BoxLease>;
  /** `ToolRpcClient.operations`; `trace` observes each RPC (decision 0021). */
  operations(boxId: BoxId, callId: string, trace?: RpcTrace): BoxToolOperations;
  /**
   * Runs after the lease is taken and before the call, inside the lease's
   * try/finally (the AGENTS.md refresh). If it throws, the lease is released
   * and the call fails.
   */
  prepare?(lease: BoxLease): Promise<void>;
  /**
   * Resolves a `vault:` login for `browser_fill` (decision 0039): the session's
   * `HubVault.use` with the page origin the box reported, audited before it
   * returns. Unset (no vault), `browser_fill` refuses.
   */
  useSecret?(ref: string, context: SecretUseContext): Promise<FillSecret>;
  /**
   * Resolves a `vault:` token for `bash`'s `env` (decision 0041): the
   * session's `HubVault.use` for a `box-env` token, refused before decrypt
   * for anything else, audited before it returns. Unset (no vault), a call
   * with `env` refuses.
   */
  useEnvSecret?(ref: string, context: EnvSecretContext): Promise<{ readonly value: SecretValue }>;
  /**
   * Throws `desktop.locked` while a person holds this session's desktop lock
   * (`DesktopLocks.assertUnlocked`, decision 0033). The browser tools call it
   * before anything else; unset, nothing is locked.
   */
  assertDesktopUnlocked?(): void;
}

/** What `browser_fill` tells the vault about a use. */
export interface SecretUseContext {
  readonly toolCallId: string;
  /** The owner frame's origin, as the box reported it. */
  readonly origin: string;
}

/** What `bash` tells the vault about a use of a token in its env. */
export interface EnvSecretContext {
  readonly toolCallId: string;
  /** The variable the value goes into. */
  readonly env: string;
}

/** What the model reads when a call has `env` and the hub has no vault. */
export const NO_VAULT_FOR_ENV =
  "bash env is not available: the hub has no vault. Ask the owner to set one up. Nothing was run.";

/** A login value for `browser_fill`, with the policy read from the authenticated row. */
export interface FillSecret {
  readonly value: SecretValue;
  readonly kind: VaultKind;
  readonly field: string;
  readonly policy: VaultPolicy;
}

export interface HearthToolsOptions {
  readonly box: RunnerBox;
  /** The box path pi sees as its cwd, `/workspace`. Tests point it at a temp dir. */
  readonly boxCwd: string;
  readonly denyList: readonly CompiledDenyRule[];
  /** Where hub temp files land (`os.tmpdir()`); results naming them are rewritten. */
  readonly hubTempDir?: string;
  /**
   * The live output of one `bash` call (decision 0036): gets the command's
   * output as the box streams it, and `close()` when the call ends. Without
   * it the call answers once, as before.
   */
  readonly liveOutput?: (toolCallId: string) => LiveOutputSink;
  /** Called after a call was blocked, for the event log. */
  readonly onDenied?: (toolName: string, toolCallId: string, reason: string) => void;
  /** Called after a browser tool was refused for the desktop lock, for the trajectory. */
  readonly onRefused?: (toolName: string, toolCallId: string, code: string) => void;
}

/** Where a running command's streamed output goes (`LiveToolOutput`). */
export interface LiveOutputSink {
  /** False once it wants no more output (capped or stopped): the box is told to stop. */
  write(chunk: Uint8Array): boolean;
  close(): void;
}

const GREP_DEFAULT_LIMIT = 100;

/** Run `fn` with this call's operations while holding a box lease. */
async function withOps<T>(
  box: RunnerBox,
  callId: string,
  fn: (ops: BoxToolOperations) => Promise<T>,
): Promise<T> {
  const lease = await box.ensureBox(callId);
  try {
    await box.prepare?.(lease);
    return await fn(box.operations(lease.boxId, callId));
  } finally {
    lease.release();
  }
}

function absolute(path: string | undefined, boxCwd: string): string {
  if (path === undefined || path.length === 0 || path === ".") return boxCwd;
  if (path.startsWith("/")) return path;
  return `${boxCwd}/${path.replace(/^\.\//, "")}`;
}

export function hearthToolsExtension(options: HearthToolsOptions): ExtensionFactory {
  const { box, boxCwd } = options;
  return (pi) => {
    // The values browser_fill filled or bash passed through this runner: never shown to the
    // model. The tool_result scrub adds every registered secret, which a rebuilt runner keeps.
    const filled = new Set<string>();
    pi.registerTool({
      ...createReadToolDefinition(boxCwd),
      execute: (id, params, signal, onUpdate, ctx) =>
        withOps(box, id, (ops) =>
          createReadToolDefinition(boxCwd, { operations: ops.read }).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          ),
        ),
    });

    pi.registerTool({
      ...createWriteToolDefinition(boxCwd),
      execute: (id, params, signal, onUpdate, ctx) =>
        withOps(box, id, (ops) =>
          createWriteToolDefinition(boxCwd, { operations: ops.write }).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          ),
        ),
    });

    pi.registerTool({
      ...createEditToolDefinition(boxCwd),
      execute: (id, params, signal, onUpdate, ctx) =>
        withOps(box, id, (ops) =>
          createEditToolDefinition(boxCwd, { operations: ops.edit }).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          ),
        ),
    });

    const bash = createBashToolDefinition(boxCwd);
    pi.registerTool({
      ...bash,
      description: `${bash.description} ${BASH_ENV_HINT}`,
      parameters: Type.Object({ ...bash.parameters.properties, env: BASH_ENV_PARAMETER }),
      execute: async (id, raw, signal, onUpdate, ctx) => {
        const { env, ...params } = raw as { command: string; timeout?: number; env?: unknown };
        // Checked before a lease: a refused call neither starts nor wakes the box.
        const refs = parseEnvRefs(env);
        const useEnvSecret = box.useEnvSecret;
        if (refs.length > 0 && useEnvSecret === undefined) throw new Error(NO_VAULT_FOR_ENV);
        const values: string[] = [];
        const scrub = (text: string) =>
          values.length === 0 ? text : redactValues(text, values, LOG_REDACTED);
        try {
          return await withOps(box, id, async (ops) => {
            let secretEnv: Record<string, string> | undefined;
            if (refs.length > 0 && useEnvSecret !== undefined) {
              // Before the vault is asked: an old box would drop the variables.
              if (!ops.bash.acceptsSecretEnv()) throw new Error(NO_SECRET_ENV_IN_BOX);
              secretEnv = {};
              for (const { name, ref } of refs) {
                // Refused before decrypt, audited before it returns; a SecretError names the ref only.
                const secret = await useEnvSecret(ref, { toolCallId: id, env: name }).catch(
                  (error: unknown) => {
                    if (error instanceof HearthError && error.code !== undefined) {
                      throw envRefusal(error.code, error.message);
                    }
                    throw error;
                  },
                );
                const value = secret.value.reveal();
                // Before the value leaves the hub: this result and every later one are scrubbed.
                filled.add(value);
                values.push(value);
                secretEnv[name] = value;
              }
            }
            return await createBashToolDefinition(boxCwd, {
              operations: {
                // pi passes the hub's environment as `env`; it never leaves the hub.
                exec: async (command, cwd, { onData, signal: execSignal, timeout }) => {
                  const live = options.liveOutput?.(id);
                  try {
                    return await ops.bash.exec(command, cwd, {
                      // Scrubbed before pi sees it: its result, updates and temp file.
                      onData: (data) => {
                        onData(
                          values.length === 0 ? data : Buffer.from(scrub(data.toString("utf8"))),
                        );
                      },
                      ...(execSignal === undefined ? {} : { signal: execSignal }),
                      ...(timeout === undefined ? {} : { timeout }),
                      ...(live === undefined ? {} : { onOutput: (chunk) => live.write(chunk) }),
                      ...(secretEnv === undefined ? {} : { secretEnv }),
                    });
                  } finally {
                    // The result (through onData) is the answer from here on.
                    live?.close();
                  }
                },
              },
            }).execute(id, params, signal, onUpdate, ctx);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const clean = scrub(message);
          throw clean === message ? error : new Error(clean);
        }
      },
    });

    pi.registerTool({
      ...createLsToolDefinition(boxCwd),
      execute: (id, params, signal, onUpdate, ctx) =>
        withOps(box, id, (ops) =>
          createLsToolDefinition(boxCwd, { operations: ops.ls }).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          ),
        ),
    });

    pi.registerTool({
      ...createFindToolDefinition(boxCwd),
      execute: (id, params, signal, onUpdate, ctx) =>
        withOps(box, id, (ops) =>
          createFindToolDefinition(boxCwd, { operations: ops.find }).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          ),
        ),
    });

    pi.registerTool({
      ...createGrepToolDefinition(boxCwd),
      execute: (id, params) =>
        withOps(box, id, async (ops) => {
          const result = await ops.grep.search({
            pattern: params.pattern,
            path: absolute(params.path, boxCwd),
            ...(params.glob === undefined ? {} : { glob: params.glob }),
            ignoreCase: params.ignoreCase ?? false,
            literal: params.literal ?? false,
            context: Math.max(0, Math.floor(params.context ?? 0)),
            limit: Math.max(1, Math.floor(params.limit ?? GREP_DEFAULT_LIMIT)),
          });
          let text = result.output.length > 0 ? result.output : "No matches found";
          if (result.limitReached) text += "\n\n[match limit reached; narrow the search]";
          return { content: [{ type: "text", text }], details: undefined };
        }),
    });

    registerBrowserTools(pi, box, options.onRefused, filled);

    pi.on("tool_call", (event) => {
      if (PATH_TOOLS.has(event.toolName)) {
        const input = event.input as { path?: unknown };
        if (typeof input.path === "string") input.path = rewriteHome(input.path, boxCwd);
      }
      const rule = denied(options.denyList, event.toolName, event.input, boxCwd);
      if (rule === undefined) return undefined;
      options.onDenied?.(event.toolName, event.toolCallId, rule.reason);
      return { block: true, reason: rule.reason };
    });

    pi.on("tool_result", (event) => {
      let changed = false;
      const content = event.content.map((part) => {
        if (part.type !== "text") return part;
        let text = scrubHubTempPaths(part.text, options.hubTempDir);
        text = redactValues(text, [...filled, ...knownSecrets()], LOG_REDACTED);
        if (text === part.text) return part;
        changed = true;
        return { ...part, text };
      });
      return changed ? { content } : undefined;
    });
  };
}
