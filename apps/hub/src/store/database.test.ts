import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  test("several processes can open the same brand-new file at once", async () => {
    const workers = 6;
    const worker = join(import.meta.dir, "testdata", "open-worker.ts");
    // A few rounds, each on a fresh file, because the race is timing-dependent.
    for (let round = 0; round < 3; round++) {
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
});
