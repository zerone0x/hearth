import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    expect(versions(db)).toEqual([SCHEMA_VERSION]);
    db.close();

    // Reopening (which migrates by default) applies nothing new and keeps data.
    const again = openDatabase(path);
    expect(migrate(again)).toEqual([]);
    expect(versions(again)).toEqual([SCHEMA_VERSION]);
    expect(
      again
        .query<{ id: string }, []>("SELECT id FROM workspace")
        .all()
        .map((r) => r.id),
    ).toEqual(["ws_default"]);
    again.close();
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
  test("uses WAL, full sync, foreign keys and the named busy timeout", () => {
    const db = openDatabase(join(dir, "hub.db"));
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
      "wal",
    );
    expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(2);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
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
