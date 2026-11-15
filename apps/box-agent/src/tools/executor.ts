/**
 * The box's tool executor, "the hands" (PRD §8.2.1, decisions 0009 and 0011).
 *
 * It answers the hub's tool `rpc` frames: file reads and writes, listing,
 * glob, grep (as `rg`) and commands, all confined to the workspace. A call is
 * keyed by its `rpc` id and runs at most once per boot: a re-sent id that is
 * still running is answered when it ends, one that ended gets the same answer
 * again, and one whose answer was evicted gets `tool.result-expired`, never a
 * second run.
 */

import { access, constants, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import {
  decodeToolParams,
  EXEC_SPILL_DIR,
  FILE_TIMEOUT_MS,
  isToolMethod,
  type JsonValue,
  MAX_CONCURRENT_TOOL_CALLS,
  MAX_EXEC_SPILL_BYTES,
  MAX_TOOL_FILE_BYTES,
  MAX_TOOL_LIST_ENTRIES,
  MAX_TOOL_OUTPUT_BYTES,
  type RpcFrame,
  type RpcResultFrame,
  SEARCH_TIMEOUT_MS,
  type ToolMethod,
  type ToolParams,
  type ToolResults,
  truncationMarker,
} from "@hearth/protocol";
import { ToolCallError, toToolError } from "./errors";
import { openPlainFile, Workspace } from "./paths";
import { runProcess } from "./process";

/** Box-defined variables a command gets; nothing comes from the hub or the agent's own env. */
export const DEFAULT_EXEC_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/hearth",
  LANG: "C.UTF-8",
  TERM: "dumb",
};

/** Bytes of finished answers kept for re-sends; older ones are evicted. */
export const RESULT_CACHE_BYTES = 8 * 1024 * 1024;
/** Ids remembered after their answer was evicted, so they are never run again. */
export const EXPIRED_IDS_LIMIT = 100_000;

export interface ToolExecutorOptions {
  /** The workspace root, `/workspace` in the box. */
  readonly root: string;
  /** The complete environment of commands. Defaults to `DEFAULT_EXEC_ENV`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Shell that runs `tool.exec` commands as `<shell> -c <command>`. */
  readonly shell?: string;
  /** The ripgrep binary. */
  readonly rg?: string;
  readonly maxConcurrent?: number;
  readonly resultCacheBytes?: number;
  readonly searchTimeoutMs?: number;
  /** Box-side budget of each file method. Defaults to `FILE_TIMEOUT_MS`. */
  readonly fileTimeoutMs?: number;
  /** Sends a frame to the hub if connected; a lost answer is re-sent on the hub's re-send. */
  readonly send: (frame: RpcResultFrame) => void;
  readonly log?: (line: string) => void;
}

type CallState =
  | { readonly kind: "running"; readonly controller: AbortController }
  | { readonly kind: "done"; readonly frame: RpcResultFrame; readonly bytes: number };

const IMAGE_SIGNATURES: readonly {
  readonly mime: string;
  readonly test: (b: Buffer) => boolean;
}[] = [
  {
    mime: "image/png",
    test: (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  { mime: "image/jpeg", test: (b) => b.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) },
  { mime: "image/gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  {
    mime: "image/webp",
    test: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

function spillName(callId: string, rpcId: string): string {
  return `${`${callId}-${rpcId}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200)}.log`;
}

export class ToolExecutor {
  readonly workspace: Workspace;
  readonly #options: ToolExecutorOptions;
  readonly #env: Readonly<Record<string, string>>;
  readonly #calls = new Map<string, CallState>();
  readonly #expired = new Set<string>();
  #running = 0;
  #cachedBytes = 0;

  constructor(options: ToolExecutorOptions) {
    this.#options = options;
    this.workspace = new Workspace(options.root);
    this.#env = options.env ?? DEFAULT_EXEC_ENV;
  }

  /** Tool calls running now. */
  get running(): number {
    return this.#running;
  }

  /** True for the methods this executor answers. */
  handles(method: string): boolean {
    return isToolMethod(method);
  }

  /** Handle one tool `rpc`. The answer goes out through `send`, now or later. */
  handle(frame: RpcFrame): void {
    if (!isToolMethod(frame.method)) {
      this.#reply(frame.id, new ToolCallError("tool.bad-params", `no method ${frame.method}`));
      return;
    }
    const method = frame.method;
    const known = this.#calls.get(frame.id);
    if (known !== undefined) {
      // A re-send: answered when it ends, or answered again now.
      if (known.kind === "done") this.#options.send(known.frame);
      return;
    }
    if (this.#expired.has(frame.id)) {
      this.#reply(
        frame.id,
        new ToolCallError(
          "tool.result-expired",
          `call ${frame.id} already ran in this boot and its answer is no longer kept`,
        ),
      );
      return;
    }
    const decoded = decodeToolParams(method, frame.params);
    if (!decoded.ok) {
      this.#reply(frame.id, new ToolCallError("tool.bad-params", decoded.message));
      return;
    }
    if (method === "tool.cancel") {
      const target = this.#calls.get((decoded.value as ToolParams["tool.cancel"]).target);
      if (target?.kind === "running") target.controller.abort();
      this.#options.send({
        type: "rpc.result",
        id: frame.id,
        ok: true,
        result: { found: target?.kind === "running" },
      });
      return;
    }
    const max = this.#options.maxConcurrent ?? MAX_CONCURRENT_TOOL_CALLS;
    if (this.#running >= max) {
      // Not recorded: the call did not run, so a later re-send may.
      this.#reply(
        frame.id,
        new ToolCallError("tool.busy", `${max} tool calls are already running`),
      );
      return;
    }
    const controller = new AbortController();
    this.#calls.set(frame.id, { kind: "running", controller });
    this.#running += 1;
    void this.#run(method, decoded.value, frame.id, controller.signal).then(
      (result) => this.#finish(frame.id, { type: "rpc.result", id: frame.id, ok: true, result }),
      (error) => this.#finish(frame.id, this.#errorFrame(frame.id, toToolError(error))),
    );
  }

  /** Cancel every running call (agent shutdown). */
  abortAll(): void {
    for (const call of this.#calls.values()) if (call.kind === "running") call.controller.abort();
  }

  #errorFrame(id: string, error: ToolCallError): RpcResultFrame {
    return {
      type: "rpc.result",
      id,
      ok: false,
      error: { code: error.code, message: error.message },
    };
  }

  #reply(id: string, error: ToolCallError): void {
    this.#options.send(this.#errorFrame(id, error));
  }

  #finish(id: string, frame: RpcResultFrame): void {
    this.#running -= 1;
    const bytes = JSON.stringify(frame).length;
    this.#calls.set(id, { kind: "done", frame, bytes });
    this.#cachedBytes += bytes;
    const limit = this.#options.resultCacheBytes ?? RESULT_CACHE_BYTES;
    for (const [oldId, state] of this.#calls) {
      if (this.#cachedBytes <= limit) break;
      if (state.kind !== "done" || oldId === id) continue;
      this.#calls.delete(oldId);
      this.#cachedBytes -= state.bytes;
      this.#expired.add(oldId);
    }
    while (this.#expired.size > EXPIRED_IDS_LIMIT) {
      const oldest = this.#expired.values().next().value;
      if (oldest === undefined) break;
      this.#expired.delete(oldest);
    }
    this.#options.send(frame);
  }

  async #run(
    method: Exclude<ToolMethod, "tool.cancel">,
    params: ToolParams[ToolMethod],
    rpcId: string,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    switch (method) {
      case "tool.glob":
        return await this.glob(params as ToolParams["tool.glob"], signal);
      case "tool.grep":
        return await this.grep(params as ToolParams["tool.grep"], signal);
      case "tool.exec":
        return await this.exec(params as ToolParams["tool.exec"], rpcId, signal);
      default:
        return await this.#withFileBudget(method, signal, () => this.#file(method, params));
    }
  }

  /**
   * Runs a file method under its own budget (`FILE_TIMEOUT_MS`) and the call's
   * cancel. An I/O the kernel keeps blocked cannot be interrupted, but the call
   * is answered and its slot freed.
   */
  async #withFileBudget<T>(method: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const budget = this.#options.fileTimeoutMs ?? FILE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolCallError("tool.deadline", `${method} ran longer than ${budget} ms`)),
        budget,
      );
      onAbort = () => reject(new ToolCallError("tool.internal", "aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([run(), stopped]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  async #file(
    method: Exclude<ToolMethod, "tool.cancel" | "tool.glob" | "tool.grep" | "tool.exec">,
    params: ToolParams[ToolMethod],
  ): Promise<JsonValue> {
    switch (method) {
      case "tool.readFile":
        return await this.readFile(params as ToolParams["tool.readFile"]);
      case "tool.access":
        return await this.access(params as ToolParams["tool.access"]);
      case "tool.imageMimeType":
        return await this.imageMimeType(params as ToolParams["tool.imageMimeType"]);
      case "tool.writeFile":
        return await this.writeFile(params as ToolParams["tool.writeFile"]);
      case "tool.mkdir":
        return await this.mkdir(params as ToolParams["tool.mkdir"]);
      case "tool.exists":
        return await this.exists(params as ToolParams["tool.exists"]);
      case "tool.stat":
        return await this.stat(params as ToolParams["tool.stat"]);
      case "tool.readdir":
        return await this.readdir(params as ToolParams["tool.readdir"]);
    }
  }

  /**
   * Opens a file for reading without blocking (a FIFO with no writer would
   * hang a plain open) and refuses anything but a regular file.
   */
  async #openRegular(path: string, real: string) {
    const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (info.isDirectory())
        throw new ToolCallError("tool.is-a-directory", `${path} is a directory`);
      if (!info.isFile()) {
        throw new ToolCallError("tool.not-regular-file", `${path} is not a regular file`);
      }
      return { handle, size: info.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  // -- methods ------------------------------------------------------------

  async readFile(p: ToolParams["tool.readFile"]): Promise<ToolResults["tool.readFile"]> {
    const { real } = await this.workspace.resolve(p.path);
    const { handle, size } = await this.#openRegular(p.path, real);
    try {
      if (size > MAX_TOOL_FILE_BYTES) {
        throw new ToolCallError(
          "tool.too-large",
          `${p.path} has ${size} bytes; tool reads are capped at ${MAX_TOOL_FILE_BYTES}`,
        );
      }
      const data = await handle.readFile();
      if (data.length > MAX_TOOL_FILE_BYTES) {
        throw new ToolCallError(
          "tool.too-large",
          `${p.path} grew past ${MAX_TOOL_FILE_BYTES} bytes`,
        );
      }
      return { data: data.toString("base64"), size: data.length };
    } finally {
      await handle.close();
    }
  }

  async access(p: ToolParams["tool.access"]): Promise<ToolResults["tool.access"]> {
    const { real } = await this.workspace.resolve(p.path);
    await access(real, p.write ? constants.R_OK | constants.W_OK : constants.R_OK);
    return {};
  }

  async imageMimeType(
    p: ToolParams["tool.imageMimeType"],
  ): Promise<ToolResults["tool.imageMimeType"]> {
    const { real } = await this.workspace.resolve(p.path);
    const { handle } = await this.#openRegular(p.path, real);
    try {
      const head = Buffer.alloc(16);
      const { bytesRead } = await handle.read(head, 0, 16, 0);
      const bytes = head.subarray(0, bytesRead);
      return { mimeType: IMAGE_SIGNATURES.find((s) => s.test(bytes))?.mime ?? null };
    } finally {
      await handle.close();
    }
  }

  async writeFile(p: ToolParams["tool.writeFile"]): Promise<ToolResults["tool.writeFile"]> {
    const bytes = Buffer.byteLength(p.content, "utf8");
    if (bytes > MAX_TOOL_FILE_BYTES) {
      throw new ToolCallError(
        "tool.too-large",
        `${bytes} bytes; tool writes are capped at ${MAX_TOOL_FILE_BYTES}`,
      );
    }
    const { real } = await this.workspace.resolve(p.path);
    // Non-blocking, so a FIFO without a reader fails (ENXIO) instead of hanging.
    const handle = await open(
      real,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK,
      0o666,
    );
    try {
      if (!(await handle.stat()).isFile()) {
        throw new ToolCallError("tool.not-regular-file", `${p.path} is not a regular file`);
      }
      await handle.truncate(0);
      await handle.writeFile(p.content, "utf8");
    } finally {
      await handle.close();
    }
    return { bytes };
  }

  async mkdir(p: ToolParams["tool.mkdir"]): Promise<ToolResults["tool.mkdir"]> {
    const { real } = await this.workspace.resolve(p.path);
    await mkdir(real, { recursive: true });
    return {};
  }

  async exists(p: ToolParams["tool.exists"]): Promise<ToolResults["tool.exists"]> {
    const { real } = await this.workspace.resolve(p.path);
    try {
      await stat(real);
      return { exists: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      throw error;
    }
  }

  async stat(p: ToolParams["tool.stat"]): Promise<ToolResults["tool.stat"]> {
    const { real } = await this.workspace.resolve(p.path);
    const info = await stat(real);
    return { isDirectory: info.isDirectory(), isFile: info.isFile(), size: info.size };
  }

  async readdir(p: ToolParams["tool.readdir"]): Promise<ToolResults["tool.readdir"]> {
    const { real } = await this.workspace.resolve(p.path);
    const all = await readdir(real);
    return {
      entries: all.slice(0, MAX_TOOL_LIST_ENTRIES),
      omitted: Math.max(0, all.length - MAX_TOOL_LIST_ENTRIES),
    };
  }

  async glob(p: ToolParams["tool.glob"], signal: AbortSignal): Promise<ToolResults["tool.glob"]> {
    if (posix.isAbsolute(p.pattern) || p.pattern.split("/").includes("..")) {
      throw new ToolCallError(
        "tool.path-escape",
        `glob pattern ${JSON.stringify(p.pattern)} must be relative and without ..`,
      );
    }
    const { real, lexical } = await this.workspace.resolve(p.cwd);
    // The literal leading segments are walked as named, symlinks included,
    // so they must stay inside (`etclink/pass*` with etclink -> /etc).
    const segments = p.pattern.split("/");
    const literal: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      if (/[*?[\]{}!\\]/.test(segment)) break;
      literal.push(segment);
    }
    if (literal.length > 0) await this.workspace.resolve(posix.join(lexical, ...literal));
    const realRoot = await this.workspace.realRoot();
    const ignore = p.ignore.map((pattern) => new Bun.Glob(pattern));
    const deadline = Date.now() + (this.#options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS);
    const paths: string[] = [];
    let limitReached = false;
    for await (const path of new Bun.Glob(p.pattern).scan({
      cwd: real,
      dot: true,
      followSymlinks: false,
      onlyFiles: true,
    })) {
      if (signal.aborted) throw new ToolCallError("tool.internal", "aborted");
      if (Date.now() > deadline) {
        throw new ToolCallError(
          "tool.deadline",
          `glob ran longer than ${this.#options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS} ms`,
        );
      }
      if (ignore.some((g) => g.match(path))) continue;
      // Any match reached through a symlink out of the workspace is dropped.
      if (!(await this.#insideRealRoot(posix.join(real, path), realRoot))) continue;
      if (paths.length >= p.limit) {
        limitReached = true;
        break;
      }
      paths.push(path);
    }
    return { paths, limitReached };
  }

  async #insideRealRoot(path: string, realRoot: string): Promise<boolean> {
    try {
      const resolved = await realpath(path);
      return resolved === realRoot || resolved.startsWith(`${realRoot}/`);
    } catch {
      return false;
    }
  }

  async grep(p: ToolParams["tool.grep"], signal: AbortSignal): Promise<ToolResults["tool.grep"]> {
    const { real } = await this.workspace.resolve(p.path);
    const realRoot = await this.workspace.realRoot();
    const argv = [
      this.#options.rg ?? "rg",
      "--line-number",
      "--with-filename",
      "--no-heading",
      "--color=never",
      "--hidden",
      "--no-follow",
      `--max-count=${p.limit + 1}`,
      ...(p.ignoreCase ? ["--ignore-case"] : []),
      ...(p.literal ? ["--fixed-strings"] : []),
      ...(p.context > 0 ? [`--context=${p.context}`] : []),
      ...(p.glob === undefined ? [] : ["--glob", p.glob]),
      "--regexp",
      p.pattern,
      "--",
      posix.relative(realRoot, real) || ".",
    ];
    const run = await runProcess({
      argv,
      cwd: realRoot,
      env: this.#env,
      timeoutMs: this.#options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
      signal,
      outputCap: MAX_TOOL_OUTPUT_BYTES,
    });
    if (run.outcome === "timed-out") {
      throw new ToolCallError("tool.deadline", "rg ran longer than its search budget");
    }
    const lines = run.output.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const kept: string[] = [];
    let matches = 0;
    let limitReached = false;
    for (const line of lines) {
      if (/^.+?:\d+:/.test(line)) {
        if (matches >= p.limit) {
          limitReached = true;
          break;
        }
        matches += 1;
      }
      kept.push(line);
    }
    const marker = run.truncatedBytes > 0 ? truncationMarker(run.truncatedBytes) : "";
    return {
      output: marker + kept.join("\n"),
      matches,
      limitReached,
      truncatedBytes: run.truncatedBytes,
    };
  }

  async exec(
    p: ToolParams["tool.exec"],
    rpcId: string,
    signal: AbortSignal,
  ): Promise<ToolResults["tool.exec"]> {
    const { real, lexical } = await this.workspace.resolve(p.cwd);
    const info = await stat(real);
    if (!info.isDirectory())
      throw new ToolCallError("tool.not-a-directory", `${p.cwd} is not a directory`);
    const realRoot = await this.workspace.realRoot();
    const name = spillName(p.callId, rpcId);
    const spillRelative = posix.join(EXEC_SPILL_DIR, name);
    const run = await runProcess({
      argv: [this.#options.shell ?? "/bin/bash", "-c", p.command],
      cwd: real,
      env: { ...this.#env, PWD: lexical },
      timeoutMs: p.timeoutMs,
      signal,
      outputCap: MAX_TOOL_OUTPUT_BYTES,
      spill: {
        path: posix.join(realRoot, spillRelative),
        cap: MAX_EXEC_SPILL_BYTES,
        // Never through a symlinked `.hearth` or `exec`: no spill rather than a write outside.
        open: () => openPlainFile(realRoot, EXEC_SPILL_DIR.split("/"), name),
      },
    });
    const fullOutputPath =
      run.spillPath === null ? null : posix.join(this.workspace.root, spillRelative);
    const text = run.output.toString("utf8");
    return {
      outcome: run.outcome,
      exitCode: run.exitCode,
      output:
        run.truncatedBytes > 0
          ? truncationMarker(run.truncatedBytes, fullOutputPath ?? undefined) + text
          : text,
      truncatedBytes: run.truncatedBytes,
      fullOutputPath,
    };
  }
}
