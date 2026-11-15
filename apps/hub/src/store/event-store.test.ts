import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HearthError, type NewEvent, type StoredEvent } from "@hearth/core";
import { openDatabase } from "./database";
import { MAX_EVENT_PAYLOAD_BYTES, MAX_READ_LIMIT, SqliteEventStore } from "./event-store";

const scope = { workspaceId: "ws_default" };
const other = { workspaceId: "ws_other" };
const S = "ses_1";

let db: Database;
let store: SqliteEventStore;
let clock: number;
beforeEach(() => {
  db = openDatabase(":memory:");
  clock = 1_000;
  store = new SqliteEventStore(db, { now: () => clock++ });
});
afterEach(() => {
  db.close();
});

function rowCount(): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM event").get()?.n ?? -1;
}

function boxEvent(bootId: string, deliveryId: number, payload: NewEvent["payload"] = {}): NewEvent {
  return { type: "turn.event", turnId: "turn_1", payload, delivery: { bootId, deliveryId } };
}

async function rejection(promise: Promise<unknown>): Promise<HearthError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HearthError);
  return error as HearthError;
}

describe("append", () => {
  test("assigns per-session seq starting at 1", async () => {
    expect(await store.append(scope, S, { type: "a", payload: 1 })).toEqual({
      seq: 1,
      duplicate: false,
    });
    expect((await store.append(scope, S, { type: "b", payload: 2 })).seq).toBe(2);
    expect((await store.append(scope, "ses_2", { type: "c", payload: 3 })).seq).toBe(1);
    expect(await store.lastSeq(scope, S)).toBe(2);
    expect(await store.lastSeq(scope, "ses_2")).toBe(1);
    expect(await store.lastSeq(scope, "ses_none")).toBe(0);
  });

  test("stores every field and stamps the workspace from the scope", async () => {
    await store.append(scope, S, {
      type: "turn.event",
      turnId: "turn_7",
      ts: 123,
      payload: JSON.parse('{"nested":[1,"two",null,{"three":true}],"__proto__":"plain"}'),
      delivery: { bootId: "boot_a", deliveryId: 9 },
    });
    await store.append(scope, S, { type: "message.user", payload: "hi" });
    const { events } = await store.read(scope, S, 0, 10);
    expect(events).toEqual([
      {
        workspaceId: "ws_default",
        sessionId: S,
        seq: 1,
        ts: 123,
        type: "turn.event",
        turnId: "turn_7",
        payload: JSON.parse('{"nested":[1,"two",null,{"three":true}],"__proto__":"plain"}'),
        delivery: { bootId: "boot_a", deliveryId: 9 },
      },
      {
        workspaceId: "ws_default",
        sessionId: S,
        seq: 2,
        ts: 1_000,
        type: "message.user",
        payload: "hi",
      },
    ] satisfies StoredEvent[]);
    expect(Object.hasOwn(events[1] ?? {}, "turnId")).toBe(false);
    expect(Object.hasOwn(events[1] ?? {}, "delivery")).toBe(false);
  });

  test("re-applying a delivery returns the original seq and writes nothing", async () => {
    expect(await store.append(scope, S, boxEvent("boot_a", 1, "first"))).toEqual({
      seq: 1,
      duplicate: false,
    });
    await store.append(scope, S, { type: "session.state", payload: "running" });
    expect(await store.append(scope, S, boxEvent("boot_a", 1, "redelivered"))).toEqual({
      seq: 1,
      duplicate: true,
    });
    expect(rowCount()).toBe(2);
    expect(await store.lastSeq(scope, S)).toBe(2);
    const { events } = await store.read(scope, S, 0, 10);
    expect(events[0]?.payload).toBe("first");
  });

  test("a new boot or a new delivery id is a new delivery", async () => {
    expect((await store.append(scope, S, boxEvent("boot_a", 1))).seq).toBe(1);
    expect((await store.append(scope, S, boxEvent("boot_a", 2))).seq).toBe(2);
    expect((await store.append(scope, S, boxEvent("boot_b", 1))).seq).toBe(3);
    expect(rowCount()).toBe(3);
  });

  test("events without a delivery are never deduplicated", async () => {
    const event = { type: "message.user", payload: "same" };
    expect((await store.append(scope, S, event)).duplicate).toBe(false);
    expect((await store.append(scope, S, event)).duplicate).toBe(false);
    expect(await store.lastSeq(scope, S)).toBe(2);
  });

  test("deduplication is per workspace", async () => {
    await store.append(scope, S, boxEvent("boot_a", 1));
    expect(await store.append(other, S, boxEvent("boot_a", 1))).toEqual({
      seq: 1,
      duplicate: false,
    });
    expect(rowCount()).toBe(2);
  });

  test("a delivery already applied to another session is rejected, not acked", async () => {
    await store.append(scope, S, boxEvent("boot_a", 1));
    const error = await rejection(store.append(scope, "ses_2", boxEvent("boot_a", 1)));
    expect(error.code).toBe("event.delivery-conflict");
    expect(await store.lastSeq(scope, "ses_2")).toBe(0);
  });

  test("seq stays gap-free under concurrent appends on one connection", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.append(scope, S, i % 5 === 0 ? boxEvent("boot_a", i + 1) : { type: "x", payload: i }),
      ),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  test("rejects invalid input without writing", async () => {
    const bad: NewEvent[] = [
      { type: "", payload: 1 },
      { type: "x", payload: 1, ts: -1 },
      { type: "x", payload: 1, ts: 1.5 },
      { type: "x", payload: 1, delivery: { bootId: "", deliveryId: 1 } },
      { type: "x", payload: 1, delivery: { bootId: "b", deliveryId: 0 } },
      { type: "x", payload: 1, delivery: { bootId: "b", deliveryId: 1.5 } },
      { type: "x", payload: undefined as unknown as null },
    ];
    for (const event of bad) {
      expect((await rejection(store.append(scope, S, event))).code).toBe("event.invalid");
    }
    expect((await rejection(store.append(scope, "", { type: "x", payload: 1 }))).code).toBe(
      "event.invalid",
    );
    expect(
      (await rejection(store.append({ workspaceId: "" }, S, { type: "x", payload: 1 }))).code,
    ).toBe("event.invalid");
    expect(rowCount()).toBe(0);
  });

  test("a payload that is not JSON rejects as event.invalid, not a raw TypeError", async () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const payloads: unknown[] = [
      10n,
      { n: 10n },
      cycle,
      () => 1,
      { f: () => 1 },
      [Symbol("s")],
      {
        toJSON() {
          throw new Error("boom");
        },
      },
    ];
    for (const payload of payloads) {
      const error = await rejection(
        store.append(scope, S, { type: "x", payload: payload as NewEvent["payload"] }),
      );
      expect(error.code).toBe("event.invalid");
      expect(error.owner).toBe("hub");
    }
    expect(rowCount()).toBe(0);
  });

  test("caps the serialized payload at MAX_EVENT_PAYLOAD_BYTES", async () => {
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(4 * 1024 * 1024);
    // JSON.stringify of a string adds two quote bytes.
    const atCap = "a".repeat(MAX_EVENT_PAYLOAD_BYTES - 2);
    expect(await store.append(scope, S, { type: "x", payload: atCap })).toEqual({
      seq: 1,
      duplicate: false,
    });
    const overCap = `${atCap}a`;
    expect((await rejection(store.append(scope, S, { type: "x", payload: overCap }))).code).toBe(
      "event.invalid",
    );
    // The cap is in UTF-8 bytes, not characters: "é" is two bytes.
    const multiByte = "é".repeat(MAX_EVENT_PAYLOAD_BYTES / 2);
    expect((await rejection(store.append(scope, S, { type: "x", payload: multiByte }))).code).toBe(
      "event.invalid",
    );
    expect(rowCount()).toBe(1);
    const page = await store.read(scope, S, 0, 10);
    expect(page.events[0]?.payload).toBe(atCap);
  });

  test("a failed write rejects with a hub-owned error and writes nothing", async () => {
    await store.append(scope, S, { type: "x", payload: 1 });
    db.run(
      "CREATE TEMP TRIGGER event_broken BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const error = await rejection(store.append(scope, S, boxEvent("boot_a", 1)));
    expect(error.owner).toBe("hub");
    expect(error.code).toBe("event.write-failed");
    db.run("DROP TRIGGER temp.event_broken");
    expect(await store.lastSeq(scope, S)).toBe(1);
    // The failed delivery was not recorded, so its redelivery applies normally.
    expect(await store.append(scope, S, boxEvent("boot_a", 1))).toEqual({
      seq: 2,
      duplicate: false,
    });
  });

  test("UPDATE and DELETE on event fail in the database", async () => {
    await store.append(scope, S, { type: "x", payload: 1 });
    expect(() => db.run("UPDATE event SET type = 'y'")).toThrow(/event is append-only/);
    expect(() => db.run("DELETE FROM event")).toThrow(/event is append-only/);
    expect(rowCount()).toBe(1);
  });
});

describe("read", () => {
  async function fill(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await store.append(scope, S, { type: "x", payload: i });
    }
  }

  test("pages through the log without skipping or repeating", async () => {
    await fill(25);
    await store.append(scope, "ses_2", { type: "x", payload: "elsewhere" });
    const seen: number[] = [];
    const pages: { cursor: number; hasMore: boolean; size: number }[] = [];
    let cursor = 0;
    for (;;) {
      const page = await store.read(scope, S, cursor, 10);
      pages.push({ cursor: page.cursor, hasMore: page.hasMore, size: page.events.length });
      seen.push(...page.events.map((e) => e.seq));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(pages).toEqual([
      { cursor: 10, hasMore: true, size: 10 },
      { cursor: 20, hasMore: true, size: 10 },
      { cursor: 25, hasMore: false, size: 5 },
    ]);
  });

  test("an exactly full last page reports no more", async () => {
    await fill(10);
    expect((await store.read(scope, S, 0, 10)).hasMore).toBe(false);
    expect((await store.read(scope, S, 0, 9)).hasMore).toBe(true);
  });

  test("an empty page keeps the cursor and picks up later appends", async () => {
    await fill(3);
    expect(await store.read(scope, S, 3, 10)).toEqual({ events: [], cursor: 3, hasMore: false });
    await store.append(scope, S, { type: "x", payload: "late" });
    const page = await store.read(scope, S, 3, 10);
    expect(page.events.map((e) => e.seq)).toEqual([4]);
    expect(page.cursor).toBe(4);
  });

  test("another workspace's session reads as empty", async () => {
    await fill(3);
    expect(await store.read(other, S, 0, 10)).toEqual({ events: [], cursor: 0, hasMore: false });
    expect(await store.lastSeq(other, S)).toBe(0);
    expect((await store.append(other, S, { type: "x", payload: 1 })).seq).toBe(1);
    expect(await store.lastSeq(scope, S)).toBe(3);
  });

  test("caps the page size", async () => {
    for (let i = 0; i < MAX_READ_LIMIT + 1; i++) {
      await store.append(scope, S, { type: "x", payload: i });
    }
    const page = await store.read(scope, S, 0, MAX_READ_LIMIT * 10);
    expect(page.events.length).toBe(MAX_READ_LIMIT);
    expect(page.hasMore).toBe(true);
  });

  test("rejects a bad cursor or limit", async () => {
    for (const [after, limit] of [
      [-1, 10],
      [0.5, 10],
      [0, 0],
      [0, -3],
      [0, 2.5],
      [0, Number.NaN],
    ] as const) {
      expect((await rejection(store.read(scope, S, after, limit))).code).toBe("event.invalid");
    }
  });
});

describe("concurrency across processes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hearth-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("seq is gap-free and unique when several hub connections append at once", async () => {
    const path = join(dir, "hub.db");
    openDatabase(path).close();
    const writers = 4;
    const perWriter = 40;
    const worker = join(import.meta.dir, "testdata", "append-worker.ts");
    const children = Array.from({ length: writers }, (_, w) =>
      Bun.spawn([process.execPath, worker, path, S, String(perWriter), `w${w}`], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputs = await Promise.all(
      children.map(async (child) => {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        return JSON.parse(out) as number[];
      }),
    );
    for (const seqs of outputs) {
      // Each writer sees its own appends in increasing order.
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    }
    const all = outputs.flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: writers * perWriter }, (_, i) => i + 1));

    const check = openDatabase(path);
    const reader = new SqliteEventStore(check);
    const page = await reader.read(scope, S, 0, MAX_READ_LIMIT);
    expect(page.events.map((e) => e.seq)).toEqual(all);
    check.close();
  }, 30_000);
});
