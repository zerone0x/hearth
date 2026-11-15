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

/**
 * `PRAGMA journal_mode = WAL` on a file that is not in WAL mode yet needs an
 * exclusive lock, and SQLite returns `SQLITE_BUSY` at once instead of waiting
 * out the busy timeout when another connection holds the file. That only
 * happens while the first connections race to convert a brand-new file, so the
 * switch is retried a bounded number of times with a growing pause.
 */
export const WAL_SWITCH_MAX_ATTEMPTS = 12;
/** First pause between WAL switch attempts; doubles each time. */
export const WAL_SWITCH_BASE_DELAY_MS = 5;
/** Upper bound for a single pause between WAL switch attempts. */
export const WAL_SWITCH_MAX_DELAY_MS = 250;

/**
 * `busy_timeout` while the WAL switch is retried. The retry loop already
 * paces itself, so a long busy wait per attempt would only stack on top of the
 * backoff (12 attempts x 5 s = about a minute before `store.open-failed`).
 */
export const WAL_SWITCH_BUSY_TIMEOUT_MS = 50;
/**
 * Deadline for the whole WAL switch (PRD §8.1 principle 8: every wait has a
 * named bound). A locked file fails with `store.open-failed` within this time
 * plus one attempt's busy wait.
 */
export const WAL_SWITCH_DEADLINE_MS = 3_000;

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
    db.run(`PRAGMA busy_timeout = ${WAL_SWITCH_BUSY_TIMEOUT_MS}`);
    switchToWal(db);
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
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

function isBusy(cause: unknown): boolean {
  const { code, errno } = cause as { code?: unknown; errno?: unknown };
  return (
    (typeof code === "string" && code.startsWith("SQLITE_BUSY")) ||
    (typeof errno === "number" && (errno & 0xff) === 5)
  );
}

/** Switch to WAL, retrying `SQLITE_BUSY` with bounded exponential backoff. */
function switchToWal(db: Database): void {
  let delay = WAL_SWITCH_BASE_DELAY_MS;
  const deadline = Date.now() + WAL_SWITCH_DEADLINE_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      db.run("PRAGMA journal_mode = WAL");
      return;
    } catch (cause) {
      if (!isBusy(cause) || attempt >= WAL_SWITCH_MAX_ATTEMPTS || Date.now() >= deadline) {
        throw cause;
      }
      Bun.sleepSync(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, WAL_SWITCH_MAX_DELAY_MS);
    }
  }
}
