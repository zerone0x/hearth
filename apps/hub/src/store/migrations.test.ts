import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HearthError } from "@hearth/core";
import { BUSY_TIMEOUT_MS, openDatabase } from "./database";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "./migrations";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function versions(db: ReturnType<typeof openDatabase>): number[] {
  return db
    .query<{ version: number }, []>("SELECT version FROM schema_migration ORDER BY version")
    .all()
    .map((r) => r.version);
}

describe("migrate", () => {
  test("applies every migration once and is re-runnable", () => {
    const path = join(dir, "hub.db");
    const db = openDatabase(path, { migrate: false });
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(migrate(db)).toEqual([]);
    expect(versions(db)).toEqual(MIGRATIONS.map((m) => m.version));
    db.close();

    // Reopening (which migrates by default) applies nothing new and keeps data.
    const again = openDatabase(path);
    expect(migrate(again)).toEqual([]);
    expect(versions(again)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(
      again
        .query<{ id: string }, []>("SELECT id FROM workspace")
        .all()
        .map((r) => r.id),
    ).toEqual(["ws_default"]);
    again.close();
  });

  test("a database migrated by the session-manager hub (1-4) upgrades to the login (5)", () => {
    const path = join(dir, "hub.db");
    const old = openDatabase(path, { migrate: false });
    expect(migrate(old, MIGRATIONS.slice(0, 4))).toEqual([1, 2, 3, 4]);
    expect(MIGRATIONS[3]?.name).toBe("session operations");
    old.close();

    const db = openDatabase(path, { migrate: false });
    expect(migrate(db, MIGRATIONS.slice(0, 5))).toEqual([5]);
    expect(MIGRATIONS[4]?.name).toBe("owner password and login sessions");
    expect(versions(db)).toEqual([1, 2, 3, 4, 5]);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["session_operation", "owner_password", "login_session"]),
    );
    db.close();
  });

  test("a database before the blob store upgrades to it, with no blobs (decision 0037)", () => {
    const path = join(dir, "pre-blob.db");
    const at = MIGRATIONS.findIndex((m) => m.name === "content-addressed blobs and their sessions");
    expect(at).toBeGreaterThan(4);
    const old = openDatabase(path, { migrate: false });
    migrate(old, MIGRATIONS.slice(0, at));
    old.close();
    const db = openDatabase(path, { migrate: false });
    expect(migrate(db)[0]).toBe(at + 1);
    const count = (table: string) =>
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n;
    expect(count("blob")).toBe(0);
    expect(count("session_blob")).toBe(0);
    db.close();
  });

  test("a database at the login (5) upgrades to the vault (6) with no key row and no secrets", () => {
    const path = join(dir, "hub5.db");
    const old = openDatabase(path, { migrate: false });
    migrate(old, MIGRATIONS.slice(0, 5));
    old.close();
    const db = openDatabase(path, { migrate: false });
    expect(migrate(db, MIGRATIONS.slice(0, 6))).toEqual([6]);
    expect(MIGRATIONS[5]?.name).toBe("vault: wrapped data key and encrypted secrets");
    const count = (table: string) =>
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n;
    expect(count("vault_key")).toBe(0);
    expect(count("secret")).toBe(0);
    db.close();
  });

  test("a database before the settings upgrades to them, empty (decision 0038)", () => {
    const path = join(dir, "pre-settings.db");
    const at = MIGRATIONS.findIndex((m) => m.name === "hub settings");
    expect(at).toBeGreaterThan(5);
    const old = openDatabase(path, { migrate: false });
    migrate(old, MIGRATIONS.slice(0, at));
    old.close();
    const db = openDatabase(path, { migrate: false });
    expect(migrate(db)[0]).toBe(at + 1);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM setting").get()?.n).toBe(0);
    // A value must be JSON; one row per workspace and key.
    expect(() =>
      db.run("INSERT INTO setting VALUES ('ws_default', 'model', 'not json', 0)"),
    ).toThrow();
    db.run(`INSERT INTO setting VALUES ('ws_default', 'model', '{}', 0)`);
    expect(() => db.run(`INSERT INTO setting VALUES ('ws_default', 'model', '{}', 1)`)).toThrow();
    db.close();
  });

  test("applies only the missing migrations", () => {
    const db = openDatabase(":memory:", { migrate: false });
    const first = [{ version: 1, name: "one", sql: "CREATE TABLE one (workspace_id TEXT)" }];
    const both = [...first, { version: 2, name: "two", sql: "CREATE TABLE two (x TEXT)" }];
    expect(migrate(db, first)).toEqual([1]);
    expect(migrate(db, both)).toEqual([2]);
    expect(migrate(db, both)).toEqual([]);
    db.close();
  });

  test("a failing migration leaves no trace and can be retried", () => {
    const db = openDatabase(":memory:", { migrate: false });
    const broken = [{ version: 1, name: "broken", sql: "CREATE TABLE a (x TEXT); NOT SQL" }];
    expect(() => migrate(db, broken)).toThrow();
    expect(versions(db)).toEqual([]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a'").all(),
    ).toEqual([]);
    expect(migrate(db, [{ version: 1, name: "fixed", sql: "CREATE TABLE a (x TEXT)" }])).toEqual([
      1,
    ]);
    db.close();
  });

  test("rejects a database from a newer hub", () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO schema_migration (version, name, applied_at) VALUES (?, 'future', 0)", [
      SCHEMA_VERSION + 1,
    ]);
    let error: unknown;
    try {
      migrate(db);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("store.schema-too-new");
    db.close();
  });

  test("rejects gaps in the migration list", () => {
    const db = openDatabase(":memory:", { migrate: false });
    expect(() => migrate(db, [{ version: 2, name: "gap", sql: "SELECT 1" }])).toThrow(/expected 1/);
    db.close();
  });

  test("hubs migrating one fresh file at once apply each migration exactly once", async () => {
    // Fails if `migrate` reads the version in a deferred transaction: two
    // workers then read the same version and the later writer fails with
    // SQLITE_BUSY (stale snapshot) or "table already exists".
    const path = join(dir, "hub.db");
    // Create the file (already in WAL mode) but leave it unmigrated, so the
    // race is in `migrate`, not in the first switch to WAL.
    openDatabase(path, { migrate: false }).close();
    const go = join(dir, "go");
    const workers = 4;
    const worker = join(import.meta.dir, "testdata", "migrate-worker.ts");
    const ready = Array.from({ length: workers }, (_, w) => join(dir, `ready-${w}`));
    const children = ready.map((file) =>
      Bun.spawn([process.execPath, worker, path, file, go], { stdout: "pipe", stderr: "pipe" }),
    );
    const deadline = Date.now() + 20_000;
    while (!ready.every((file) => existsSync(file)) && Date.now() < deadline) {
      if (children.some((child) => child.exitCode !== null)) break;
      await Bun.sleep(5);
    }
    writeFileSync(go, "");
    const applied = await Promise.all(
      children.map(async (child) => {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        return JSON.parse(out) as number[];
      }),
    );
    expect(applied.flat().sort()).toEqual([1, 2]);
    const db = openDatabase(path, { migrate: false });
    expect(versions(db)).toEqual([1, 2]);
    db.close();
  }, 30_000);

  test("every M0 table has a workspace", () => {
    const db = openDatabase(":memory:");
    for (const table of ["session", "box", "event", "audit"]) {
      const columns = db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      expect(columns).toContain("workspace_id");
    }
    db.close();
  });
});

describe("openDatabase", () => {
  test("uses WAL, full sync, foreign keys, recursive triggers and the named busy timeout", () => {
    const db = openDatabase(join(dir, "hub.db"));
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
      "wal",
    );
    expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(2);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
    expect(
      db.query<{ recursive_triggers: number }, []>("PRAGMA recursive_triggers").get()
        ?.recursive_triggers,
    ).toBe(1);
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(
      BUSY_TIMEOUT_MS,
    );
    db.close();
  });

  test("fails with a classified error when the file cannot be opened", () => {
    let error: unknown;
    try {
      openDatabase(join(dir, "missing", "dir", "hub.db"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("store.open-failed");
    expect((error as HearthError).owner).toBe("hub");
  });
});
