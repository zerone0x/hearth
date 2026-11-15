/**
 * The hub side of the tool RPC (decision 0011): sends tool calls to a box and
 * owns their deadlines. The runner (#43) adapts `operations()` to pi's tools.
 *
 * - **Per-call deadline.** Every call has a named deadline from its own budget,
 *   `toolDeadlineMs` (the command timeout plus a grace for `tool.exec`), never a
 *   global one (PRD §8.1, principles 3 and 8). When it passes the caller gets
 *   `tool.deadline`; a running command is cancelled.
 * - **Reconnects.** A dropped connection does not fail a call. When the box
 *   comes back on the **same boot**, the client re-sends the call with the same
 *   `rpc` id; the box runs an id at most once per boot, so it answers from the
 *   running call or its kept answer. When the box comes back with a **new
 *   boot**, the call's outcome is unknown: the client fails it with
 *   `tool.outcome-unknown` and never re-sends it (PRD §8.2.1). A connection
 *   the hub's heartbeat declares **dead** (decision 0028) fails its calls
 *   with `tool.outcome-unknown` at once.
 * - **pi's error strings.** `BashOperations.exec` rejects with exactly
 *   `aborted` on abort and `timeout:<seconds>` on the command's timeout, the
 *   messages pi's bash tool turns into "Command aborted" and "Command timed
 *   out after N seconds".
 */

import { randomUUID } from "node:crypto";
import { type BoxId, HearthError } from "@hearth/core";
import {
  classifyToolError,
  DEFAULT_EXEC_TIMEOUT_MS,
  decodeToolResult,
  MAX_EXEC_TIMEOUT_MS,
  MUTATING_TOOL_METHODS,
  type RpcFrame,
  type RpcResultFrame,
  type ToolMethod,
  type ToolParams,
  type ToolResults,
  toolDeadlineMs,
} from "@hearth/protocol";
import type { BoxConnections } from "./connections";

/** Params without `callId`, which the client fills in. */
export type CallParams<M extends ToolMethod> = Omit<ToolParams[M], "callId">;

export interface ToolRpcClientOptions {
  readonly boxes: Pick<BoxConnections, "listen" | "sendRpc">;
  /** Overrides `toolDeadlineMs`; tests shorten it. */
  readonly deadlineMs?: <M extends ToolMethod>(method: M, params: ToolParams[M]) => number;
  readonly log?: (line: string) => void;
}

export interface CallOptions {
  /** pi's abort signal: the call rejects with `aborted`, and a command is cancelled. */
  readonly signal?: AbortSignal;
  /** Observability for this call (decision 0021): its `traceparent` and outcome. */
  readonly trace?: RpcTrace;
}

/** How one RPC ended, for the trajectory. */
export interface RpcOutcome {
  readonly ok: boolean;
  /** The `HearthError` code, `aborted`, or the exec outcome (`timed-out`, `cancelled`). */
  readonly code?: string;
  /** `tool.exec` only: the command's exit code. */
  readonly exitCode?: number | null;
}

/** One RPC as the tracer sees it: the span's `traceparent` and its end. */
export interface RpcSpan {
  readonly traceparent?: string;
  end(outcome: RpcOutcome): void;
}

/** Per pi tool call: opens a span for each RPC it makes. */
export interface RpcTrace {
  rpc(method: ToolMethod, rpcId: string): RpcSpan;
}

interface Pending {
  readonly boxId: BoxId;
  readonly bootId: string;
  readonly method: ToolMethod;
  readonly frame: RpcFrame;
  readonly settle: (frame: RpcResultFrame | HearthError) => void;
}

function toolError(method: ToolMethod, code: string, message: string): HearthError {
  return new HearthError(message, { ...classifyToolError(code, method), code });
}

/**
 * pi's operations interfaces, one to one (pi 1.5.2 `dist/core/tools/*.d.ts`).
 * Structural copies, so the hub does not depend on pi until the runner lands.
 */
export interface BoxToolOperations {
  readonly read: {
    readFile(absolutePath: string): Promise<Buffer>;
    access(absolutePath: string): Promise<void>;
    detectImageMimeType(absolutePath: string): Promise<string | null | undefined>;
  };
  readonly write: {
    writeFile(absolutePath: string, content: string): Promise<void>;
    mkdir(dir: string): Promise<void>;
  };
  readonly edit: {
    readFile(absolutePath: string): Promise<Buffer>;
    writeFile(absolutePath: string, content: string): Promise<void>;
    access(absolutePath: string): Promise<void>;
  };
  readonly bash: {
    exec(
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: unknown;
      },
    ): Promise<{ exitCode: number | null }>;
  };
  readonly ls: {
    exists(absolutePath: string): Promise<boolean>;
    stat(absolutePath: string): Promise<{ isDirectory: () => boolean }>;
    readdir(absolutePath: string): Promise<string[]>;
  };
  readonly find: {
    exists(absolutePath: string): Promise<boolean>;
    glob(
      pattern: string,
      cwd: string,
      options: { ignore: string[]; limit: number },
    ): Promise<string[]>;
  };
  readonly grep: {
    isDirectory(absolutePath: string): Promise<boolean>;
    /** Not in pi's `GrepOperations`: the runner's grep `execute()` calls it. */
    search(params: CallParams<"tool.grep">): Promise<ToolResults["tool.grep"]>;
  };
}

export class ToolRpcClient {
  readonly #boxes: Pick<BoxConnections, "listen" | "sendRpc">;
  readonly #deadlineMs: <M extends ToolMethod>(method: M, params: ToolParams[M]) => number;
  readonly #log: (line: string) => void;
  readonly #pending = new Map<string, Pending>();
  readonly #unlisten: () => void;

  constructor(options: ToolRpcClientOptions) {
    this.#boxes = options.boxes;
    this.#deadlineMs = options.deadlineMs ?? toolDeadlineMs;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#unlisten = this.#boxes.listen({
      connected: (boxId, bootId) => this.#onConnected(boxId, bootId),
      dead: (boxId, bootId, death) => this.#onDead(boxId, bootId, death.misses * death.intervalMs),
      rpcResult: (_boxId, frame) => this.#onResult(frame),
    });
  }

  /** Calls in flight. */
  get pending(): number {
    return this.#pending.size;
  }

  close(): void {
    this.#unlisten();
  }

  /** One tool call. Rejects with a classified `HearthError`, or `aborted` on abort. */
  call<M extends ToolMethod>(
    boxId: BoxId,
    callId: string,
    method: M,
    params: CallParams<M>,
    options: CallOptions = {},
  ): Promise<ToolResults[M]> {
    const full = { ...params, callId } as ToolParams[M];
    if (options.signal?.aborted) return Promise.reject(new Error("aborted"));
    const id = `tool_${randomUUID()}`;
    const span = options.trace?.rpc(method, id);
    const frame: RpcFrame = {
      type: "rpc",
      id,
      method,
      params: full as never,
      ...(span?.traceparent === undefined ? {} : { traceparent: span.traceparent }),
    };
    const result = this.#send(boxId, callId, method, full, id, frame, options);
    if (span !== undefined) {
      result.then(
        (value) => {
          const exec = method === "tool.exec" ? (value as ToolResults["tool.exec"]) : undefined;
          span.end(
            exec === undefined
              ? { ok: true }
              : {
                  ok: exec.outcome === "exited",
                  ...(exec.outcome === "exited" ? {} : { code: exec.outcome }),
                  exitCode: exec.exitCode,
                },
          );
        },
        (error: unknown) =>
          span.end({
            ok: false,
            code: error instanceof HearthError ? error.code : String((error as Error)?.message),
          }),
      );
    }
    return result;
  }

  #send<M extends ToolMethod>(
    boxId: BoxId,
    callId: string,
    method: M,
    full: ToolParams[M],
    id: string,
    frame: RpcFrame,
    options: CallOptions,
  ): Promise<ToolResults[M]> {
    const bootId = this.#boxes.sendRpc(boxId, frame);
    if (bootId === undefined) {
      // Nothing was sent, so retrying is safe for any method.
      return Promise.reject(
        new HearthError(`Box ${boxId} is not connected`, {
          owner: "box",
          disposition: "retry",
          code: "box.not-connected",
        }),
      );
    }
    const deadlineMs = this.#deadlineMs(method, full);
    return new Promise<ToolResults[M]>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        if (method === "tool.exec") this.#cancel(boxId, callId, id);
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        if (method === "tool.exec") this.#cancel(boxId, callId, id);
        const mutating = MUTATING_TOOL_METHODS.has(method);
        reject(
          toolError(
            method,
            "tool.deadline",
            `Box ${boxId} did not answer ${method} within ${deadlineMs} ms` +
              (mutating ? "; its outcome is unknown and it was not retried" : ""),
          ),
        );
      }, deadlineMs);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        boxId,
        bootId,
        method,
        frame,
        settle: (outcome) => {
          cleanup();
          if (outcome instanceof HearthError) return reject(outcome);
          if (!outcome.ok) {
            return reject(
              toolError(method, outcome.error.code, `${method}: ${outcome.error.message}`),
            );
          }
          const decoded = decodeToolResult(method, outcome.result);
          if (!decoded.ok) {
            return reject(
              toolError(method, "tool.internal", `${method}: bad result: ${decoded.message}`),
            );
          }
          resolve(decoded.value);
        },
      });
    });
  }

  /** pi-shaped operations for one tool call of one box. */
  operations(boxId: BoxId, callId: string, trace?: RpcTrace): BoxToolOperations {
    const call = <M extends ToolMethod>(method: M, params: CallParams<M>, signal?: AbortSignal) =>
      this.call(boxId, callId, method, params, {
        ...(signal === undefined ? {} : { signal }),
        ...(trace === undefined ? {} : { trace }),
      });
    const readFile = async (path: string) =>
      Buffer.from((await call("tool.readFile", { path })).data, "base64");
    const writeFile = async (path: string, content: string) => {
      await call("tool.writeFile", { path, content });
    };
    const exists = async (path: string) => (await call("tool.exists", { path })).exists;
    return {
      read: {
        readFile,
        access: async (path) => {
          await call("tool.access", { path, write: false });
        },
        detectImageMimeType: async (path) => (await call("tool.imageMimeType", { path })).mimeType,
      },
      write: {
        writeFile,
        mkdir: async (path) => {
          await call("tool.mkdir", { path });
        },
      },
      edit: {
        readFile,
        writeFile,
        access: async (path) => {
          await call("tool.access", { path, write: true });
        },
      },
      bash: {
        // `env` is pi's (the hub's) environment and is dropped here on purpose.
        exec: async (command, cwd, { onData, signal, timeout }) => {
          const timeoutMs =
            timeout !== undefined && timeout > 0
              ? Math.min(Math.ceil(timeout * 1000), MAX_EXEC_TIMEOUT_MS)
              : DEFAULT_EXEC_TIMEOUT_MS;
          const result = await call("tool.exec", { command, cwd, timeoutMs }, signal);
          if (result.outcome === "cancelled") throw new Error("aborted");
          if (result.outcome === "timed-out") throw new Error(`timeout:${timeoutMs / 1000}`);
          if (result.output.length > 0) onData(Buffer.from(result.output, "utf8"));
          return { exitCode: result.exitCode };
        },
      },
      ls: {
        exists,
        stat: async (path) => {
          const { isDirectory } = await call("tool.stat", { path });
          return { isDirectory: () => isDirectory };
        },
        readdir: async (path) => [...(await call("tool.readdir", { path })).entries],
      },
      find: {
        exists,
        glob: async (pattern, cwd, { ignore, limit }) => [
          ...(await call("tool.glob", { pattern, cwd, ignore, limit })).paths,
        ],
      },
      grep: {
        isDirectory: async (path) => (await call("tool.stat", { path })).isDirectory,
        search: (params) => call("tool.grep", params),
      },
    };
  }

  #cancel(boxId: BoxId, callId: string, target: string): void {
    const sent = this.#boxes.sendRpc(boxId, {
      type: "rpc",
      id: `tool_${randomUUID()}`,
      method: "tool.cancel",
      params: { callId, target },
    });
    if (sent === undefined) this.#log(`tool rpc: could not cancel ${target}: box ${boxId} is gone`);
  }

  #onResult(frame: RpcResultFrame): boolean {
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return frame.id.startsWith("tool_");
    pending.settle(frame);
    return true;
  }

  /**
   * The hub's heartbeat declared the box's connection dead (decision 0028).
   * Unlike a plain close, nothing says the box will come back soon, or at all,
   * so the calls sent on it fail now with `tool.outcome-unknown` instead of
   * waiting out their deadlines: a mutating call gives up (it may have run),
   * a read-only one may be retried (`classifyToolError`). None is re-sent.
   */
  #onDead(boxId: BoxId, bootId: string | undefined, silentMs: number): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.boxId !== boxId || pending.bootId !== bootId) continue;
      pending.settle(
        toolError(
          pending.method,
          "tool.outcome-unknown",
          `Box ${boxId}'s connection was declared dead (no frame for ${silentMs} ms) during ` +
            `${pending.method}; its outcome is unknown and it was not re-sent`,
        ),
      );
    }
  }

  #onConnected(boxId: BoxId, bootId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.boxId !== boxId) continue;
      if (pending.bootId === bootId) {
        // Same boot: the box still has the call or its answer; ask again.
        this.#boxes.sendRpc(boxId, pending.frame);
        continue;
      }
      pending.settle(
        toolError(
          pending.method,
          "tool.outcome-unknown",
          `Box ${boxId} restarted (boot ${pending.bootId} → ${bootId}) during ${pending.method}; ` +
            "its outcome is unknown and it was not re-run",
        ),
      );
    }
  }
}
