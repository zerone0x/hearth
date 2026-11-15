/**
 * Child process for the cross-process concurrency test in
 * `event-store.test.ts`: opens its own connection to the database at argv[2]
 * and appends argv[4] events to session argv[3], tagging each with argv[5].
 */

import { DEFAULT_WORKSPACE_ID } from "@hearth/core";
import { openDatabase } from "../database";
import { SqliteEventStore } from "../event-store";

const [path, sessionId, countText, tag] = process.argv.slice(2);
if (path === undefined || sessionId === undefined || countText === undefined || tag === undefined) {
  throw new Error("usage: append-worker <db> <session> <count> <tag>");
}

const db = openDatabase(path);
const store = new SqliteEventStore(db);
const scope = { workspaceId: DEFAULT_WORKSPACE_ID };
const seqs: number[] = [];
for (let i = 0; i < Number(countText); i++) {
  const { seq } = await store.append(scope, sessionId, {
    type: "test.concurrent",
    payload: { tag, i },
  });
  seqs.push(seq);
  // Yield so the other writers get a turn at the lock.
  await Bun.sleep(0);
}
db.close();
console.log(JSON.stringify(seqs));
