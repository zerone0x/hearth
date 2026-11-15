import type { ToolErrorCode } from "@hearth/protocol";

/** A classified tool failure; its code becomes the `rpc.result` error code. */
export class ToolCallError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

const ERRNO: Readonly<Record<string, ToolErrorCode>> = {
  ENOENT: "tool.not-found",
  EACCES: "tool.permission",
  EPERM: "tool.permission",
  EROFS: "tool.permission",
  ENOTDIR: "tool.not-a-directory",
  EISDIR: "tool.is-a-directory",
  // Opening a FIFO without a reader, or a socket, for writing.
  ENXIO: "tool.not-regular-file",
  EFBIG: "tool.too-large",
};

/** Maps any thrown value to a `ToolCallError`, by errno where there is one. */
export function toToolError(error: unknown): ToolCallError {
  if (error instanceof ToolCallError) return error;
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (errno !== undefined) return new ToolCallError(ERRNO[errno] ?? "tool.io", message);
  return new ToolCallError("tool.internal", message);
}
