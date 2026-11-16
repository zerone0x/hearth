/**
 * Dump a session's trajectory as JSON Lines (decision 0021), straight from the
 * hub's database, for when the API is not at hand:
 *
 *   bun apps/hub/src/trajectory-cli.ts [--db data/hearth.db] <session-id>
 *
 * Reads only; safe while the hub runs (WAL). Output is redacted like the
 * API's: the model key (`HEARTH_MODEL_KEY_REF`, the hub's own setting) is
 * resolved first, so a key an older build stored raw is redacted too. When the
 * database has a vault, it is opened with `HEARTH_VAULT_KEY_REF` and
 * `HEARTH_VAULT_KEY_NEXT_REF` (mid-rotation, only the next key may match) and
 * every vault value is redacted as well (decision 0031); it is only opened,
 * never created or rotated here. If it does not open, the dump is refused
 * (exit 1): its values could not be redacted. `--unredacted-ok` dumps anyway,
 * with only the model key and the credential shapes redacted.
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
  /** `HEARTH_VAULT_KEY_NEXT_REF`: after a rotation committed, only this key matches. */
  readonly vaultNextKeyRef?: string;
  /**
   * Dump even when the database has a vault that does not open, so its
   * values are not redacted (`--unredacted-ok`). Default: refuse.
   */
  readonly unredactedOk?: boolean;
  readonly warn?: (message: string) => void;
}

/** The dump was refused: the vault's values could not be redacted. */
export class UnredactedDumpError extends Error {
  constructor(reason: string) {
    super(
      `refusing to dump: the vault is disabled (${reason}), so its values would not be redacted; set HEARTH_VAULT_KEY_REF (and HEARTH_VAULT_KEY_NEXT_REF mid-rotation) to the vault's key, or pass --unredacted-ok`,
    );
    this.name = "UnredactedDumpError";
  }
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
    if (store.keyRecord() !== undefined) {
      // Opening registers every value it can decrypt; read-only, it writes nothing.
      const audit = new SqliteAuditSink(db);
      const status = await new HubVault({
        store,
        audit,
        authorizer: new AllowAllAuthorizer({ audit }),
        keySecrets: secrets,
        ...(options.vaultKeyRef === undefined ? {} : { keyRef: options.vaultKeyRef }),
        ...(options.vaultNextKeyRef === undefined ? {} : { nextKeyRef: options.vaultNextKeyRef }),
        readOnly: true,
        log: () => {},
      }).open();
      if (status.state !== "enabled") {
        const reason = status.state === "disabled" ? status.reason : status.state;
        if (options.unredactedOk !== true) throw new UnredactedDumpError(reason);
        warn(`vault values are not redacted: the vault is disabled (${reason})`);
      }
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
  const unredacted = args.indexOf("--unredacted-ok");
  if (unredacted >= 0) args.splice(unredacted, 1);
  const sessionId = args[0];
  if (sessionId === undefined || args.length !== 1) {
    console.error(
      "usage: bun apps/hub/src/trajectory-cli.ts [--db PATH] [--unredacted-ok] <session-id>",
    );
    process.exit(2);
  }
  const keyRef = process.env["HEARTH_MODEL_KEY_REF"];
  const vaultKeyRef = process.env["HEARTH_VAULT_KEY_REF"];
  const vaultNextKeyRef = process.env["HEARTH_VAULT_KEY_NEXT_REF"];
  try {
    process.stdout.write(
      await dumpTrajectory(db, sessionId, {
        keyRefs: keyRef ? [keyRef] : [],
        ...(vaultKeyRef ? { vaultKeyRef } : {}),
        ...(vaultNextKeyRef ? { vaultNextKeyRef } : {}),
        unredactedOk: unredacted >= 0,
      }),
    );
  } catch (error) {
    if (!(error instanceof UnredactedDumpError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
