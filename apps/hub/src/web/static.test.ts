import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PRINCIPAL } from "@hearth/core";
import { createApp } from "../app";
import { AuthService, SESSION_COOKIE } from "../auth";
import type { BoxConnections } from "../box/connections";
import { webRootFromEnv } from "../main";
import { openDatabase, SqliteLoginStore } from "../store";
import { isWebAssetRequest, resolveAsset, WEB_CSP } from "./static";

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-web-test-"));
  dirs.push(dir);
  return dir;
}

/** A built UI: index.html, one hashed asset, and a secret beside the root. */
function webRoot(): string {
  const dir = tempDir();
  const root = join(dir, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(
    join(root, "index.html"),
    '<!doctype html><script type="module" src="/assets/a.js">',
  );
  writeFileSync(join(root, "assets", "a.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.txt"), "hub secret");
  symlinkSync(join(dir, "secret.txt"), join(root, "assets", "link.txt"));
  return root;
}

function harness(root: string | undefined) {
  const db = openDatabase(join(tempDir(), "hub.db"));
  closers.push(() => db.close());
  const auth = new AuthService({ store: new SqliteLoginStore(db) });
  const app = createApp(
    { boxes: {} as BoxConnections, auth },
    root === undefined ? {} : { webRoot: root },
  );
  const get = (path: string, init: RequestInit = {}) =>
    app.request(`http://127.0.0.1:8787${path}`, init);
  return { app, auth, get };
}

describe("web UI assets (decision 0017)", () => {
  test("index.html is served without a login, with the CSP and no-sniff", async () => {
    const h = harness(webRoot());
    const res = await h.get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(res.headers.get("content-security-policy")).toBe(WEB_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("/assets/a.js");
    expect((await h.get("/index.html")).headers.get("content-security-policy")).toBe(WEB_CSP);
  });

  test("hashed assets are served with a long cache and their type", async () => {
    const h = harness(webRoot());
    const res = await h.get("/assets/a.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("content-security-policy")).toBeNull();
    const head = await h.get("/assets/a.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("nothing outside the web root is served: dot-dot, encoded or not, and symlinks out", async () => {
    const h = harness(webRoot());
    for (const path of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/%2E%2E/%2e%2e/secret.txt",
      "/assets/link.txt",
      "/assets%5c..%5c..%5csecret.txt",
      "/%00",
      "/%E0%A4%A",
      "/assets",
      "/missing.js",
    ]) {
      const res = await h.get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(await res.text()).not.toContain("hub secret");
    }
  });

  test("the API stays behind the login: /v1 paths, known or not, and other methods", async () => {
    const h = harness(webRoot());
    expect((await h.get("/v1/sessions")).status).toBe(401);
    expect((await h.get("/v1/nope")).status).toBe(401);
    expect((await h.get("/v1")).status).toBe(401);
    const post = await h.get("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(post.status).toBe(401);
    // Signed in, a /v1 path is still the API's, never a file.
    const session = h.auth.issueSession(LOCAL_PRINCIPAL);
    const res = await h.get("/v1/index.html", {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("the request guard still runs first: a foreign Host gets 421", async () => {
    const h = harness(webRoot());
    const res = await h.app.request("http://rebound.example/", {
      headers: { host: "rebound.example" },
    });
    expect(res.status).toBe(421);
  });

  test("without a web root the hub serves no UI and / needs a login", async () => {
    const h = harness(undefined);
    expect((await h.get("/")).status).toBe(401);
  });

  test("isWebAssetRequest and resolveAsset", () => {
    expect(isWebAssetRequest("GET", "/")).toBe(true);
    expect(isWebAssetRequest("HEAD", "/assets/x.js")).toBe(true);
    expect(isWebAssetRequest("GET", "/v1/sessions")).toBe(false);
    expect(isWebAssetRequest("GET", "/v1")).toBe(false);
    expect(isWebAssetRequest("POST", "/")).toBe(false);
    expect(isWebAssetRequest("GET", "/v10")).toBe(true);
    const root = webRoot();
    expect(resolveAsset(root, "/")).toBe(join(root, "index.html"));
    expect(resolveAsset(root, "/assets/a.js")).toBe(join(root, "assets", "a.js"));
  });
});

describe("webRootFromEnv", () => {
  test("HEARTH_WEB_DIR must hold an index.html; an unbuilt default is no UI", () => {
    const root = webRoot();
    expect(webRootFromEnv({ HEARTH_WEB_DIR: root })).toBe(root);
    expect(() => webRootFromEnv({ HEARTH_WEB_DIR: join(root, "assets") })).toThrow(/index.html/);
    expect(webRootFromEnv({}, root)).toBe(root);
    expect(webRootFromEnv({}, join(root, "assets"))).toBeUndefined();
  });
});
