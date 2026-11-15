import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HearthError } from "@hearth/core";
import { openDatabase, WAL_SWITCH_DEADLINE_MS } from "./database";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  test("several processes can open the same brand-new file at once", async () => {
    const workers = 16;
    const worker = join(import.meta.dir, "testdata", "open-worker.ts");
    // Many workers and rounds, each on a fresh file, because the race is timing-dependent.
    for (let round = 0; round < 8; round++) {
      const path = join(dir, `hub-${round}.db`);
      const go = join(dir, `go-${round}`);
      const ready = Array.from({ length: workers }, (_, w) => join(dir, `ready-${round}-${w}`));
      const children = ready.map((file) =>
        Bun.spawn([process.execPath, worker, path, file, go], { stdout: "pipe", stderr: "pipe" }),
      );
      const deadline = Date.now() + 20_000;
      while (!ready.every((file) => existsSync(file)) && Date.now() < deadline) {
        if (children.some((child) => child.exitCode !== null)) break;
        await Bun.sleep(5);
      }
      writeFileSync(go, "");
      for (const child of children) {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        expect(out.trim()).toBe("ok");
      }
      const db = openDatabase(path);
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      db.close();
    }
  }, 60_000);

  test("a locked file fails with store.open-failed within the WAL switch deadline", () => {
    const path = join(dir, "locked.db");
    // Another connection holds the file in rollback-journal mode with an
    // exclusive lock, so the WAL switch can never succeed.
    const holder = new Database(path, { create: true, readwrite: true, strict: true });
    holder.run("CREATE TABLE t (x)");
    holder.run("BEGIN EXCLUSIVE");
    try {
      const started = Date.now();
      let error: unknown;
      try {
        openDatabase(path);
      } catch (cause) {
        error = cause;
      }
      const elapsed = Date.now() - started;
      expect(error).toBeInstanceOf(HearthError);
      expect((error as HearthError).code).toBe("store.open-failed");
      // The deadline plus one attempt's busy wait and a pause; was ~62 s.
      expect(elapsed).toBeLessThan(WAL_SWITCH_DEADLINE_MS + 2_000);
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
  }, 30_000);
});
