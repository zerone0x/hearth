/**
 * Dump a session's trajectory as JSON Lines (decision 0021), straight from the
 * hub's database, for when the API is not at hand:
 *
 *   bun apps/hub/src/trajectory-cli.ts [--db data/hearth.db] <session-id>
 *
 * Reads only; safe while the hub runs (WAL). Output is redacted like the API's.
 */

import { join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DEFAULT_WORKSPACE_ID } from "@hearth/core";
import { redactHub } from "./obs/redaction";
import { readAllEvents } from "./obs/routes";
import { buildTrajectory, toJsonl } from "./obs/trajectory";
import { HUB_VERSION } from "./obs/version";
import { openDatabase, SqliteEventStore } from "./store";

export async function dumpTrajectory(dbPath: string, sessionId: string): Promise<string> {
  const db = openDatabase(dbPath);
  try {
    const events = await readAllEvents(
      new SqliteEventStore(db),
      { workspaceId: DEFAULT_WORKSPACE_ID },
      sessionId,
    );
    const records = buildTrajectory(events, {
      sessionId,
      versions: { pi: PI_VERSION, hub: HUB_VERSION },
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
  process.stdout.write(await dumpTrajectory(db, sessionId));
}
