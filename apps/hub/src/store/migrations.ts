/**
 * A numbered, forward-only migration runner for the hub database.
 *
 * Each migration runs in its own write transaction together with the row that
 * records it in `schema_migration`, so a crash leaves the database before or
 * after a migration, never half way. Running the runner again applies only
 * what is missing, so it is safe at every hub start.
 *
 * Never edit or renumber a migration that has shipped; add a new one.
 */

import type { Database } from "bun:sqlite";
import { DEFAULT_WORKSPACE_ID, HearthError } from "@hearth/core";

export interface Migration {
  /** 1, 2, 3, … with no gaps. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Triggers that abort any statement changing or removing a row of `table`, so
 * the table is append-only in the database itself, not only by convention
 * (PRD §10).
 */
function appendOnly(table: string): string {
  return `
    CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
    CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
  `;
}

/**
 * The tables of PRD §9 that M0 needs. Every table carries its workspace
 * (PRD §7, E1); for `workspace` itself that is its `id`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "m0 tables: workspace, session, box, event, audit",
    sql: `
      CREATE TABLE workspace (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO workspace (id, name, created_at)
      VALUES ('${DEFAULT_WORKSPACE_ID}', 'default', CAST(unixepoch('subsec') * 1000 AS INTEGER));

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        model TEXT,
        repo_url TEXT,
        box_id TEXT,
        last_activity_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      ) STRICT;
      CREATE INDEX session_by_workspace ON session (workspace_id, last_activity_at);

      CREATE TABLE box (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        session_id TEXT REFERENCES session (id),
        provider TEXT NOT NULL,
        provider_ref TEXT,
        volume_ref TEXT,
        state TEXT NOT NULL,
        image TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX box_by_workspace ON box (workspace_id, session_id);

      CREATE TABLE event (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq >= 1),
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        turn_id TEXT,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        boot_id TEXT,
        delivery_id INTEGER,
        CHECK ((boot_id IS NULL) = (delivery_id IS NULL)),
        PRIMARY KEY (workspace_id, session_id, seq)
      ) STRICT, WITHOUT ROWID;
      CREATE UNIQUE INDEX event_by_delivery ON event (workspace_id, boot_id, delivery_id)
        WHERE boot_id IS NOT NULL;
      ${appendOnly("event")}

      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        principal_id TEXT NOT NULL,
        principal_kind TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_workspace_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        allowed INTEGER CHECK (allowed IN (0, 1)),
        policy TEXT,
        reason TEXT,
        detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
      ) STRICT;
      CREATE INDEX audit_by_workspace ON audit (workspace_id, at);
      ${appendOnly("audit")}
    `,
  },
];

/** The schema version this code expects: the highest migration it knows. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Apply every migration that has not been applied yet, in order. Returns the
 * versions it applied (empty when the database was already current).
 *
 * Rejects a database migrated by a newer hub (`store.schema-too-new`): this
 * code cannot know what that schema means.
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migration "${m.name}" has version ${m.version}, expected ${i + 1}`);
    }
  });
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT
  `);
  const applyNext = db.transaction((): number | undefined => {
    // Read the version inside the write transaction, so two hubs starting at
    // once cannot both apply the same migration.
    const row = db
      .query<{ v: number | null }, []>("SELECT max(version) AS v FROM schema_migration")
      .get();
    const current = row?.v ?? 0;
    if (current > migrations.length) {
      throw new HearthError(
        `The hub database is at schema version ${current}, newer than this hub knows (${migrations.length})`,
        { owner: "hub", disposition: "give-up", code: "store.schema-too-new" },
      );
    }
    const next = migrations[current];
    if (next === undefined) return undefined;
    db.run(next.sql);
    db.run("INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)", [
      next.version,
      next.name,
      Date.now(),
    ]);
    return next.version;
  });
  const applied: number[] = [];
  for (;;) {
    const version = applyNext.immediate();
    if (version === undefined) return applied;
    applied.push(version);
  }
}
