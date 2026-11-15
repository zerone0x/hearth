/**
 * A fake box for the pi runner spike (issue #40).
 *
 * It stands in for box-agent at the far end of the future tool RPC (#41): every
 * method takes pi's tool call id, is recorded in `calls`, and works on an
 * in-memory file system under /workspace. Nothing here touches the hub's file
 * system or spawns a process, so a test that sees a result came from this class
 * knows the call was routed and did not run locally.
 */
import { posix } from "node:path";

/** Method names a tool RPC needs, as seen from the spike. Not a protocol proposal. */
export type BoxMethod =
  | "fs.read"
  | "fs.write"
  | "fs.mkdir"
  | "fs.stat"
  | "fs.list"
  | "find"
  | "grep"
  | "exec";

export interface BoxCall {
  toolCallId: string;
  method: BoxMethod;
  params: Record<string, unknown>;
  startedAt: number;
  endedAt?: number;
  outcome?: "ok" | "error" | "aborted";
}

export interface ExecContext {
  command: string;
  cwd: string;
  /** Streams output back to the runner, like BashOperations.exec's onData. */
  emit: (text: string) => void;
  signal: AbortSignal | undefined;
}

/** Runs a command in the fake box; returns its exit code (null: killed without one). */
export type ExecHandler = (ctx: ExecContext) => Promise<number | null>;

export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  limit?: number;
}

export class BoxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BoxError";
  }
}

const WORKSPACE = "/workspace";

function normalize(path: string): string {
  return posix.resolve(WORKSPACE, path);
}

export class FakeBox {
  readonly files = new Map<string, string>();
  readonly calls: BoxCall[] = [];
  /** Environments that reached the box through exec; Hearth forwards none. */
  readonly execEnvs: Array<Record<string, string> | undefined> = [];
  /** Methods that throw on their next call, to test backend errors. */
  readonly failNext = new Map<BoxMethod, Error>();
  /** Delay applied to every call of a method, to make concurrency visible. */
  readonly delayMs = new Map<BoxMethod, number>();
  execHandler: ExecHandler = async ({ command, emit }) => {
    emit(`box ran: ${command}\n`);
    return 0;
  };

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) this.files.set(normalize(path), content);
  }

  /** Wraps one RPC: records it, applies the configured delay and failure. */
  private async call<T>(
    toolCallId: string,
    method: BoxMethod,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    run: () => Promise<T> | T,
  ): Promise<T> {
    const record: BoxCall = { toolCallId, method, params, startedAt: performance.now() };
    this.calls.push(record);
    try {
      const delay = this.delayMs.get(method) ?? 0;
      if (delay > 0) await sleep(delay, signal);
      const failure = this.failNext.get(method);
      if (failure) {
        this.failNext.delete(method);
        throw failure;
      }
      const result = await run();
      record.outcome = "ok";
      return result;
    } catch (error) {
      record.outcome = signal?.aborted ? "aborted" : "error";
      throw error;
    } finally {
      record.endedAt = performance.now();
    }
  }

  private isDir(path: string): boolean {
    if (path === "/" || path === WORKSPACE) return true;
    const prefix = `${path}/`;
    for (const file of this.files.keys()) if (file.startsWith(prefix)) return true;
    return false;
  }

  readFile(toolCallId: string, path: string, signal?: AbortSignal): Promise<Buffer> {
    return this.call(toolCallId, "fs.read", { path }, signal, () => {
      const content = this.files.get(normalize(path));
      if (content === undefined) throw new BoxError("ENOENT", `No such file in box: ${path}`);
      return Buffer.from(content);
    });
  }

  writeFile(toolCallId: string, path: string, content: string): Promise<void> {
    return this.call(toolCallId, "fs.write", { path, bytes: content.length }, undefined, () => {
      this.files.set(normalize(path), content);
    });
  }

  mkdir(toolCallId: string, path: string): Promise<void> {
    // Directories are implicit in the fake file system.
    return this.call(toolCallId, "fs.mkdir", { path }, undefined, () => undefined);
  }

  stat(toolCallId: string, path: string): Promise<{ exists: boolean; isDirectory: boolean }> {
    return this.call(toolCallId, "fs.stat", { path }, undefined, () => {
      const p = normalize(path);
      const isDirectory = this.isDir(p);
      return { exists: isDirectory || this.files.has(p), isDirectory };
    });
  }

  list(toolCallId: string, path: string): Promise<string[]> {
    return this.call(toolCallId, "fs.list", { path }, undefined, () => {
      const prefix = `${normalize(path).replace(/\/$/, "")}/`;
      const names = new Set<string>();
      for (const file of this.files.keys()) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0] ?? "");
      }
      names.delete("");
      return [...names].sort();
    });
  }

  find(toolCallId: string, pattern: string, cwd: string, limit: number): Promise<string[]> {
    return this.call(toolCallId, "find", { pattern, cwd, limit }, undefined, () => {
      const root = `${normalize(cwd).replace(/\/$/, "")}/`;
      const out: string[] = [];
      for (const file of [...this.files.keys()].sort()) {
        if (!file.startsWith(root)) continue;
        const rel = file.slice(root.length);
        const target = pattern.includes("/") ? rel : posix.basename(rel);
        if (posix.matchesGlob(target, pattern)) out.push(file);
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  grep(toolCallId: string, params: GrepParams, signal?: AbortSignal): Promise<string> {
    return this.call(toolCallId, "grep", { ...params }, signal, () => {
      const root = normalize(params.path ?? ".");
      const flags = params.ignoreCase ? "i" : "";
      const source = params.literal
        ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : params.pattern;
      const regex = new RegExp(source, flags);
      const limit = params.limit ?? 100;
      const lines: string[] = [];
      for (const [file, content] of [...this.files.entries()].sort()) {
        if (file !== root && !file.startsWith(`${root}/`)) continue;
        const rel = file === root ? posix.basename(file) : file.slice(root.length + 1);
        if (params.glob && !posix.matchesGlob(posix.basename(rel), params.glob)) continue;
        content.split("\n").forEach((line, i) => {
          if (lines.length < limit && regex.test(line)) lines.push(`${rel}:${i + 1}: ${line}`);
        });
      }
      return lines.length > 0 ? lines.join("\n") : "No matches found";
    });
  }

  exec(
    toolCallId: string,
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal | undefined;
      env?: Record<string, string> | undefined;
    },
  ): Promise<{ exitCode: number | null }> {
    this.execEnvs.push(options.env);
    return this.call(toolCallId, "exec", { command, cwd }, options.signal, async () => {
      const exitCode = await this.execHandler({
        command,
        cwd,
        emit: (text) => options.onData(Buffer.from(text)),
        signal: options.signal,
      });
      return { exitCode };
    });
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
