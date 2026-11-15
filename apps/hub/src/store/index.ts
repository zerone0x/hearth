/**
 * Hub persistence: the only code in Hearth that touches SQLite (AGENTS.md,
 * boundary rules). Everything else uses the `@hearth/core` interfaces these
 * classes implement.
 */

export { SqliteAuditSink } from "./audit-sink";
export { BUSY_TIMEOUT_MS, type OpenDatabaseOptions, openDatabase } from "./database";
export {
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_READ_LIMIT,
  SqliteEventStore,
  type SqliteEventStoreOptions,
} from "./event-store";
export { MIGRATIONS, type Migration, migrate, SCHEMA_VERSION } from "./migrations";
