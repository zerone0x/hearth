/**
 * Hub persistence: the only code in Hearth that touches SQLite (AGENTS.md,
 * boundary rules). Everything else uses the `@hearth/core` interfaces these
 * classes implement.
 */

export { SqliteAuditSink } from "./audit-sink";
export { SqliteBlobStore, type SqliteBlobStoreOptions } from "./blob-store";
export {
  SqliteBoxCredentialStore,
  type SqliteBoxCredentialStoreOptions,
} from "./box-credentials";
export { BUSY_TIMEOUT_MS, type OpenDatabaseOptions, openDatabase } from "./database";
export {
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_READ_LIMIT,
  SqliteEventStore,
  type SqliteEventStoreOptions,
} from "./event-store";
export { SqliteLoginStore } from "./login-store";
export { MIGRATIONS, type Migration, migrate, SCHEMA_VERSION } from "./migrations";
export {
  type BoxRow,
  type OperationKind,
  type OperationRow,
  type OperationStatus,
  type SessionRow,
  SqliteSessionStore,
} from "./sessions";
export { type SettingRow, SqliteSettingStore } from "./setting-store";
export {
  type SecretUseRow,
  SqliteVaultStore,
  type SqliteVaultStoreOptions,
} from "./vault-store";
export { SqliteVirtualKeyStore, type VirtualKeyRow } from "./virtual-key-store";
