import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";
import { MIGRATIONS, migrate } from "./migrations";

/**
 * `REPLACE` resolves a key conflict by deleting the old row, and SQLite skips
 * DELETE triggers for that unless `recursive_triggers` is on. These tests show
 * that neither half of the defence (the pragma in `openDatabase`, the
 * BEFORE INSERT guards of migration 2) depends on the other.
 */

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-store-"));
  path = join(dir, "hub.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const EVENT_COLUMNS =
  "(workspace_id, session_id, seq, ts, type, turn_id, payload_json, boot_id, delivery_id)";
const AUDIT_COLUMNS =
  "(id, workspace_id, at, principal_id, principal_kind, action, resource_workspace_id, resource_type)";

/** Every way to overwrite an existing row through an INSERT with a REPLACE conflict policy. */
const OVERWRITES: readonly { table: "event" | "audit"; sql: string }[] = [
  ...["REPLACE INTO", "INSERT OR REPLACE INTO"].flatMap((verb) => [
    // Same primary key.
    {
      table: "event" as const,
      sql: `${verb} event ${EVENT_COLUMNS} VALUES ('ws_default', 'ses_1', 1, 9, 'forged', NULL, '{}', 'boot_a', 1)`,
    },
    // New seq, same delivery key: the conflict is on the delivery index.
    {
      table: "event" as const,
      sql: `${verb} event ${EVENT_COLUMNS} VALUES ('ws_default', 'ses_1', 2, 9, 'forged', NULL, '{}', 'boot_a', 1)`,
    },
    {
      table: "audit" as const,
      sql: `${verb} audit ${AUDIT_COLUMNS} VALUES (1, 'ws_default', 9, 'pr_x', 'user', 'forged', 'ws_default', 'box')`,
    },
  ]),
];

function seed(db: Database): void {
  db.run(
    `INSERT INTO event ${EVENT_COLUMNS} VALUES ('ws_default', 'ses_1', 1, 1, 'turn.event', 'turn_1', '{"a":1}', 'boot_a', 1)`,
  );
  db.run(
    `INSERT INTO audit ${AUDIT_COLUMNS} VALUES (1, 'ws_default', 1, 'pr_local', 'user', 'desktop.takeover', 'ws_default', 'box')`,
  );
}

function snapshot(db: Database): unknown {
  return {
    event: db.query("SELECT * FROM event ORDER BY seq").all(),
    audit: db.query("SELECT * FROM audit ORDER BY id").all(),
  };
}

function recursiveTriggers(db: Database): number | undefined {
  return db.query<{ recursive_triggers: number }, []>("PRAGMA recursive_triggers").get()
    ?.recursive_triggers;
}

function expectEveryOverwriteRejected(db: Database): void {
  const before = snapshot(db);
  for (const { table, sql } of OVERWRITES) {
    expect(() => db.run(sql)).toThrow(`${table} is append-only`);
  }
  expect(snapshot(db)).toEqual(before);
}

describe("REPLACE on event and audit", () => {
  test("fails on a connection from openDatabase", () => {
    const db = openDatabase(path);
    expect(recursiveTriggers(db)).toBe(1);
    seed(db);
    expectEveryOverwriteRejected(db);
    db.close();
  });

  test("fails on a raw connection without recursive_triggers", () => {
    openDatabase(path).close();
    const db = new Database(path, { readwrite: true });
    expect(recursiveTriggers(db)).toBe(0);
    seed(db);
    expectEveryOverwriteRejected(db);
    db.close();
  });

  test("recursive_triggers alone stops it on a migration 1 schema", () => {
    const db = openDatabase(path, { migrate: false });
    migrate(db, MIGRATIONS.slice(0, 1));
    expect(recursiveTriggers(db)).toBe(1);
    seed(db);
    expectEveryOverwriteRejected(db);
    db.close();
  });

  test("without either guard REPLACE overwrites, which is the hole being closed", () => {
    const setup = openDatabase(path, { migrate: false });
    migrate(setup, MIGRATIONS.slice(0, 1));
    setup.close();
    const db = new Database(path, { readwrite: true });
    seed(db);
    db.run(
      `REPLACE INTO audit ${AUDIT_COLUMNS} VALUES (1, 'ws_default', 9, 'pr_x', 'user', 'forged', 'ws_default', 'box')`,
    );
    expect(db.query<{ action: string }, []>("SELECT action FROM audit").get()?.action).toBe(
      "forged",
    );
    db.close();
  });

  test("plain inserts of new rows still work on a raw connection", () => {
    openDatabase(path).close();
    const db = new Database(path, { readwrite: true });
    seed(db);
    db.run(
      `INSERT INTO event ${EVENT_COLUMNS} VALUES ('ws_default', 'ses_1', 2, 2, 'turn.event', NULL, '{}', 'boot_a', 2)`,
    );
    db.run(
      `INSERT INTO audit (workspace_id, at, principal_id, principal_kind, action, resource_workspace_id, resource_type)
       VALUES ('ws_default', 2, 'pr_local', 'user', 'session.create', 'ws_default', 'session')`,
    );
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM event").get()?.n).toBe(2);
    expect(
      db
        .query<{ id: number }, []>("SELECT id FROM audit ORDER BY id")
        .all()
        .map((r) => r.id),
    ).toEqual([1, 2]);
    db.close();
  });
});
