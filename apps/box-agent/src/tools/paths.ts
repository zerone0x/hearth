/**
 * Path confinement for tool calls (decision 0011): every path a tool names
 * must stay inside the workspace, also after symlinks are followed.
 *
 * - A relative path is resolved against the workspace root. An absolute path
 *   must already be inside it (`/workspace/x`). `~` is not expanded: the
 *   runner rewrites it before the call, so `~/x` here is a relative name.
 * - Any `..` segment is refused outright, even one that would stay inside.
 * - The deepest existing ancestor is resolved with `realpath` and must be
 *   inside the real workspace root, so a symlink to `/etc` is refused. A
 *   dangling symlink is refused too, since writing through it would create
 *   its target wherever it points.
 *
 * This is a check, then a use: a process in the box that swaps a directory
 * for a symlink between the two could still escape. Anything in the box can
 * already do that through `tool.exec`, so the check guards against the model's
 * mistakes and hostile paths, not against code already running in the box.
 */

import { lstat, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { ToolCallError } from "./errors";

/** A path that has passed the check: `real` is safe to use for I/O. */
export interface ConfinedPath {
  /** Absolute path with the existing part resolved through symlinks. */
  readonly real: string;
  /** The lexical absolute path, as the caller would see it. */
  readonly lexical: string;
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function escapeError(input: string, why: string): ToolCallError {
  return new ToolCallError("tool.path-escape", `${JSON.stringify(input)} ${why}`);
}

export class Workspace {
  /** The workspace root as configured, e.g. `/workspace`. */
  readonly root: string;
  #realRoot: Promise<string> | undefined;

  constructor(root: string) {
    if (!posix.isAbsolute(root)) throw new Error(`workspace root ${root} is not absolute`);
    this.root = posix.normalize(root).replace(/\/+$/, "") || "/";
  }

  realRoot(): Promise<string> {
    this.#realRoot ??= realpath(this.root);
    return this.#realRoot;
  }

  /** Lexical check only: absolute, normalized, inside the root, no `..`. */
  lexical(input: string): string {
    if (input.length === 0) throw escapeError(input, "is empty");
    if (input.includes("\u0000")) throw escapeError(input, "contains NUL");
    if (input.split("/").includes("..")) throw escapeError(input, "contains a .. segment");
    const lexical = posix.isAbsolute(input) ? posix.normalize(input) : posix.join(this.root, input);
    const trimmed = lexical.length > 1 ? lexical.replace(/\/+$/, "") : lexical;
    if (!within(this.root, trimmed)) throw escapeError(input, `is outside ${this.root}`);
    return trimmed;
  }

  /** Full check, following symlinks of the part of the path that exists. */
  async resolve(input: string): Promise<ConfinedPath> {
    const lexical = this.lexical(input);
    const realRoot = await this.realRoot();
    const rest: string[] = [];
    let current = lexical;
    for (;;) {
      try {
        await lstat(current);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (current === this.root || current === "/") {
          throw new ToolCallError("tool.internal", `the workspace ${this.root} does not exist`);
        }
        rest.unshift(posix.basename(current));
        current = posix.dirname(current);
      }
    }
    let real: string;
    try {
      real = await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP") {
        throw escapeError(input, "goes through a dangling or looping symlink");
      }
      throw error;
    }
    if (!within(realRoot, real)) throw escapeError(input, `resolves outside ${this.root}`);
    return { real: rest.length === 0 ? real : posix.join(real, ...rest), lexical };
  }
}
