import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { HearthError, MAX_BLOB_BYTES, sniffBlobMime } from "@hearth/core";
import { SqliteBlobStore } from "./blob-store";
import { openDatabase } from "./database";

const scope = { workspaceId: "ws_default" };
const other = { workspaceId: "ws_other" };
const S = "se_1";

let db: Database;
let store: SqliteBlobStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  let clock = 1_000;
  store = new SqliteBlobStore(db, { now: () => clock++ });
});
afterEach(() => {
  db.close();
});

/** A JPEG-looking blob: its magic number, then `n` bytes of `fill`. */
function jpeg(fill: number, n = 64): Uint8Array {
  const bytes = new Uint8Array(3 + n).fill(fill);
  bytes.set([0xff, 0xd8, 0xff], 0);
  return bytes;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const count = (table: string) =>
  db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n;

describe("put and get", () => {
  test("stores the bytes under their sha256 with the sniffed type and reads them back", async () => {
    const bytes = jpeg(7);
    const ref = await store.put(scope, S, bytes);
    expect(ref).toEqual({ sha256: sha(bytes), size: bytes.byteLength, mime: "image/jpeg" });
    const got = await store.get(scope, S, ref.sha256);
    expect(got?.ref).toEqual(ref);
    expect(Buffer.from(got?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(await store.list(scope, S)).toEqual([ref]);
  });

  test("the same bytes are written once, however often and by however many sessions", async () => {
    const bytes = jpeg(1);
    const a = await store.put(scope, S, bytes);
    const b = await store.put(scope, S, bytes);
    const c = await store.put(scope, "se_2", bytes);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(count("blob")).toBe(1);
    expect(count("session_blob")).toBe(2);
    expect(await store.list(scope, S)).toEqual([a]);
    expect(await store.list(scope, "se_2")).toEqual([a]);
  });

  test("list keeps the order blobs were first put", async () => {
    const first = await store.put(scope, S, jpeg(3));
    const second = await store.put(scope, S, jpeg(2));
    await store.put(scope, S, jpeg(3));
    expect((await store.list(scope, S)).map((r) => r.sha256)).toEqual([
      first.sha256,
      second.sha256,
    ]);
  });

  test("another session's or workspace's hash reads exactly like an unknown one", async () => {
    const ref = await store.put(scope, S, jpeg(9));
    expect(await store.get(scope, "se_2", ref.sha256)).toBeUndefined();
    expect(await store.get(other, S, ref.sha256)).toBeUndefined();
    expect(await store.get(scope, S, sha(jpeg(10)))).toBeUndefined();
    expect(await store.list(scope, "se_2")).toEqual([]);
    expect(await store.list(other, S)).toEqual([]);
  });

  test("a malformed hash is unknown, never a query for something else", async () => {
    const ref = await store.put(scope, S, jpeg(4));
    for (const bad of [
      ref.sha256.toUpperCase(),
      `${ref.sha256}0`,
      ref.sha256.slice(1),
      `../${ref.sha256.slice(3)}`,
      `${ref.sha256.slice(0, 63)}%`,
      "",
    ]) {
      expect(await store.get(scope, S, bad)).toBeUndefined();
    }
  });
});

describe("scope checks", () => {
  test("an empty workspace or session id is refused by put, get and list", async () => {
    const bytes = jpeg(1);
    const code = async (p: Promise<unknown>) =>
      await p.then(
        () => "resolved",
        (e: unknown) => (e as HearthError).code,
      );
    const sha256 = (await store.put(scope, S, bytes)).sha256;
    for (const [s, id] of [
      [{ workspaceId: "" }, S],
      [scope, ""],
    ] as const) {
      expect(await code(store.put(s, id, bytes))).toBe("blob.invalid");
      expect(await code(store.get(s, id, sha256))).toBe("blob.invalid");
      expect(await code(store.list(s, id))).toBe("blob.invalid");
    }
    expect(count("session_blob")).toBe(1);
  });
});

describe("the cap", () => {
  test("exactly MAX_BLOB_BYTES is stored; one byte more is refused and nothing is written", async () => {
    const at = new Uint8Array(MAX_BLOB_BYTES).fill(1);
    const ref = await store.put(scope, S, at);
    expect(ref.size).toBe(MAX_BLOB_BYTES);
    expect(ref.omitted).toBeUndefined();
    const over = new Uint8Array(MAX_BLOB_BYTES + 1).fill(2);
    const error = await store.put(scope, S, over).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("blob.too-large");
    expect(count("blob")).toBe(1);
    expect(count("session_blob")).toBe(1);
  });
});

describe("immutability", () => {
  test("a stored blob cannot be changed in the database", async () => {
    const ref = await store.put(scope, S, jpeg(5));
    expect(() =>
      db.run("UPDATE blob SET mime = 'text/html' WHERE sha256 = ?", [ref.sha256]),
    ).toThrow("blob is immutable");
    expect(() =>
      db.run("UPDATE session_blob SET session_id = 'se_x' WHERE sha256 = ?", [ref.sha256]),
    ).toThrow("session_blob is immutable");
  });

  test("the table refuses a key that is not a lowercase sha256", () => {
    expect(() =>
      db.run(
        "INSERT INTO blob (sha256, mime, size, data, created_at) VALUES (?, 'image/png', 1, x'00', 1)",
        ["../../etc/passwd".padEnd(64, "a")],
      ),
    ).toThrow();
  });
});

describe("sniffBlobMime", () => {
  test("names the four image types by magic number and nothing else", () => {
    const ascii = (s: string) => new TextEncoder().encode(s);
    expect(sniffBlobMime(jpeg(0))).toBe("image/jpeg");
    expect(sniffBlobMime(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      "image/png",
    );
    expect(sniffBlobMime(ascii("GIF89a...."))).toBe("image/gif");
    expect(sniffBlobMime(ascii("GIF87a...."))).toBe("image/gif");
    expect(sniffBlobMime(ascii("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffBlobMime(ascii("<html><script>alert(1)</script>"))).toBe(
      "application/octet-stream",
    );
    expect(sniffBlobMime(Uint8Array.of(0xff, 0xd8))).toBe("application/octet-stream");
    expect(sniffBlobMime(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBe(
      "application/octet-stream",
    );
    expect(sniffBlobMime(ascii("RIFF\0\0\0\0WAVE"))).toBe("application/octet-stream");
    // The shortest blobs of each type: exactly the magic number.
    expect(sniffBlobMime(ascii("GIF89a"))).toBe("image/gif");
    expect(sniffBlobMime(ascii("RIFF\0\0\0\0WEBP"))).toBe("image/webp");
  });
});
