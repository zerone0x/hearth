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
 * - `bash` drops pi's `env` (the hub's environment); the tool RPC has no field
 *   for it either.
 * - `grep` replaces `execute()` as a whole: pi's own grep always runs the
 *   hub's `rg`.
 * - `tool_call` rewrites `~` to the box workspace and applies the deny-list;
 *   `tool_result` rewrites hub temp paths (policy.ts).
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
import type { BoxId } from "@hearth/core";
import type { BoxToolOperations, RpcTrace } from "../box/tool-rpc";
import type { BoxLease } from "../session/manager";
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
}

export interface HearthToolsOptions {
  readonly box: RunnerBox;
  /** The box path pi sees as its cwd, `/workspace`. Tests point it at a temp dir. */
  readonly boxCwd: string;
  readonly denyList: readonly CompiledDenyRule[];
  /** Where hub temp files land (`os.tmpdir()`); results naming them are rewritten. */
  readonly hubTempDir?: string;
  /** Called after a call was blocked, for the event log. */
  readonly onDenied?: (toolName: string, toolCallId: string, reason: string) => void;
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

    pi.registerTool({
      ...createBashToolDefinition(boxCwd),
      execute: (id, params, signal, onUpdate, ctx) =>
        withOps(box, id, (ops) =>
          createBashToolDefinition(boxCwd, {
            operations: {
              // pi passes the hub's environment as `env`; it never leaves the hub.
              exec: (command, cwd, { onData, signal: execSignal, timeout }) =>
                ops.bash.exec(command, cwd, {
                  onData,
                  ...(execSignal === undefined ? {} : { signal: execSignal }),
                  ...(timeout === undefined ? {} : { timeout }),
                }),
            },
          }).execute(id, params, signal, onUpdate, ctx),
        ),
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
        const text = scrubHubTempPaths(part.text, options.hubTempDir);
        if (text === part.text) return part;
        changed = true;
        return { ...part, text };
      });
      return changed ? { content } : undefined;
    });
  };
}
