/**
 * Runs one child process for a tool call: a command for `tool.exec`, `rg` for
 * `tool.grep`.
 *
 * The child leads a process group of its own (`detached`), so a timeout or a
 * cancel kills the whole tree with one `SIGKILL` to the group, including
 * children that ignore `SIGTERM` or hold the output pipe open. A child that
 * leaves the group (`setsid`, a daemon) is found by the per-run marker in its
 * environment (`HEARTH_EXEC=<random>`, read from `/proc/<pid>/environ`) and
 * killed too. A process that deliberately starts over with an environment
 * without the marker can outlive the call; it dies with the box, which is
 * the sandbox (decision 0011). Output from
 * stdout and stderr is merged in arrival order and capped: the tail is kept,
 * and when a spill path is given the whole output (up to a cap) goes to that
 * file so the model can read it from the box.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, readdirSync, readFileSync, type WriteStream } from "node:fs";
import { constants } from "node:os";
import type { ExecOutcome } from "@hearth/protocol";

/** After the main process exits, how long to wait for its pipes to close. */
export const PIPE_DRAIN_MS = 200;
/** The environment variable that marks every process of one run. */
export const EXEC_MARKER_VAR = "HEARTH_EXEC";
/** Rounds of the marker sweep, so a process forked during one round is caught in the next. */
const SWEEP_ROUNDS = 5;

export interface RunOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The complete environment of the child. Nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Bytes of output to keep (the tail). */
  readonly outputCap: number;
  /**
   * Where to write the whole output once it exceeds `outputCap`, and its own
   * cap. `open` creates the file and returns its descriptor; when it throws,
   * the output is not spilled.
   */
  readonly spill?: { readonly path: string; readonly cap: number; readonly open: () => number };
}

export interface RunResult {
  readonly outcome: ExecOutcome;
  /** Exit code, or 128 + signal number when a signal ended it; null when we killed it. */
  readonly exitCode: number | null;
  readonly output: Buffer;
  readonly truncatedBytes: number;
  readonly spillPath: string | null;
}

/** Kills the child's whole process group. Safe to call when it is gone. */
export function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

/**
 * Pids of the processes whose environment carries `marker`
 * (`HEARTH_EXEC=<value>`), read from `/proc`. Empty where there is no `/proc`.
 * A process whose environment cannot be read (another user, gone) is skipped.
 */
export function markedPids(marker: string): number[] {
  const needle = Buffer.from(`\u0000${marker}\u0000`);
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const environ = Buffer.concat([Buffer.from([0]), readFileSync(`/proc/${entry}/environ`)]);
      if (environ.includes(needle)) found.push(pid);
    } catch {
      // Gone, or not ours to read.
    }
  }
  return found;
}

/** Kills every process that carries `marker`, in a few rounds to catch forks. */
export function killMarked(marker: string): void {
  for (let round = 0; round < SWEEP_ROUNDS; round += 1) {
    const pids = markedPids(marker);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

export function runProcess(options: RunOptions): Promise<RunResult> {
  const [file, ...args] = options.argv;
  if (file === undefined) throw new Error("empty argv");
  const tag = randomUUID();
  const marker = `${EXEC_MARKER_VAR}=${tag}`;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: { ...options.env, [EXEC_MARKER_VAR]: tag },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let chunks: Buffer[] = [];
    let kept = 0;
    let total = 0;
    let spill: WriteStream | undefined;
    let spillFailed = false;
    let spilled = 0;
    let stopped: ExecOutcome | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;

    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (options.spill !== undefined) {
        if (spill === undefined && !spillFailed && total > options.outputCap) {
          try {
            spill = createWriteStream("", { fd: options.spill.open() });
            spill.on("error", () => {});
            for (const earlier of chunks) {
              spill.write(earlier);
              spilled += earlier.length;
            }
          } catch {
            // No spill file (for example a symlinked spill directory); the tail still comes back.
            spillFailed = true;
          }
        }
        if (spill !== undefined && spilled < options.spill.cap) {
          const part = chunk.subarray(0, options.spill.cap - spilled);
          spill.write(part);
          spilled += part.length;
        }
      }
      chunks.push(chunk);
      kept += chunk.length;
      if (kept > options.outputCap * 2) {
        const tail = Buffer.concat(chunks).subarray(kept - options.outputCap);
        chunks = [tail];
        kept = tail.length;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const stop = (outcome: ExecOutcome) => {
      if (exit !== undefined || stopped !== undefined) return;
      stopped = outcome;
      killGroup(child);
      killMarked(marker);
    };
    const timer = setTimeout(() => stop("timed-out"), options.timeoutMs);
    const onAbort = () => stop("cancelled");
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });

    const finish = async () => {
      if (finished || exit === undefined) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      options.signal.removeEventListener("abort", onAbort);
      // A background child may hold the pipes open; stop reading them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (spill !== undefined) {
        const stream = spill;
        await new Promise<void>((done) => stream.end(done));
      }
      const all = Buffer.concat(chunks);
      const output =
        all.length > options.outputCap ? all.subarray(all.length - options.outputCap) : all;
      const outcome = stopped ?? "exited";
      let exitCode: number | null = null;
      if (outcome === "exited") {
        exitCode =
          exit.code ?? 128 + (exit.signal === null ? 0 : (constants.signals[exit.signal] ?? 0));
      }
      resolve({
        outcome,
        exitCode,
        output,
        truncatedBytes: total - output.length,
        spillPath: spill === undefined ? null : (options.spill?.path ?? null),
      });
    };

    child.on("error", (error) => {
      if (exit !== undefined) return;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // The group is killed on timeout and cancel; leave it otherwise, so a
      // daemon the command started keeps running, but stop waiting on it.
      drainTimer = setTimeout(() => void finish(), PIPE_DRAIN_MS);
    });
    child.on("close", () => void finish());
  });
}
