/**
 * Content-addressed bytes a session produced (decision 0037): screenshots and
 * other image tool results. The event log keeps a `BlobRef` instead of the
 * bytes; the bytes live once in a `BlobStore`, keyed by their SHA-256.
 */

import { createHash } from "node:crypto";
import type { SessionId } from "./ids";
import type { WorkspaceScope } from "./tenancy";

/** The largest blob a store keeps. A bigger image is referenced with `omitted: "too-large"`. */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** A blob's key: 64 lowercase hex digits of the SHA-256 of its bytes. */
export const BLOB_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Media types a blob is served as. The type is sniffed from the bytes, never
 * taken from the producer, so a blob can never be served as HTML or script.
 */
export type BlobMime =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "application/octet-stream";

/** What an event or a trajectory record keeps of an image. */
export interface BlobRef {
  readonly sha256: string;
  /** Bytes. */
  readonly size: number;
  readonly mime: BlobMime;
  /** Set when the bytes were not stored: over `MAX_BLOB_BYTES`. */
  readonly omitted?: "too-large";
}

export interface StoredBlob {
  readonly ref: BlobRef;
  readonly bytes: Uint8Array;
}

/**
 * Guarantees: `put` is idempotent (the same bytes are written once, however
 * many sessions or events refer to them) and durable when it resolves; a blob
 * is never changed. `get` and `list` see only the blobs put for that session,
 * so another session's hash reads as unknown.
 */
export interface BlobStore {
  /** Store `bytes` for the session; rejects (`blob.too-large`) over `MAX_BLOB_BYTES`. */
  put(scope: WorkspaceScope, sessionId: SessionId, bytes: Uint8Array): Promise<BlobRef>;
  /** The blob, if this session put it; `undefined` for any other hash, well-formed or not. */
  get(scope: WorkspaceScope, sessionId: SessionId, sha256: string): Promise<StoredBlob | undefined>;
  /** Every blob of the session, in the order they were first put. */
  list(scope: WorkspaceScope, sessionId: SessionId): Promise<BlobRef[]>;
}

/** The media type of `bytes`, from their magic numbers. */
export function sniffBlobMime(bytes: Uint8Array): BlobMime {
  const b = (i: number) => bytes[i];
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (
    b(0) === 0x89 &&
    b(1) === 0x50 &&
    b(2) === 0x4e &&
    b(3) === 0x47 &&
    b(4) === 0x0d &&
    b(5) === 0x0a &&
    b(6) === 0x1a &&
    b(7) === 0x0a
  ) {
    return "image/png";
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return "image/gif";
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/** The reference `bytes` get: hash, size, sniffed type, and `omitted` over the cap. */
export function blobRefOf(bytes: Uint8Array): BlobRef {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ref = { sha256, size: bytes.byteLength, mime: sniffBlobMime(bytes) };
  return bytes.byteLength > MAX_BLOB_BYTES ? { ...ref, omitted: "too-large" } : ref;
}
