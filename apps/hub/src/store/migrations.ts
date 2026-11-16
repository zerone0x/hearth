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
  {
    // `REPLACE` / `INSERT OR REPLACE` resolve a key conflict by deleting the old
    // row, and SQLite skips DELETE triggers for that unless the connection set
    // `recursive_triggers`. `openDatabase` sets it; these guards close the gap
    // for any connection that did not, by refusing an INSERT whose key is
    // already taken before the conflict is resolved.
    version: 2,
    name: "append-only guards against REPLACE on event and audit",
    sql: `
      CREATE TRIGGER event_no_replace BEFORE INSERT ON event
      WHEN EXISTS (
        SELECT 1 FROM event
        WHERE workspace_id = NEW.workspace_id AND session_id = NEW.session_id AND seq = NEW.seq
      ) OR (
        NEW.boot_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM event
          WHERE workspace_id = NEW.workspace_id AND boot_id = NEW.boot_id
            AND delivery_id = NEW.delivery_id
        )
      )
      BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

      CREATE TRIGGER audit_no_replace BEFORE INSERT ON audit
      WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
    `,
  },
  {
    // Box join tokens and per-box credentials (#7). Only SHA-256 hashes of
    // both are stored; the raw values exist only in the hub's memory while it
    // hands them out and in the box.
    version: 3,
    name: "box join tokens and per-box credentials",
    sql: `
      CREATE TABLE box_join_token (
        token_hash TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        box_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      CREATE INDEX box_join_token_by_box ON box_join_token (workspace_id, box_id);

      CREATE TABLE box_credential (
        box_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        session_id TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        issued_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    // The session manager's long-running orchestration (a wake, a hibernate),
    // logged before it acts so a hub restart can mark it interrupted
    // (PRD §8.1 principle 7; docs/DECISIONS.md, 0013).
    version: 4,
    name: "session operations",
    sql: `
      CREATE TABLE session_operation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        session_id TEXT NOT NULL REFERENCES session (id),
        kind TEXT NOT NULL CHECK (kind IN ('wake', 'hibernate')),
        status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'interrupted')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
      ) STRICT;
      CREATE INDEX session_operation_by_status ON session_operation (workspace_id, status);
    `,
  },
  {
    // The minimal local login (#44, decision 0014). `owner_password` holds the
    // argon2id hash of the owner password (PHC string, parameters included).
    // `login_session` is the server-side session behind the session cookie,
    // keyed by the SHA-256 of its id; the raw id is only in the cookie. It is
    // not `session`, which is the agent session of PRD §5.
    version: 5,
    name: "owner password and login sessions",
    sql: `
      CREATE TABLE owner_password (
        principal_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE login_session (
        id_hash TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        principal_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX login_session_by_expiry ON login_session (expires_at);
    `,
  },
  {
    // Content-addressed blobs (#117, decision 0037): screenshots and other
    // image tool results, kept once by the SHA-256 of their bytes instead of
    // as base64 inside events. `session_blob` says which sessions put a blob,
    // so a session reads only its own. Both are immutable; no row is deleted
    // until retention (#83) adds a decision and the code for it.
    version: 6,
    name: "content-addressed blobs and their sessions",
    sql: `
      CREATE TABLE blob (
        sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        mime TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        data BLOB NOT NULL CHECK (length(data) = size),
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE session_blob (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES blob (sha256),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, session_id, sha256)
      ) STRICT;

      CREATE TRIGGER blob_no_update BEFORE UPDATE ON blob
      BEGIN SELECT RAISE(ABORT, 'blob is immutable'); END;
      CREATE TRIGGER session_blob_no_update BEFORE UPDATE ON session_blob
      BEGIN SELECT RAISE(ABORT, 'session_blob is immutable'); END;
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
