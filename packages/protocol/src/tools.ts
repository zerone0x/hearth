/**
 * Tool-execution RPC (protocol 1.1, decision 0011): the methods the hub-side
 * pi runner calls on the box, "the hands" (PRD §8.2.1, decision 0009).
 *
 * Tool calls are ordinary `rpc` / `rpc.result` frames; this module defines the
 * method names, their params and results, their limits and how their errors
 * are classified. Pure types and guards, no I/O.
 *
 * The methods map one to one onto pi's `*Operations` interfaces (pi 1.5.2,
 * `dist/core/tools/*.d.ts`); see the README table.
 */

import {
  BROWSER_METHODS,
  BROWSER_PARAMS,
  BROWSER_RESULTS,
  type BrowserParams,
  type BrowserResults,
  browserBudgetMs,
  isBrowserMethod,
  MUTATING_BROWSER_METHODS,
} from "./browser";
import { FieldError, Fields, isObj, MAX_ID_LENGTH } from "./fields";
import type { FailureDisposition, FailureOwner, JsonValue } from "./frames";
import type { ProtocolVersion } from "./version";

// ---------------------------------------------------------------------------
// Limits

/** Largest file `tool.readFile` returns and `tool.writeFile` accepts, in bytes. */
export const MAX_TOOL_FILE_BYTES = 1024 * 1024;
/** Most output bytes `tool.exec` and `tool.grep` return; the head is dropped, the tail kept. */
export const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
/** Most bytes of a command's full output the box keeps in its spill file. */
export const MAX_EXEC_SPILL_BYTES = 16 * 1024 * 1024;
/** Most entries `tool.readdir` and `tool.glob` return. */
export const MAX_TOOL_LIST_ENTRIES = 10_000;
/** Longest path or pattern, in characters. */
export const MAX_TOOL_PATH_LENGTH = 4096;
/** Longest command, in characters. */
export const MAX_EXEC_COMMAND_LENGTH = 256 * 1024;
/** Timeout of `tool.exec` when pi passes none. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
/** Longest timeout `tool.exec` accepts. */
export const MAX_EXEC_TIMEOUT_MS = 60 * 60_000;
/** Box-side budget of `tool.glob` and `tool.grep`; the search is stopped after it. */
export const SEARCH_TIMEOUT_MS = 30_000;
/** Added to the box-side budget to get the hub-side deadline (PRD §8.1, principle 3). */
export const TOOL_DEADLINE_GRACE_MS = 5_000;
/** Box-side budget of each file method (read, write, stat, …); the call fails with `tool.deadline` after it. */
export const FILE_TIMEOUT_MS = 25_000;
/** Hub-side deadline of the file methods: their box-side budget plus the grace. */
export const FS_DEADLINE_MS = FILE_TIMEOUT_MS + TOOL_DEADLINE_GRACE_MS;
/** Tool calls one box runs at once; more are refused with `tool.busy`. */
export const MAX_CONCURRENT_TOOL_CALLS = 16;

/**
 * Live output (protocol 1.4, decision 0036): most bytes of one command's
 * output the box streams while it runs. The rest is only in the result.
 */
export const MAX_LIVE_OUTPUT_BYTES = 64 * 1024;
/** Live output: the box sends at most one `stream.data` per this many ms per command. */
export const LIVE_OUTPUT_INTERVAL_MS = 100;
/** Live output: the box sends a chunk early once this many bytes wait. */
export const LIVE_OUTPUT_CHUNK_BYTES = 16 * 1024;
/**
 * Live output stream ids: even (the hub picks them, decision 0016) with the
 * top bit set, so they never meet the desktop bridge's ids, which stay below.
 */
export const LIVE_OUTPUT_STREAM_BASE = 2 ** 31;

/** True for a stream id in the live output range. */
export function isLiveOutputStreamId(id: number): boolean {
  return Number.isInteger(id) && id >= LIVE_OUTPUT_STREAM_BASE && id < 2 ** 32 && id % 2 === 0;
}

/**
 * Secret env of one command (protocol 1.6, decision 0041): most variables one
 * `tool.exec` carries, longest name, and longest value (the vault's own
 * `MAX_VAULT_FIELD_CHARS`).
 */
export const MAX_EXEC_ENV_VARS = 8;
export const MAX_EXEC_ENV_NAME_LENGTH = 64;
export const MAX_EXEC_ENV_VALUE_LENGTH = 16_384;

/** The shape of a variable name a command may get from the hub. */
export const EXEC_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Names that pass the pattern but would change how the shell, the dynamic
 * linker, an interpreter or box-agent itself behaves, or that the box sets.
 */
export const EXEC_ENV_DENIED_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "PWD",
  "OLDPWD",
  "USER",
  "LOGNAME",
  "SHELL",
  "SHELLOPTS",
  "BASHOPTS",
  "ENV",
  "IFS",
  "PS1",
  "PS2",
  "PS4",
  "PROMPT_COMMAND",
  "CDPATH",
  "GLOBIGNORE",
  "HISTFILE",
  "TERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "HOSTNAME",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "DISPLAY",
]);

/** Prefixes no secret variable may start with (`LD_PRELOAD`, `BASH_ENV`, `BASH_FUNC_x%%`, …). */
export const EXEC_ENV_DENIED_PREFIXES: readonly string[] = [
  "LD_",
  "DYLD_",
  "BASH_",
  "LC_",
  "GIT_",
  "XDG_",
  "HEARTH_",
];

/**
 * Why `name` may not carry a secret into a command, or undefined when it may.
 * The reason never quotes a value.
 */
export function execEnvNameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > MAX_EXEC_ENV_NAME_LENGTH) {
    return `must be 1 to ${MAX_EXEC_ENV_NAME_LENGTH} characters`;
  }
  if (!EXEC_ENV_NAME_PATTERN.test(name)) return "must match ^[A-Z][A-Z0-9_]*$";
  if (EXEC_ENV_DENIED_NAMES.has(name)) return "is reserved by the shell or the box";
  if (EXEC_ENV_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "starts with a reserved prefix";
  }
  return undefined;
}

/** The first protocol version whose box applies `tool.exec`'s `env` (an older one drops it). */
export const EXEC_ENV_MIN_VERSION: ProtocolVersion = { major: 1, minor: 6 };

/** True when a box speaking `version` runs a command with the `env` it is sent. */
export function supportsExecEnv(version: ProtocolVersion | undefined): boolean {
  return (
    version !== undefined &&
    version.major === EXEC_ENV_MIN_VERSION.major &&
    version.minor >= EXEC_ENV_MIN_VERSION.minor
  );
}

/** Prefix of the box-relative directory holding spilled command output. */
export const EXEC_SPILL_DIR = ".hearth/exec";

/** The marker put in front of output whose head was dropped. */
export function truncationMarker(omittedBytes: number, fullOutputPath?: string): string {
  const where = fullOutputPath === undefined ? "" : `; full output in the box at ${fullOutputPath}`;
  return `[hearth: ${omittedBytes} bytes of earlier output omitted${where}]\n`;
}

// ---------------------------------------------------------------------------
// Methods

/** Every method carries `callId`, pi's tool call id, for logs and audit. */
interface Base {
  readonly callId: string;
}

/** The browser methods (protocol 1.3, `browser.ts`) are tool methods too. */
export interface ToolParams extends BrowserParams {
  /** `ReadOperations.readFile` and `EditOperations.readFile`. */
  "tool.readFile": Base & { readonly path: string };
  /** `ReadOperations.access` (`write: false`) and `EditOperations.access` (`write: true`). */
  "tool.access": Base & { readonly path: string; readonly write: boolean };
  /** `ReadOperations.detectImageMimeType`. */
  "tool.imageMimeType": Base & { readonly path: string };
  /** `WriteOperations.writeFile` and `EditOperations.writeFile`. UTF-8 text. */
  "tool.writeFile": Base & { readonly path: string; readonly content: string };
  /** `WriteOperations.mkdir`, recursive. */
  "tool.mkdir": Base & { readonly path: string };
  /** `LsOperations.exists` and `FindOperations.exists`. */
  "tool.exists": Base & { readonly path: string };
  /** `LsOperations.stat` and `GrepOperations.isDirectory`. */
  "tool.stat": Base & { readonly path: string };
  /** `LsOperations.readdir`. */
  "tool.readdir": Base & { readonly path: string };
  /** `FindOperations.glob`. */
  "tool.glob": Base & {
    readonly pattern: string;
    readonly cwd: string;
    readonly ignore: readonly string[];
    readonly limit: number;
  };
  /** The grep tool's whole search, run as `rg` in the box (`GrepOperations` cannot express it). */
  "tool.grep": Base & {
    readonly pattern: string;
    readonly path: string;
    readonly glob?: string;
    readonly ignoreCase: boolean;
    readonly literal: boolean;
    readonly context: number;
    readonly limit: number;
  };
  /**
   * `BashOperations.exec`. The command runs with the box's own minimal
   * environment, never the hub's (PRD §8.2.1).
   */
  "tool.exec": Base & {
    readonly command: string;
    readonly cwd: string;
    readonly timeoutMs: number;
    /**
     * Since 1.4 (decision 0036): stream the command's output while it runs as
     * `stream.data` frames on this stream id (`isLiveOutputStreamId`), then a
     * `stream.close`, both before the `rpc.result`. Lossy and capped at
     * `MAX_LIVE_OUTPUT_BYTES`; the result stays the whole answer. A 1.3 box
     * drops the field and answers once, as before.
     */
    readonly outputStream?: number;
    /**
     * Since 1.6 (decision 0041): variables added to this one command's
     * environment, each holding a vault `box-env` token the hub resolved
     * (`execEnvNameProblem` names none of them). The box adds them under its
     * own variables, keeps them in no file and no log, writes no spill file
     * for the call, and replaces each value in the result. A 1.5 box drops
     * the field, so the hub sends it only to a 1.6 box (`supportsExecEnv`).
     */
    readonly env?: Readonly<Record<string, string>>;
  };
  /** Cancel the running call whose `rpc` id is `target` (pi's abort signal). */
  "tool.cancel": Base & { readonly target: string };
}

export interface ToolResults extends BrowserResults {
  /** `data` is the file's bytes in base64, so binary files survive. */
  "tool.readFile": { readonly data: string; readonly size: number };
  "tool.access": Record<string, never>;
  "tool.imageMimeType": { readonly mimeType: string | null };
  "tool.writeFile": { readonly bytes: number };
  "tool.mkdir": Record<string, never>;
  "tool.exists": { readonly exists: boolean };
  "tool.stat": { readonly isDirectory: boolean; readonly isFile: boolean; readonly size: number };
  /** `omitted` entries beyond `MAX_TOOL_LIST_ENTRIES` were left out. */
  "tool.readdir": { readonly entries: readonly string[]; readonly omitted: number };
  /** Paths relative to `cwd`. */
  "tool.glob": { readonly paths: readonly string[]; readonly limitReached: boolean };
  "tool.grep": {
    readonly output: string;
    readonly matches: number;
    readonly limitReached: boolean;
    readonly truncatedBytes: number;
  };
  /**
   * `exited` with the code (128 + the signal number when a signal ended it, as
   * pi asks), or `timed-out` / `cancelled` with `exitCode: null` (the box
   * killed the process group).
   * `output` is the tail; when `truncatedBytes > 0` it starts with
   * `truncationMarker`, and `fullOutputPath` names a box path holding the
   * whole output (up to `MAX_EXEC_SPILL_BYTES`).
   */
  "tool.exec": {
    readonly outcome: ExecOutcome;
    readonly exitCode: number | null;
    readonly output: string;
    readonly truncatedBytes: number;
    readonly fullOutputPath: string | null;
  };
  "tool.cancel": { readonly found: boolean };
}

export type ToolMethod = keyof ToolParams;
export type ExecOutcome = "exited" | "timed-out" | "cancelled";
const EXEC_OUTCOMES: readonly ExecOutcome[] = ["exited", "timed-out", "cancelled"];

export const TOOL_METHODS: readonly ToolMethod[] = [
  "tool.readFile",
  "tool.access",
  "tool.imageMimeType",
  "tool.writeFile",
  "tool.mkdir",
  "tool.exists",
  "tool.stat",
  "tool.readdir",
  "tool.glob",
  "tool.grep",
  "tool.exec",
  "tool.cancel",
  ...BROWSER_METHODS,
];

/**
 * Methods that change the box. After a lost connection or a new boot the hub
 * never re-sends one to a new boot; the caller gets `tool.outcome-unknown`.
 */
export const MUTATING_TOOL_METHODS: ReadonlySet<ToolMethod> = new Set([
  "tool.writeFile",
  "tool.mkdir",
  "tool.exec",
  ...MUTATING_BROWSER_METHODS,
]);

export function isToolMethod(method: string): method is ToolMethod {
  return (TOOL_METHODS as readonly string[]).includes(method);
}

/**
 * The hub-side deadline of one call (PRD §8.1, principles 3 and 8): the box's
 * own budget for the call plus `TOOL_DEADLINE_GRACE_MS`.
 */
export function toolDeadlineMs<M extends ToolMethod>(method: M, params: ToolParams[M]): number {
  if (isBrowserMethod(method)) {
    return browserBudgetMs(method, params as BrowserParams[typeof method]) + TOOL_DEADLINE_GRACE_MS;
  }
  switch (method) {
    case "tool.exec":
      return (params as ToolParams["tool.exec"]).timeoutMs + TOOL_DEADLINE_GRACE_MS;
    case "tool.glob":
    case "tool.grep":
      return SEARCH_TIMEOUT_MS + TOOL_DEADLINE_GRACE_MS;
    case "tool.cancel":
      return TOOL_DEADLINE_GRACE_MS;
    default:
      return FS_DEADLINE_MS;
  }
}

// ---------------------------------------------------------------------------
// Errors

/** Error codes a tool `rpc.result` carries, or the hub client raises. */
export type ToolErrorCode =
  | "tool.bad-params"
  | "tool.path-escape"
  | "tool.not-found"
  | "tool.permission"
  | "tool.not-a-directory"
  | "tool.is-a-directory"
  | "tool.not-regular-file"
  | "tool.too-large"
  | "tool.busy"
  | "tool.io"
  | "tool.result-expired"
  | "tool.internal"
  | "tool.deadline"
  | "tool.outcome-unknown"
  | "browser.unavailable"
  | "browser.no-tab"
  | "browser.stale-ref"
  | "browser.bad-url"
  | "browser.failed"
  | "browser.origin-mismatch"
  | "browser.field-mismatch"
  | "browser.mask-missing";

/**
 * Owner and retry disposition of each error code (PRD §8.1, principle 2).
 * `user` covers the model's own bad request (a path outside the workspace, a
 * missing file): the model sees the error and decides; nothing is retried.
 */
export const TOOL_ERRORS: Readonly<
  Record<ToolErrorCode, { readonly owner: FailureOwner; readonly disposition: FailureDisposition }>
> = {
  "tool.bad-params": { owner: "hub", disposition: "give-up" },
  "tool.path-escape": { owner: "user", disposition: "give-up" },
  "tool.not-found": { owner: "user", disposition: "give-up" },
  "tool.permission": { owner: "user", disposition: "give-up" },
  "tool.not-a-directory": { owner: "user", disposition: "give-up" },
  "tool.is-a-directory": { owner: "user", disposition: "give-up" },
  "tool.not-regular-file": { owner: "user", disposition: "give-up" },
  "tool.too-large": { owner: "user", disposition: "give-up" },
  "tool.busy": { owner: "box", disposition: "retry" },
  "tool.io": { owner: "box", disposition: "give-up" },
  "tool.result-expired": { owner: "box", disposition: "give-up" },
  "tool.internal": { owner: "box", disposition: "retry-cold" },
  "tool.deadline": { owner: "box", disposition: "give-up" },
  "tool.outcome-unknown": { owner: "box", disposition: "give-up" },
  // The box's Chromium did not answer on its CDP port (restarting, crashed).
  "browser.unavailable": { owner: "box", disposition: "give-up" },
  // The model named a tab that does not exist, or a URL scheme the tools refuse.
  "browser.no-tab": { owner: "user", disposition: "give-up" },
  "browser.bad-url": { owner: "user", disposition: "give-up" },
  // A screenshot or subtree snapshot named a ref that is not of the latest snapshot.
  "browser.stale-ref": { owner: "user", disposition: "give-up" },
  // Playwright refused the call for a reason that is no outcome (a bad key name, say).
  "browser.failed": { owner: "user", disposition: "give-up" },
  // browser.fill (1.5): the field's frame is not on an origin the secret allows,
  // or the field is not of a kind the secret may go into. Nothing was filled.
  "browser.origin-mismatch": { owner: "user", disposition: "give-up" },
  "browser.field-mismatch": { owner: "user", disposition: "give-up" },
  // A filled element is gone from its page, so its mask cannot be placed: no screenshot.
  "browser.mask-missing": { owner: "user", disposition: "give-up" },
};

export function isToolErrorCode(code: string): code is ToolErrorCode {
  return Object.hasOwn(TOOL_ERRORS, code);
}

/**
 * Classifies a tool error. A read-only call that hit its deadline or lost its
 * box can be retried, since it changed nothing; a mutating one cannot.
 * Unknown codes are the box's and are not retried.
 */
export function classifyToolError(
  code: string,
  method: ToolMethod,
): { readonly owner: FailureOwner; readonly disposition: FailureDisposition } {
  if (!isToolErrorCode(code)) return { owner: "box", disposition: "give-up" };
  if (
    (code === "tool.deadline" ||
      code === "tool.outcome-unknown" ||
      code === "browser.unavailable") &&
    !MUTATING_TOOL_METHODS.has(method)
  ) {
    return { owner: "box", disposition: "retry" };
  }
  return TOOL_ERRORS[code];
}

// ---------------------------------------------------------------------------
// Decoding

export type ToolDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function path(f: Fields, key: string): string {
  const value = f.string(key, MAX_TOOL_PATH_LENGTH, false);
  if (value.includes("\u0000")) f.fail(key, "must not contain NUL");
  return value;
}

function stringArray(f: Fields, key: string, maxItems: number): string[] {
  const value = f.raw(key);
  if (!Array.isArray(value)) f.fail(key, "expected an array");
  if (value.length > maxItems) f.fail(key, `more than ${maxItems} items`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length > MAX_TOOL_PATH_LENGTH) {
      throw new FieldError(`${f.path(key)}[${index}]`, "expected a short string");
    }
    return item;
  });
}

/** `tool.exec`'s `env`. A failure names the variable, never its value. */
function execEnv(f: Fields, key: string): Record<string, string> {
  const value = f.raw(key);
  if (!isObj(value)) f.fail(key, "expected an object");
  const names = Object.keys(value);
  if (names.length === 0) f.fail(key, "must not be empty");
  if (names.length > MAX_EXEC_ENV_VARS) f.fail(key, `more than ${MAX_EXEC_ENV_VARS} variables`);
  const env: Record<string, string> = {};
  for (const name of names) {
    const problem = execEnvNameProblem(name);
    if (problem !== undefined) f.fail(key, `variable name ${JSON.stringify(name)} ${problem}`);
    const item = value[name];
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > MAX_EXEC_ENV_VALUE_LENGTH ||
      item.includes("\u0000")
    ) {
      f.fail(key, `${name} must be a non-empty string without NUL, at most ${MAX_EXEC_ENV_VALUE_LENGTH} characters`);
    }
    env[name] = item;
  }
  return env;
}

function liveStreamId(f: Fields, key: string): number {
  const value = f.int(key, LIVE_OUTPUT_STREAM_BASE, 2 ** 32 - 2);
  if (!isLiveOutputStreamId(value)) f.fail(key, "must be an even live output stream id");
  return value;
}

const base = (f: Fields): Base => ({ callId: f.id("callId") });

const PARAMS: { readonly [M in ToolMethod]: (f: Fields) => ToolParams[M] } = {
  ...BROWSER_PARAMS,
  "tool.readFile": (f) => ({ ...base(f), path: path(f, "path") }),
  "tool.access": (f) => ({ ...base(f), path: path(f, "path"), write: f.bool("write") }),
  "tool.imageMimeType": (f) => ({ ...base(f), path: path(f, "path") }),
  "tool.writeFile": (f) => ({
    ...base(f),
    path: path(f, "path"),
    content: f.string("content", MAX_TOOL_FILE_BYTES),
  }),
  "tool.mkdir": (f) => ({ ...base(f), path: path(f, "path") }),
  "tool.exists": (f) => ({ ...base(f), path: path(f, "path") }),
  "tool.stat": (f) => ({ ...base(f), path: path(f, "path") }),
  "tool.readdir": (f) => ({ ...base(f), path: path(f, "path") }),
  "tool.glob": (f) => ({
    ...base(f),
    pattern: path(f, "pattern"),
    cwd: path(f, "cwd"),
    ignore: stringArray(f, "ignore", 256),
    limit: f.int("limit", 1, MAX_TOOL_LIST_ENTRIES),
  }),
  "tool.grep": (f) => ({
    ...base(f),
    pattern: f.string("pattern", MAX_TOOL_PATH_LENGTH, false),
    path: path(f, "path"),
    ...(f.has("glob") ? { glob: path(f, "glob") } : {}),
    ignoreCase: f.bool("ignoreCase"),
    literal: f.bool("literal"),
    context: f.int("context", 0, 100),
    limit: f.int("limit", 1, MAX_TOOL_LIST_ENTRIES),
  }),
  "tool.exec": (f) => ({
    ...base(f),
    command: f.string("command", MAX_EXEC_COMMAND_LENGTH, false),
    cwd: path(f, "cwd"),
    timeoutMs: f.int("timeoutMs", 1, MAX_EXEC_TIMEOUT_MS),
    ...(f.has("outputStream") ? { outputStream: liveStreamId(f, "outputStream") } : {}),
    ...(f.has("env") ? { env: execEnv(f, "env") } : {}),
  }),
  "tool.cancel": (f) => ({ ...base(f), target: f.id("target") }),
};

const RESULTS: { readonly [M in ToolMethod]: (f: Fields) => ToolResults[M] } = {
  ...BROWSER_RESULTS,
  "tool.readFile": (f) => ({
    data: f.string("data", Math.ceil(MAX_TOOL_FILE_BYTES / 3) * 4),
    size: f.int("size", 0, MAX_TOOL_FILE_BYTES),
  }),
  "tool.access": () => ({}),
  "tool.imageMimeType": (f) => ({
    mimeType: f.raw("mimeType") === null ? null : f.string("mimeType", MAX_ID_LENGTH, false),
  }),
  "tool.writeFile": (f) => ({ bytes: f.int("bytes", 0, MAX_TOOL_FILE_BYTES * 4) }),
  "tool.mkdir": () => ({}),
  "tool.exists": (f) => ({ exists: f.bool("exists") }),
  "tool.stat": (f) => ({
    isDirectory: f.bool("isDirectory"),
    isFile: f.bool("isFile"),
    size: f.int("size", 0),
  }),
  "tool.readdir": (f) => ({
    entries: stringArray(f, "entries", MAX_TOOL_LIST_ENTRIES),
    omitted: f.int("omitted", 0),
  }),
  "tool.glob": (f) => ({
    paths: stringArray(f, "paths", MAX_TOOL_LIST_ENTRIES),
    limitReached: f.bool("limitReached"),
  }),
  "tool.grep": (f) => ({
    output: f.string("output", MAX_TOOL_OUTPUT_BYTES + 1024),
    matches: f.int("matches", 0),
    limitReached: f.bool("limitReached"),
    truncatedBytes: f.int("truncatedBytes", 0),
  }),
  "tool.exec": (f) => ({
    outcome: f.oneOf("outcome", EXEC_OUTCOMES),
    exitCode: f.raw("exitCode") === null ? null : f.int("exitCode", 0, 255),
    output: f.string("output", MAX_TOOL_OUTPUT_BYTES + 1024),
    truncatedBytes: f.int("truncatedBytes", 0),
    fullOutputPath:
      f.raw("fullOutputPath") === null ? null : f.string("fullOutputPath", MAX_TOOL_PATH_LENGTH),
  }),
  "tool.cancel": (f) => ({ found: f.bool("found") }),
};

function run<T>(value: JsonValue, decode: (f: Fields) => T): ToolDecodeResult<T> {
  if (!isObj(value)) return { ok: false, message: "expected an object" };
  try {
    return { ok: true, value: decode(new Fields(value)) };
  } catch (error) {
    if (error instanceof FieldError) return { ok: false, message: error.message };
    throw error;
  }
}

/** Checks the params of a tool `rpc`. Unknown fields (an `env`, say) are dropped. */
export function decodeToolParams<M extends ToolMethod>(
  method: M,
  params: JsonValue,
): ToolDecodeResult<ToolParams[M]> {
  return run(params, PARAMS[method]);
}

/** Checks the result of a tool `rpc.result`. */
export function decodeToolResult<M extends ToolMethod>(
  method: M,
  result: JsonValue,
): ToolDecodeResult<ToolResults[M]> {
  return run(result, RESULTS[method]);
}
