/**
 * Images by reference (decision 0037): the replacer and the rebuild helpers,
 * and `GET /v1/sessions/:id/blobs/:sha256` through a real hub.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BlobRef,
  type BlobStore,
  blobRefOf,
  DEFAULT_WORKSPACE_ID,
  LOCAL_PRINCIPAL,
  MAX_BLOB_BYTES,
} from "@hearth/core";
import { Hono } from "hono";
import { type HubEnv, SESSION_COOKIE } from "../auth";
import { type Hub, startHub } from "../server";
import { openDatabase, SqliteBlobStore } from "../store";
import { exportBlobs } from "../trajectory-cli";
import {
  imageRefs,
  imagesToRefs,
  missingImageText,
  mountBlobRoutes,
  type PendingBlob,
  restoreImages,
  SessionBlobs,
  storeBlobs,
} from "./blobs";
import { capText } from "./cap";
import { capResult } from "./turn-tracer";

const scope = { workspaceId: DEFAULT_WORKSPACE_ID };
const dirs: string[] = [];
const hubs: Hub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-blobs-"));
  dirs.push(dir);
  return dir;
}

function jpeg(fill: number, n = 32): Buffer {
  const bytes = Buffer.alloc(3 + n, fill);
  bytes.set([0xff, 0xd8, 0xff], 0);
  return bytes;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const part = (bytes: Buffer, mimeType = "image/jpeg") => ({
  type: "image",
  data: bytes.toString("base64"),
  mimeType,
});

describe("imagesToRefs", () => {
  const stringify = (value: unknown, pending?: PendingBlob[]) =>
    JSON.parse(JSON.stringify(value, (k, v: unknown) => imagesToRefs(k, v, pending)));

  test("an image part in a content array becomes its reference; its bytes are pending", () => {
    const bytes = jpeg(1);
    const pending: PendingBlob[] = [];
    const out = stringify(
      { result: { content: [{ type: "text", text: "shot" }, part(bytes)] } },
      pending,
    );
    const ref: BlobRef = { sha256: sha(bytes), size: bytes.byteLength, mime: "image/jpeg" };
    expect(out).toEqual({
      result: {
        content: [
          { type: "text", text: "shot" },
          { type: "image", mimeType: "image/jpeg", blob: ref },
        ],
      },
    });
    expect(pending.map((p) => p.ref)).toEqual([ref]);
    expect(Buffer.from(pending[0]?.bytes ?? []).equals(bytes)).toBe(true);
  });

  test("the type in the reference is sniffed, whatever the part claims", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const out = stringify({ content: [part(html, "image/png")] });
    expect(out.content[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      blob: { sha256: sha(html), size: html.byteLength, mime: "application/octet-stream" },
    });
  });

  test("only content arrays: an image-shaped object elsewhere (tool arguments) is kept as is", () => {
    const args = { arguments: { type: "image", data: "aGk=", mimeType: "image/png" } };
    expect(stringify(args)).toEqual(args);
    const nested = { content: { type: "image", data: "aGk=", mimeType: "image/png" } };
    expect(stringify(nested)).toEqual(nested);
    const noMime = { content: [{ type: "image", data: "aGk=" }] };
    expect(stringify(noMime)).toEqual(noMime);
  });

  test("over MAX_BLOB_BYTES: referenced as too-large, not pending, and no base64 kept", () => {
    const big = Buffer.alloc(MAX_BLOB_BYTES + 1, 7);
    const atCap = Buffer.alloc(MAX_BLOB_BYTES, 8);
    const pending: PendingBlob[] = [];
    const out = stringify({ content: [part(big), part(atCap)] }, pending);
    expect(out.content[0]).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      blob: {
        sha256: sha(big),
        size: MAX_BLOB_BYTES + 1,
        mime: "application/octet-stream",
        omitted: "too-large",
      },
    });
    expect(out.content[1].blob.omitted).toBeUndefined();
    expect(pending.map((p) => p.ref.size)).toEqual([MAX_BLOB_BYTES]);
    expect(JSON.stringify(out)).not.toContain(big.toString("base64").slice(0, 32));
  });

  test("imageRefs lists the references of a result's images, in order", () => {
    const a = jpeg(1);
    const b = jpeg(2);
    expect(imageRefs([part(a), { type: "text", text: "x" }, part(b)]).map((r) => r.sha256)).toEqual(
      [sha(a), sha(b)],
    );
    expect(imageRefs("not content")).toEqual([]);
  });
});

describe("restoreImages", () => {
  test("puts each stored image back, in content arrays only; a missing one becomes text", async () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteBlobStore(db);
      const kept = jpeg(3);
      const keptRef = await store.put(scope, "se_1", kept);
      const lostRef: BlobRef = { sha256: sha(jpeg(4)), size: 35, mime: "image/jpeg" };
      const bigRef: BlobRef = { ...lostRef, sha256: sha(jpeg(5)), omitted: "too-large" };
      const image = (blob: BlobRef) => ({ type: "image", mimeType: "image/jpeg", blob });
      const entries: unknown[] = [
        { message: { content: [image(keptRef), image(lostRef), image(bigRef)] } },
        { other: [image(keptRef)] },
      ];
      const content = (v: unknown[]) =>
        (v[0] as { message: { content: unknown[] } }).message.content;
      const out = await restoreImages(entries, store, scope, "se_1");
      expect(content(out)).toEqual([
        { type: "image", data: kept.toString("base64"), mimeType: "image/jpeg" },
        { type: "text", text: missingImageText(lostRef) },
        { type: "text", text: missingImageText(bigRef) },
      ]);
      expect(missingImageText(bigRef)).toContain("over the size cap");
      expect(missingImageText(lostRef)).toContain("not in the store");
      // Outside a content array nothing is touched.
      expect(out[1]).toEqual(entries[1]);
      // Another session's store holds nothing for it.
      const other = await restoreImages(entries, store, scope, "se_2");
      expect(content(other)[0]).toEqual({
        type: "text",
        text: missingImageText(keptRef),
      });
    } finally {
      db.close();
    }
  });
});

/** A hub with the login guard, an owner cookie and two sessions with blobs. */
async function fixture() {
  const dir = tempDir();
  const dbPath = join(dir, "hub.db");
  const hub = startHub({ dbPath, port: 0, boxPort: 0, log: () => undefined });
  hubs.push(hub);
  const cookie = `${SESSION_COOKIE}=${hub.auth.issueSession(LOCAL_PRINCIPAL).token}`;
  const get = (path: string, withCookie = true) =>
    fetch(new URL(path, hub.url), { headers: withCookie ? { cookie } : {} });
  const create = async () => {
    const res = await fetch(new URL("/v1/sessions", hub.url), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "t" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { session: { id: string } }).session.id;
  };
  const a = await create();
  const b = await create();
  const db = openDatabase(dbPath);
  const store = new SqliteBlobStore(db);
  const shotA = jpeg(1);
  const shotB = jpeg(2);
  const refA = await store.put(scope, a, shotA);
  const refB = await store.put(scope, b, shotB);
  db.close();
  return { hub, dbPath, get, a, b, shotA, refA, refB };
}

const answer = async (res: Response) => `${res.status} ${await res.text()}`;

describe("GET /v1/sessions/:id/blobs/:sha256", () => {
  test("serves a blob of the session with its sniffed type, nosniff and a sandboxing CSP", async () => {
    const f = await fixture();
    const res = await f.get(`/v1/sessions/${f.a}/blobs/${f.refA.sha256}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(f.shotA)).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="${f.refA.sha256}.jpg"`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("bytes that are not a known image are served as an octet-stream attachment", async () => {
    const f = await fixture();
    const db = openDatabase(f.dbPath);
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const ref = await new SqliteBlobStore(db).put(scope, f.a, html);
    db.close();
    const res = await f.get(`/v1/sessions/${f.a}/blobs/${ref.sha256}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${ref.sha256}.bin"`);
  });

  test("an unknown hash, another session's hash and a malformed or traversing one get the same answer", async () => {
    const f = await fixture();
    const base = `/v1/sessions/${f.a}/blobs/`;
    const expected = await answer(await f.get(`${base}${sha(jpeg(99))}`));
    expect(expected).toStartWith("404 ");
    expect(JSON.parse(expected.slice(4)).error.code).toBe("blob.not-found");
    for (const hash of [
      f.refB.sha256,
      f.refA.sha256.toUpperCase(),
      f.refA.sha256.slice(1),
      `${f.refA.sha256}00`,
      "..%2F..%2F..%2Fetc%2Fpasswd",
      "%2e%2e%2f%2e%2e%2fhub.db",
      `..%2F${f.refA.sha256}`,
      "not-a-hash",
    ]) {
      expect({ hash, got: await answer(await f.get(`${base}${hash}`)) }).toEqual({
        hash,
        got: expected,
      });
    }
    // Session B reads its own and not A's.
    expect((await f.get(`/v1/sessions/${f.b}/blobs/${f.refB.sha256}`)).status).toBe(200);
    expect(await answer(await f.get(`/v1/sessions/${f.b}/blobs/${f.refA.sha256}`))).toBe(
      expected.replaceAll(f.a, f.b),
    );
  });

  test("authorized as session.blob first: a denied caller gets 403 whatever the hash, and is audited", async () => {
    const f = await fixture();
    const seen: string[] = [];
    const inner = f.hub.authorizer.authorize.bind(f.hub.authorizer);
    f.hub.authorizer.authorize = async (principal, action, resource) => {
      seen.push(`${action} ${resource.type}:${resource.id}`);
      return await inner(principal, action, resource);
    };
    expect((await f.get(`/v1/sessions/${f.a}/blobs/${f.refA.sha256}`)).status).toBe(200);
    // session.blob first; the manager's existence check (session.read) after it.
    expect(seen[0]).toBe(`session.blob session:${f.a}`);

    f.hub.authorizer.authorize = async () => ({
      allowed: false,
      policy: "test",
      reason: "denied by policy",
    });
    const answers = new Set<string>();
    for (const hash of [f.refA.sha256, f.refB.sha256, sha(jpeg(99)), "bad"]) {
      answers.add(await answer(await f.get(`/v1/sessions/${f.a}/blobs/${hash}`)));
    }
    expect([...answers]).toHaveLength(1);
    expect([...answers][0]).toStartWith("403 ");
    const db = new Database(f.dbPath, { readonly: true });
    const rows = db
      .query<{ action: string; allowed: number }, []>(
        "SELECT action, allowed FROM audit WHERE action = 'session.blob' ORDER BY id",
      )
      .all();
    db.close();
    expect(rows[0]).toEqual({ action: "session.blob", allowed: 1 });
  });

  test("an unknown session is session.not-found; no login is 401", async () => {
    const f = await fixture();
    const res = await f.get(`/v1/sessions/se_unknown/blobs/${f.refA.sha256}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "session.not-found",
    );
    expect((await f.get(`/v1/sessions/${f.a}/blobs/${f.refA.sha256}`, false)).status).toBe(401);
  });
});

describe("trajectory CLI --export-blobs", () => {
  test("writes the session's blobs, and only its own, as <sha256>.<ext>, 0600", async () => {
    const f = await fixture();
    const out = join(tempDir(), "blobs");
    const written = await exportBlobs(f.dbPath, f.a, out);
    expect(written).toEqual([join(out, `${f.refA.sha256}.jpg`)]);
    expect(readdirSync(out)).toEqual([`${f.refA.sha256}.jpg`]);
    expect(readFileSync(join(out, `${f.refA.sha256}.jpg`)).equals(f.shotA)).toBe(true);
    expect(statSync(join(out, `${f.refA.sha256}.jpg`)).mode & 0o777).toBe(0o600);
    expect(await exportBlobs(f.dbPath, "se_unknown", join(tempDir(), "none"))).toEqual([]);
  });
});

describe("edges the mutation check found (decision 0037)", () => {
  test("imageRefs and capResult take results that are not content arrays", () => {
    expect(imageRefs(undefined)).toEqual([]);
    expect(imageRefs({ content: "x" })).toEqual([]);
    expect(capResult("plain text")).toEqual({ ...capText("plain text") });
    expect(capResult(null)).toEqual({ ...capText("") });
    // No images: neither the count nor the references are added.
    expect(Object.keys(capResult({ content: [{ type: "text", text: "t" }] }))).not.toContain(
      "images",
    );
    expect(Object.keys(capResult({ content: [{ type: "text", text: "t" }] }))).not.toContain(
      "image_blobs",
    );
  });

  test("storeBlobs without a store stores nothing and does not fail", async () => {
    const bytes = jpeg(6);
    await storeBlobs(undefined, scope, "se_1", [{ ref: blobRefOf(bytes), bytes }]);
  });

  test("restoreImages passes over null and non-object content items", async () => {
    const entries = [{ content: [null, "text", 3] }];
    expect(await restoreImages(entries, undefined, scope, "se_1")).toEqual(entries);
  });

  test("a store error that is not a HearthError is a 500 that does not echo its message", async () => {
    const app = new Hono<HubEnv>();
    app.use(async (c, next) => {
      c.set("principal", LOCAL_PRINCIPAL);
      await next();
    });
    const failing: BlobStore = {
      put: async () => {
        throw new Error("unused");
      },
      get: async () => {
        throw new Error("disk error at /data/hearth.db");
      },
      list: async () => [],
    };
    mountBlobRoutes(
      app,
      new SessionBlobs({
        authorizer: { authorize: async () => ({ allowed: true, policy: "test" }) },
        blobs: failing,
        sessions: { get: async () => undefined },
      }),
    );
    const res = await app.request(`/v1/sessions/se_1/blobs/${"0".repeat(64)}`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("/data/hearth.db");
  });

  test("the trajectory CLI exports blobs from the command line and still prints the trajectory", async () => {
    const f = await fixture();
    const db = openDatabase(f.dbPath);
    const second = await new SqliteBlobStore(db).put(scope, f.a, jpeg(42));
    db.close();
    const out = join(tempDir(), "exported");
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "..", "trajectory-cli.ts"),
        "--db",
        f.dbPath,
        "--export-blobs",
        out,
        f.a,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, HEARTH_MODEL_KEY_REF: "" } },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('"kind":"session"');
    expect(run.stderr.toString()).toContain(`wrote 2 blob(s) to ${out}`);
    expect(readdirSync(out).sort()).toEqual(
      [`${f.refA.sha256}.jpg`, `${second.sha256}.jpg`].sort(),
    );
    // Without the option nothing is exported; a missing DIR is a usage error.
    const plain = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "trajectory-cli.ts"), "--db", f.dbPath, f.a],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, HEARTH_MODEL_KEY_REF: "" } },
    );
    expect(plain.exitCode).toBe(0);
    expect(plain.stderr.toString()).not.toContain("blob(s)");
    const usage = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "..", "trajectory-cli.ts"),
        "--db",
        f.dbPath,
        f.a,
        "--export-blobs",
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, HEARTH_MODEL_KEY_REF: "" } },
    );
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr.toString()).toContain("--export-blobs DIR");
  });
});
