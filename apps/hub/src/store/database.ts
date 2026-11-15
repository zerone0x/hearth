/**
 * Opening the hub's SQLite database (PRD §8, §9). Only the store
 * implementations in this directory use the handle; business code goes through
 * the `@hearth/core` interfaces (AGENTS.md, boundary rules).
 */

import { Database } from "bun:sqlite";
import { HearthError } from "@hearth/core";
import { migrate } from "./migrations";

/**
 * How long a statement waits for another connection's write lock before it
 * fails with `SQLITE_BUSY`. Appends hold the lock for one short transaction,
 * so contention clears in milliseconds; five seconds rides out a slow disk or
 * a WAL checkpoint without letting a stuck writer hang a request forever.
 */
export const BUSY_TIMEOUT_MS = 5_000;

export interface OpenDatabaseOptions {
  /** Run the migrations after opening. Default `true`. */
  readonly migrate?: boolean;
}

/**
 * Open (or create) the hub database at `path` with the settings every hub
 * connection needs:
 *
 * - `journal_mode = WAL`: readers never block the writer and vice versa.
 * - `synchronous = FULL`: a commit is on disk when it returns, which is what
 *   "ack on apply" and "audit before act" rely on. `NORMAL` is faster in WAL
 *   mode but can lose the last commits on power loss.
 * - `busy_timeout = BUSY_TIMEOUT_MS`.
 * - `foreign_keys = ON`.
 * - `recursive_triggers = ON`: without it SQLite skips DELETE triggers when
 *   `REPLACE` removes a conflicting row, which would let `INSERT OR REPLACE`
 *   overwrite an `event` or `audit` row past the append-only triggers.
 *   Migration 2 also guards against that on connections opened elsewhere.
 *
 * `":memory:"` gives a private in-memory database (WAL does not apply there).
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  let db: Database | undefined;
  try {
    db = new Database(path, { create: true, readwrite: true, strict: true });
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA recursive_triggers = ON");
    if (options.migrate ?? true) {
      migrate(db);
    }
    return db;
  } catch (cause) {
    db?.close();
    if (cause instanceof HearthError) throw cause;
    throw new HearthError("Could not open the hub database", {
      owner: "hub",
      disposition: "give-up",
      code: "store.open-failed",
      cause,
    });
  }
}
