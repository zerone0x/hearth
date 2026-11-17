/**
 * Images by reference (decision 0037, amends 0021).
 *
 * - **Events keep a reference, not the bytes.** An image content part
 *   (`{type: "image", data: <base64>, mimeType}`, a screenshot or any other
 *   image tool result) is written to the event log as
 *   `{type: "image", mimeType, blob: {sha256, size, mime}}`; the bytes go to
 *   the hub's `BlobStore` first, once per content. The model still gets the
 *   image: only what is recorded changes.
 * - **A rebuilt runner gets the image back** from the store; one that is not
 *   there (over the cap, or a store-less hub) becomes a text part saying so.
 * - **`GET /v1/sessions/:id/blobs/:sha256`** serves a blob of that session,
 *   behind the login guard, authorized as `session.blob` first. A malformed
 *   hash, an unknown one and another session's all answer the same 404.
 *   The type is the one sniffed from the bytes (never HTML or script), sent
 *   with `nosniff` and a sandboxing CSP.
 * - Blobs are not text-redacted: screenshots are masked at capture (#118).
 */

import {
  type Authorizer,
  type BlobRef,
  type BlobStore,
  blobRefOf,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  type Principal,
  type SessionId,
  type WorkspaceScope,
} from "@hearth/core";
import type { Context, Hono } from "hono";
import type { HubEnv } from "../auth";

/** An image content part as pi and pi-ai carry it. */
interface ImagePart {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/** Bytes to store for an event, with the reference the event keeps. */
export interface PendingBlob {
  readonly ref: BlobRef;
  readonly bytes: Uint8Array;
}

function isImagePart(value: unknown): value is ImagePart {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { data?: unknown }).data === "string" &&
    typeof (value as { mimeType?: unknown }).mimeType === "string"
  );
}

/** The bytes and reference of an image part, or `undefined` when `value` is not one. */
export function imageBlob(value: unknown): PendingBlob | undefined {
  if (!isImagePart(value)) return undefined;
  const bytes = new Uint8Array(Buffer.from(value.data, "base64"));
  return { ref: blobRefOf(bytes), bytes };
}

/**
 * A `JSON.stringify` replacer step: in a `content` array (a message's or a
 * tool result's), each image part becomes its reference, and its bytes are
 * pushed to `pending` (unless over the cap) for the caller to store before
 * the event that refers to them. Anything else is returned as is.
 */
export function imagesToRefs(key: string, value: unknown, pending?: PendingBlob[]): unknown {
  if (key !== "content" || !Array.isArray(value) || !value.some(isImagePart)) return value;
  return value.map((part: unknown) => {
    const blob = imageBlob(part);
    if (blob === undefined) return part;
    if (blob.ref.omitted === undefined) pending?.push(blob);
    const { data: _data, ...rest } = part as ImagePart & Record<string, unknown>;
    return { ...rest, blob: blob.ref };
  });
}

/** A quoted 64-digit hex string in JSON text: a JSON string, or one escaped inside another. */
const QUOTED_SHA256 = /(\\?")([0-9a-f]{64})\1/g;

/**
 * `redact(json)`, except that each quoted hash in `hashes` is kept as is
 * (#137). Those are the hashes of image bytes the caller just turned into
 * references (`pending`): a reference's `sha256`, or the same hash in the
 * text of the screenshot's result header. A hash of bytes is not text a
 * secret was typed into, and a short vault value that happens to occur in its
 * hex must not turn the reference into one the store cannot find. Everything
 * else is redacted as before, a 64-digit hex string that is not one of
 * `hashes` too. A secret's occurrence would have to contain the whole quoted
 * hash to span a kept one; the parts on either side are still redacted.
 */
export function redactKeepingHashes(
  json: string,
  redact: (text: string) => string,
  hashes: ReadonlySet<string>,
): string {
  if (hashes.size === 0) return redact(json);
  let out = "";
  let from = 0;
  for (const quoted of json.matchAll(QUOTED_SHA256)) {
    if (!hashes.has(quoted[2] ?? "")) continue;
    out += redact(json.slice(from, quoted.index)) + quoted[0];
    from = quoted.index + quoted[0].length;
  }
  return out + redact(json.slice(from));
}

/** The references of the image parts of a tool result's `content`, in order. */
export function imageRefs(content: unknown): BlobRef[] {
  if (!Array.isArray(content)) return [];
  const refs: BlobRef[] = [];
  for (const part of content) {
    const blob = imageBlob(part);
    if (blob !== undefined) refs.push(blob.ref);
  }
  return refs;
}

/** Store every pending blob for the session, in order. Rejects when a write fails. */
export async function storeBlobs(
  blobs: BlobStore | undefined,
  scope: WorkspaceScope,
  sessionId: SessionId,
  pending: readonly PendingBlob[],
): Promise<void> {
  if (blobs === undefined) return;
  for (const blob of pending) await blobs.put(scope, sessionId, blob.bytes);
}

function isImageRef(value: unknown): value is { type: "image"; blob: BlobRef; mimeType: string } {
  if (value === null || typeof value !== "object") return false;
  const v = value as { type?: unknown; blob?: unknown; data?: unknown; mimeType?: unknown };
  return (
    v.type === "image" &&
    v.data === undefined &&
    typeof v.mimeType === "string" &&
    v.blob !== null &&
    typeof v.blob === "object" &&
    typeof (v.blob as { sha256?: unknown }).sha256 === "string"
  );
}

/** The text a rebuilt runner gets for an image that is not in the store. */
export function missingImageText(ref: BlobRef): string {
  const why = ref.omitted === "too-large" ? "it was over the size cap" : "it is not in the store";
  return `[image ${ref.sha256} (${ref.mime}, ${ref.size} bytes) was not kept: ${why}]`;
}

/**
 * `value` (session entries read back from the event log) with every image
 * reference replaced by the image, read from the session's blobs; a missing
 * one becomes a text part, so pi never sends a model an image with no data.
 */
export async function restoreImages<T>(
  value: T,
  blobs: BlobStore | undefined,
  scope: WorkspaceScope,
  sessionId: SessionId,
): Promise<T> {
  const restore = async (part: unknown): Promise<unknown> => {
    if (!isImageRef(part)) return part;
    const stored = await blobs?.get(scope, sessionId, part.blob.sha256);
    if (stored === undefined) return { type: "text", text: missingImageText(part.blob) };
    // pi's own key order (type, data, mimeType), so a rebuilt session is the same JSON.
    const { type, blob: _blob, ...rest } = part;
    return { type, data: Buffer.from(stored.bytes).toString("base64"), ...rest };
  };
  const walk = async (v: unknown, key: string): Promise<unknown> => {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v)
        out.push(key === "content" ? await restore(item) : await walk(item, ""));
      return out;
    }
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v)) out[k] = await walk(item, k);
    return out;
  };
  return (await walk(value, "")) as T;
}

export interface SessionBlobsOptions {
  readonly authorizer: Authorizer;
  readonly blobs: BlobStore;
  /** Throws `session.not-found` for an unknown session. */
  readonly sessions: { get(principal: Principal, sessionId: SessionId): Promise<unknown> };
}

function notFound(): HearthError {
  return new HearthError("no such blob in this session", {
    owner: "user",
    disposition: "give-up",
    code: "blob.not-found",
  });
}

export class SessionBlobs {
  readonly #o: SessionBlobsOptions;
  readonly #scope: WorkspaceScope = { workspaceId: DEFAULT_WORKSPACE_ID };

  constructor(options: SessionBlobsOptions) {
    this.#o = options;
  }

  /** The blob, authorized as `session.blob`; `blob.not-found` for any hash the session did not put. */
  async get(
    principal: Principal,
    sessionId: SessionId,
    sha256: string,
  ): Promise<{ ref: BlobRef; bytes: Uint8Array }> {
    const decision = await this.#o.authorizer.authorize(principal, "session.blob", {
      workspaceId: this.#scope.workspaceId,
      type: "session",
      id: sessionId,
    });
    if (!decision.allowed) {
      throw new HearthError(`session.blob denied: ${decision.reason}`, {
        owner: "user",
        disposition: "give-up",
        code: "authz.denied",
      });
    }
    await this.#o.sessions.get(principal, sessionId);
    const stored = await this.#o.blobs.get(this.#scope, sessionId, sha256);
    if (stored === undefined) throw notFound();
    return stored;
  }
}

function failure(c: Context<HubEnv>, error: unknown): Response {
  if (!(error instanceof HearthError)) throw error;
  const status =
    error.code === "authz.denied"
      ? 403
      : error.code === "session.not-found" || error.code === "blob.not-found"
        ? 404
        : 500;
  return c.json(
    {
      ok: false,
      error: {
        code: error.code,
        owner: error.owner,
        disposition: error.disposition,
        message: error.message,
      },
    },
    status,
  );
}

/** Extensions for the download name; the type itself is sniffed. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function blobFileName(ref: BlobRef): string {
  return `${ref.sha256}.${EXTENSIONS[ref.mime] ?? "bin"}`;
}

export function mountBlobRoutes(app: Hono<HubEnv>, blobs: SessionBlobs): void {
  app.get("/v1/sessions/:id/blobs/:sha256", async (c) => {
    try {
      const { ref, bytes } = await blobs.get(
        c.get("principal"),
        c.req.param("id"),
        c.req.param("sha256"),
      );
      const image = ref.mime in EXTENSIONS;
      return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
        "content-type": ref.mime,
        "content-length": String(ref.size),
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-disposition": `${image ? "inline" : "attachment"}; filename="${blobFileName(ref)}"`,
        "cache-control": "private, no-store",
      });
    } catch (error) {
      return failure(c, error);
    }
  });
}
