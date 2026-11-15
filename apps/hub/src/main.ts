import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_HOSTNAME, parsePort, parsePublicOrigin, startHub } from "./server";

/** Where the hub keeps its database when `HEARTH_DATA_DIR` is not set. */
const DEFAULT_DATA_DIR = "data";

// Process entry point. Only listening config and the data directory are read
// here; secrets never come from env directly (they go through SecretStore, PRD §7 E7).
const dataDir = process.env["HEARTH_DATA_DIR"] || DEFAULT_DATA_DIR;
// The origin of a reverse proxy in front of the hub (docs/DECISIONS.md, 0010).
const publicOrigin = parsePublicOrigin(process.env["HEARTH_PUBLIC_ORIGIN"]);
mkdirSync(dataDir, { recursive: true });
const hub = startHub({
  hostname: process.env["HEARTH_HOST"] || DEFAULT_HOSTNAME,
  port: parsePort(process.env["HEARTH_PORT"]),
  ...(publicOrigin === undefined ? {} : { publicOrigin }),
  dbPath: join(dataDir, "hearth.db"),
});

console.log(`hearth hub listening on ${hub.url} (boxes dial ${hub.boxSocketUrl})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void hub.stop().then(() => process.exit(0));
  });
}
