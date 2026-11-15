/**
 * Child process for the first-open test in `database.test.ts`: writes argv[3]
 * to say it is ready, waits for the file argv[4] to appear, then opens the
 * (brand-new) database at argv[2] and prints "ok".
 */

import { existsSync, writeFileSync } from "node:fs";
import { openDatabase } from "../database";

const [path, readyFile, goFile] = process.argv.slice(2);
if (path === undefined || readyFile === undefined || goFile === undefined) {
  throw new Error("usage: open-worker <db> <ready-file> <go-file>");
}

writeFileSync(readyFile, "");
while (!existsSync(goFile)) {
  await Bun.sleep(1);
}
openDatabase(path).close();
console.log("ok");
