/**
 * Dump a session's trajectory as JSON Lines (decision 0021), straight from the
 * hub's database, for when the API is not at hand:
 *
 *   bun apps/hub/src/trajectory-cli.ts [--db data/hearth.db] <session-id>
 *
 * Reads only; safe while the hub runs (WAL). Output is redacted like the
 * API's: the model key (`HEARTH_MODEL_KEY_REF`, the hub's own setting) is
 * resolved first, so a key an older build stored raw is redacted too. With
 * `HEARTH_VAULT_KEY_REF`, every vault value is redacted as well (decision
 * 0031); the vault is only opened, never created or rotated here.
 */

import { join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import {
  AllowAllAuthorizer,
  createDefaultSecretStore,
  DEFAULT_WORKSPACE_ID,
  type SecretStore,
} from "@hearth/core";
import { redactHub, registerKnownSecrets } from "./obs/redaction";
import { readAllEvents } from "./obs/routes";
import { buildTrajectory, toJsonl } from "./obs/trajectory";
import { HUB_VERSION } from "./obs/version";
import { openDatabase, SqliteAuditSink, SqliteEventStore, SqliteVaultStore } from "./store";
import { HubVault } from "./vault";

export interface DumpOptions {
  /** Where `keyRefs` resolve; defaults to the hub's default SecretStore. */
  readonly secrets?: SecretStore;
  /** SecretStore references whose values are redacted (the model key). */
  readonly keyRefs?: readonly string[];
  /** The vault key reference: every stored vault value is redacted too. */
  readonly vaultKeyRef?: string;
  readonly warn?: (message: string) => void;
}

export async function dumpTrajectory(
  dbPath: string,
  sessionId: string,
  options: DumpOptions = {},
): Promise<string> {
  // A `vault:` model key is among the vault's values, registered below.
  const keyRefs = (options.keyRefs ?? []).filter((ref) => !ref.startsWith("vault:"));
  const secrets = options.secrets ?? createDefaultSecretStore();
  const warn = options.warn ?? ((m: string) => console.error(m));
  if (keyRefs.length > 0) {
    await registerKnownSecrets(secrets, keyRefs, warn);
  }
  const db = openDatabase(dbPath);
  try {
    const store = new SqliteVaultStore(db);
    if (options.vaultKeyRef !== undefined && store.keyRecord() !== undefined) {
      // Opening registers every value it can decrypt; a key row exists, so it writes nothing.
      const audit = new SqliteAuditSink(db);
      const status = await new HubVault({
        store,
        audit,
        authorizer: new AllowAllAuthorizer({ audit }),
        keySecrets: secrets,
        keyRef: options.vaultKeyRef,
        log: () => {},
      }).open();
      if (status.state !== "enabled") warn("vault values are not redacted: the vault is disabled");
    }
    const events = await readAllEvents(
      new SqliteEventStore(db),
      { workspaceId: DEFAULT_WORKSPACE_ID },
      sessionId,
    );
    const records = buildTrajectory(events, {
      sessionId,
      versions: { pi: PI_VERSION, hub: HUB_VERSION },
      redact: redactHub,
    });
    return redactHub(toJsonl(records));
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let db = join(process.env["HEARTH_DATA_DIR"] || "data", "hearth.db");
  const at = args.indexOf("--db");
  if (at >= 0) {
    db = args[at + 1] ?? db;
    args.splice(at, 2);
  }
  const sessionId = args[0];
  if (sessionId === undefined || args.length !== 1) {
    console.error("usage: bun apps/hub/src/trajectory-cli.ts [--db PATH] <session-id>");
    process.exit(2);
  }
  const keyRef = process.env["HEARTH_MODEL_KEY_REF"];
  const vaultKeyRef = process.env["HEARTH_VAULT_KEY_REF"];
  process.stdout.write(
    await dumpTrajectory(db, sessionId, {
      keyRefs: keyRef ? [keyRef] : [],
      ...(vaultKeyRef ? { vaultKeyRef } : {}),
    }),
  );
}
