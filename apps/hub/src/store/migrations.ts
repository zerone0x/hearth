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
    // The vault (#114, decision 0031, docs/research/vault.md "Data model").
    // `vault_key` holds the one data key, wrapped (AES-KW) by a subkey of the
    // key file; `kek_check` tells a wrong key file from a corrupt store.
    // `secret` holds one AES-256-GCM ciphertext per entry; its AAD binds id,
    // workspace, name, kind, version, scope and the SHA-256 of `policy_json`,
    // so an edit of any of them fails to decrypt. `meta_json` (label,
    // provider) is display only. No value is ever stored in clear.
    version: 6,
    name: "vault: wrapped data key and encrypted secrets",
    sql: `
      CREATE TABLE vault_key (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        wrapped_dek BLOB NOT NULL,
        kek_check TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        rotated_at INTEGER
      ) STRICT;

      CREATE TABLE secret (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('model-key', 'login', 'token')),
        scope_session_id TEXT REFERENCES session (id),
        policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
        meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
        iv BLOB NOT NULL CHECK (length(iv) = 12),
        ciphertext BLOB NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        UNIQUE (workspace_id, name)
      ) STRICT;
      CREATE INDEX audit_by_resource ON audit (resource_type, resource_id, at);
    `,
  },
  {
    // Content-addressed blobs (#117, decision 0037): screenshots and other
    // image tool results, kept once by the SHA-256 of their bytes instead of
    // as base64 inside events. `session_blob` says which sessions put a blob,
    // so a session reads only its own. Both are immutable; no row is deleted
    // until retention (#83) adds a decision and the code for it.
    version: 7,
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
  {
    // Hub settings the owner changes in the UI (decision 0038), one JSON value
    // per key and workspace. `model` holds `{provider, model, keyRef}`; the key
    // itself is a `vault:` reference, never a value. Every write is audited
    // (`settings.model.update`, `settings.model.import`) before it happens.
    version: 8,
    name: "hub settings",
    sql: `
      CREATE TABLE setting (
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        key TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, key)
      ) STRICT;
    `,
  },
  {
    // The access mode (decision 0045, PRD §6.5): a session's own override of
    // the global default (the `access_mode` setting). NULL follows the global
    // default; every change is audited and written to the event log as
    // `session.access_mode` before the row changes.
    version: 9,
    name: "session access mode",
    sql: `
      ALTER TABLE session ADD COLUMN access_mode TEXT
        CHECK (access_mode IS NULL OR access_mode IN ('yolo', 'ask'));
    `,
  },
  {
    // A session's Bifrost virtual key (decision 0047, PRD §6.4): only its id,
    // never the value, which is rotated on every runner build and kept in the
    // runner's memory. `provider`/`model` are the allowlist last sent;
    // `budget_usd` the budget last sent. `active` is 0 once the session is
    // archived (the key is deactivated in Bifrost).
    version: 10,
    name: "session virtual keys",
    sql: `
      CREATE TABLE session_virtual_key (
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        session_id TEXT NOT NULL REFERENCES session (id),
        vk_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        budget_usd REAL NOT NULL CHECK (budget_usd > 0),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, session_id)
      ) STRICT;
    `,
  },
  {
    // The approval records of the access gate (#155, decision 0048): one row
    // per tool call the gate held for the owner. A row is written after its
    // `approval.requested` event and leaves `pending` exactly once (a
    // conditional UPDATE), so a hub restart can mark the ones still pending
    // interrupted (PRD §8.1 principle 7) and the session list can show them.
    version: 11,
    name: "approvals",
    sql: `
      CREATE TABLE approval (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace (id),
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        summary TEXT NOT NULL,
        command TEXT NOT NULL,
        rule TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('yolo', 'ask')),
        status TEXT NOT NULL CHECK (status IN
          ('pending', 'approved', 'denied', 'expired', 'cancelled', 'interrupted')),
        requested_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        reason TEXT
      ) STRICT;
      CREATE INDEX approval_by_status ON approval (workspace_id, status);
    `,
  },
  {
    // The simple commands the parser found in a held command, for the
    // approval card's "Runs:" list (#169, decision 0048). JSON array of text.
    version: 12,
    name: "approval-steps",
    sql: `ALTER TABLE approval ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    // How many steps the card's cap left out (#171).
    version: 13,
    name: "approval-steps-omitted",
    sql: `ALTER TABLE approval ADD COLUMN steps_omitted INTEGER NOT NULL DEFAULT 0;`,
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
