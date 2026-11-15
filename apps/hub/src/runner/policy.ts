/**
 * Hub-side rules the runner applies to every tool call before it leaves the
 * hub, and to every result before the model sees it (PRD §8.2.1; decisions
 * 0011 and 0015).
 *
 * - `~` means `/workspace` (decision 0011): pi expands `~` with the hub's
 *   home before the operations see a path, so the runner rewrites it first.
 * - A deny-list from config blocks a call outright (the M1 approvals hook;
 *   the full approvals UI is M3). It is best-effort, not a boundary: paths are
 *   normalized before matching (`//`, `..`, relative paths), but a shell
 *   command can always be spelled another way (`rm -fr`, `$X -rf`, base64).
 *   The box is the boundary; real approvals are M3 (decision 0015).
 * - A result that names a hub temp file (pi's bash truncation hint, codemode's
 *   spilled output or saved image) is rewritten: that file is on the hub, the
 *   model's next `read` would go to the box, and the hub's disk is not the
 *   model's to point at.
 */

import { tmpdir } from "node:os";
import { posix } from "node:path";

/** Tools whose input has a `path` the runner rewrites. */
export const PATH_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
]);

/** `~` and `~/x` become the box workspace; anything else is unchanged (`~user` too). */
export function rewriteHome(path: string, boxCwd: string): string {
  if (path === "~") return boxCwd;
  if (path.startsWith("~/")) return `${boxCwd}${path.slice(1)}`;
  return path;
}

/**
 * One deny rule from config. `tool` names a tool (`*` for any); `pattern` is a
 * regular expression tested against the call's `command` (bash), `path`, or
 * the whole input as JSON for other tools.
 */
export interface DenyRule {
  readonly tool: string;
  readonly pattern?: string;
  /** Shown to the model and recorded in the event log. */
  readonly reason?: string;
}

export interface CompiledDenyRule {
  readonly tool: string;
  readonly pattern: RegExp | undefined;
  readonly reason: string;
}

/** Compiles the deny-list once, so a bad pattern fails at startup, not mid-turn. */
export function compileDenyList(rules: readonly DenyRule[]): CompiledDenyRule[] {
  return rules.map((rule, index) => {
    if (typeof rule.tool !== "string" || rule.tool.length === 0) {
      throw new Error(`deny rule ${index}: tool must be a non-empty string`);
    }
    let pattern: RegExp | undefined;
    if (rule.pattern !== undefined) {
      try {
        pattern = new RegExp(rule.pattern);
      } catch (error) {
        throw new Error(`deny rule ${index}: bad pattern: ${String(error)}`);
      }
    }
    return {
      tool: rule.tool,
      pattern,
      reason: rule.reason ?? `blocked by the hub's deny-list (rule ${index})`,
    };
  });
}

/**
 * A path as the box will resolve it: relative to the box cwd, with `//`,
 * `.` and `..` collapsed. `/workspace/../etc/passwd` and `//etc/passwd` both
 * become `/etc/passwd`, so a `^/etc/` rule sees them.
 */
export function normalizeBoxPath(path: string, boxCwd: string): string {
  return posix.resolve(boxCwd, path);
}

/** What the rules are tested against: the raw subject and, for a path, its normalized form. */
function subjectsOf(input: unknown, boxCwd: string): string[] {
  if (input !== null && typeof input === "object") {
    const record = input as { command?: unknown; path?: unknown };
    if (typeof record.command === "string") return [record.command];
    if (typeof record.path === "string") {
      const normalized = normalizeBoxPath(record.path, boxCwd);
      return normalized === record.path ? [record.path] : [normalized, record.path];
    }
  }
  if (typeof input === "string") return [input];
  return [JSON.stringify(input ?? null)];
}

/** The first rule that blocks this call, or undefined. */
export function denied(
  rules: readonly CompiledDenyRule[],
  toolName: string,
  input: unknown,
  boxCwd = "/workspace",
): CompiledDenyRule | undefined {
  const subjects = subjectsOf(input, boxCwd);
  for (const rule of rules) {
    if (rule.tool !== "*" && rule.tool !== toolName) continue;
    if (rule.pattern === undefined) return rule;
    const pattern = rule.pattern;
    if (subjects.some((subject) => pattern.test(subject))) return rule;
  }
  return undefined;
}

export const HUB_TEMP_NOTE = "(hub-side temp file, not in the box; not readable with tools)";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrites every absolute path under the hub's temp dir in `text`. */
export function scrubHubTempPaths(text: string, tempDir: string = tmpdir()): string {
  const root = tempDir.replace(/\/+$/, "");
  if (root.length === 0) return text;
  const pattern = new RegExp(`${escapeRegExp(root)}/[^\\s\\]\\)"'\`]*`, "g");
  return text.replace(pattern, HUB_TEMP_NOTE);
}
