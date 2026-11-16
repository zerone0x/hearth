/**
 * The SQLite implementation of `BlobStore` (decision 0037): content-addressed
 * bytes in the hub database, next to the event log that refers to them.
 *
 * - `blob` holds each distinct content once, keyed by its SHA-256; its media
 *   type is sniffed from the bytes (`blobRefOf`).
 * - `session_blob` records which sessions put it. Reads join through it, so a
 *   session sees only its own blobs and another session's hash reads exactly
 *   like an unknown one.
 * - Both tables refuse updates (migration triggers). Nothing deletes yet:
 *   retention follows the session and is #83's to add.
 */

import type { Database } from "bun:sqlite";
import {
  BLOB_SHA256_PATTERN,
  type BlobMime,
  type BlobRef,
  type BlobStore,
  blobRefOf,
  type EpochMs,
  HearthError,
  MAX_BLOB_BYTES,
  type SessionId,
  type StoredBlob,
  type WorkspaceScope,
} from "@hearth/core";

export interface SqliteBlobStoreOptions {
  readonly now?: () => EpochMs;
}

interface BlobRow {
  sha256: string;
  mime: string;
  size: number;
  data: Uint8Array;
}

function invalid(message: string): HearthError {
  return new HearthError(message, { owner: "hub", disposition: "give-up", code: "blob.invalid" });
}

function checkScope(scope: WorkspaceScope, sessionId: SessionId): void {
  if (typeof scope.workspaceId !== "string" || scope.workspaceId === "") {
    throw invalid("The workspace scope has no workspace id");
  }
  if (typeof sessionId !== "string" || sessionId === "") {
    throw invalid("The session id is empty");
  }
}

export class SqliteBlobStore implements BlobStore {
  readonly #db: Database;
  readonly #now: () => EpochMs;

  constructor(db: Database, options: SqliteBlobStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  async put(scope: WorkspaceScope, sessionId: SessionId, bytes: Uint8Array): Promise<BlobRef> {
    checkScope(scope, sessionId);
    const ref = blobRefOf(bytes);
    if (ref.omitted !== undefined) {
      throw new HearthError(
        `A blob of ${bytes.byteLength} bytes is over the ${MAX_BLOB_BYTES}-byte cap`,
        { owner: "hub", disposition: "give-up", code: "blob.too-large" },
      );
    }
    const now = this.#now();
    const write = this.#db.transaction(() => {
      // Content-addressed: the same bytes are written once, whoever puts them.
      this.#db.run(
        "INSERT INTO blob (sha256, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING",
        [ref.sha256, ref.mime, ref.size, bytes, now],
      );
      this.#db.run(
        "INSERT INTO session_blob (workspace_id, session_id, sha256, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        [scope.workspaceId, sessionId, ref.sha256, now],
      );
    });
    write.immediate();
    return ref;
  }

  async get(
    scope: WorkspaceScope,
    sessionId: SessionId,
    sha256: string,
  ): Promise<StoredBlob | undefined> {
    checkScope(scope, sessionId);
    // Not a hash: nothing to look up, and the same answer as an unknown one.
    if (typeof sha256 !== "string" || !BLOB_SHA256_PATTERN.test(sha256)) return undefined;
    const row = this.#db
      .query<BlobRow, [string, string, string]>(
        `SELECT b.sha256, b.mime, b.size, b.data FROM session_blob s
         JOIN blob b ON b.sha256 = s.sha256
         WHERE s.workspace_id = ? AND s.session_id = ? AND s.sha256 = ?`,
      )
      .get(scope.workspaceId, sessionId, sha256);
    if (row === null) return undefined;
    const bytes = new Uint8Array(row.data);
    return { ref: { sha256: row.sha256, size: row.size, mime: row.mime as BlobMime }, bytes };
  }

  async list(scope: WorkspaceScope, sessionId: SessionId): Promise<BlobRef[]> {
    checkScope(scope, sessionId);
    return this.#db
      .query<Omit<BlobRow, "data">, [string, string]>(
        `SELECT b.sha256, b.mime, b.size FROM session_blob s
         JOIN blob b ON b.sha256 = s.sha256
         WHERE s.workspace_id = ? AND s.session_id = ?
         ORDER BY s.created_at, s.rowid`,
      )
      .all(scope.workspaceId, sessionId)
      .map((r) => ({ sha256: r.sha256, size: r.size, mime: r.mime as BlobMime }));
  }
}
