/**
 * Child process for the concurrent-migration test in `migrations.test.ts`:
 * opens its own connection to the database at argv[2], writes argv[3] to say
 * it is ready, waits for the file argv[4] to appear, then runs `migrate` with
 * migrations whose first statement is a slow read. The slow read keeps every
 * worker inside its transaction long enough that a deferred transaction would
 * let two of them read the same version and then both try to apply it.
 */

import { existsSync, writeFileSync } from "node:fs";
import { openDatabase } from "../database";
import { type Migration, migrate } from "../migrations";

const [path, readyFile, goFile] = process.argv.slice(2);
if (path === undefined || readyFile === undefined || goFile === undefined) {
  throw new Error("usage: migrate-worker <db> <ready-file> <go-file>");
}

const slowRead =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300000) SELECT count(*) FROM c;";
const migrations: Migration[] = [
  { version: 1, name: "one", sql: `${slowRead} CREATE TABLE one (x TEXT);` },
  { version: 2, name: "two", sql: `${slowRead} CREATE TABLE two (x TEXT);` },
];

const db = openDatabase(path, { migrate: false });
writeFileSync(readyFile, "");
while (!existsSync(goFile)) {
  await Bun.sleep(1);
}
const applied = migrate(db, migrations);
db.close();
console.log(JSON.stringify(applied));
