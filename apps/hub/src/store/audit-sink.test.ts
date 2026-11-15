import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AllowAllAuthorizer,
  type AuditRecord,
  HearthError,
  LOCAL_PRINCIPAL,
  withAudit,
} from "@hearth/core";
import { SqliteAuditSink } from "./audit-sink";
import { openDatabase } from "./database";

const record: AuditRecord = {
  workspaceId: "ws_default",
  principalId: "pr_local",
  principalKind: "user",
  action: "desktop.takeover",
  resource: { workspaceId: "ws_default", type: "box", id: "box_1" },
  at: 1_700_000_000_000,
  detail: { reason: "manual", secret: "ref:env:TOKEN" },
};

let db: Database;
let sink: SqliteAuditSink;
beforeEach(() => {
  db = openDatabase(":memory:");
  sink = new SqliteAuditSink(db);
});
afterEach(() => {
  db.close();
});

function count(): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM audit").get()?.n ?? -1;
}

/** Makes every audit INSERT fail, as a full disk or a broken database would. */
function breakAuditWrites(): void {
  db.run(
    "CREATE TEMP TRIGGER audit_broken BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
}

describe("SqliteAuditSink", () => {
  test("writes every field of the record", async () => {
    await sink.write(record);
    await sink.write({
      ...record,
      action: "session.create",
      resource: { workspaceId: "ws_other", type: "session" },
      decision: { allowed: false, policy: "allow-all", reason: "resource is in another workspace" },
    });
    const { detail: _detail, ...withoutDetail } = record;
    await sink.write({ ...withoutDetail, decision: { allowed: true, policy: "allow-all" } });
    const rows = db.query("SELECT * FROM audit ORDER BY id").all();
    expect(rows).toEqual([
      {
        id: 1,
        workspace_id: "ws_default",
        at: record.at,
        principal_id: "pr_local",
        principal_kind: "user",
        action: "desktop.takeover",
        resource_workspace_id: "ws_default",
        resource_type: "box",
        resource_id: "box_1",
        allowed: null,
        policy: null,
        reason: null,
        detail_json: JSON.stringify(record.detail),
      },
      {
        id: 2,
        workspace_id: "ws_default",
        at: record.at,
        principal_id: "pr_local",
        principal_kind: "user",
        action: "session.create",
        resource_workspace_id: "ws_other",
        resource_type: "session",
        resource_id: null,
        allowed: 0,
        policy: "allow-all",
        reason: "resource is in another workspace",
        detail_json: JSON.stringify(record.detail),
      },
      {
        id: 3,
        workspace_id: "ws_default",
        at: record.at,
        principal_id: "pr_local",
        principal_kind: "user",
        action: "desktop.takeover",
        resource_workspace_id: "ws_default",
        resource_type: "box",
        resource_id: "box_1",
        allowed: 1,
        policy: "allow-all",
        reason: null,
        detail_json: null,
      },
    ]);
  });

  test("UPDATE on audit fails in the database", async () => {
    await sink.write(record);
    expect(() => db.run("UPDATE audit SET action = 'forged'")).toThrow(/audit is append-only/);
    expect(db.query<{ action: string }, []>("SELECT action FROM audit").get()?.action).toBe(
      "desktop.takeover",
    );
  });

  test("DELETE on audit fails in the database", async () => {
    await sink.write(record);
    expect(() => db.run("DELETE FROM audit")).toThrow(/audit is append-only/);
    expect(count()).toBe(1);
  });

  test("a failed write rejects with a classified error", async () => {
    breakAuditWrites();
    const error = await sink.write(record).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).owner).toBe("hub");
    expect((error as HearthError).code).toBe("audit.write-failed");
  });
});

describe("withAudit with the SQLite sink", () => {
  test("writes the record before it runs the action", async () => {
    let seenBeforeAction = -1;
    const result = await withAudit(sink, record, () => {
      seenBeforeAction = count();
      return "done";
    });
    expect(result).toBe("done");
    expect(seenBeforeAction).toBe(1);
  });

  test("does not act when the audit write fails", async () => {
    breakAuditWrites();
    let acted = false;
    const error = await withAudit(sink, record, () => {
      acted = true;
    }).catch((e: unknown) => e);
    expect(acted).toBe(false);
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("audit.write-failed");
    expect(count()).toBe(0);
  });

  test("the authorizer audits to SQLite and denies when it cannot", async () => {
    const authorizer = new AllowAllAuthorizer({ audit: sink, now: () => 42 });
    const resource = { workspaceId: "ws_default", type: "session" };
    expect(await authorizer.authorize(LOCAL_PRINCIPAL, "session.create", resource)).toEqual({
      allowed: true,
      policy: "allow-all",
    });
    expect(count()).toBe(1);
    breakAuditWrites();
    expect(await authorizer.authorize(LOCAL_PRINCIPAL, "session.create", resource)).toEqual({
      allowed: false,
      policy: "allow-all",
      reason: "audit unavailable",
    });
  });
});
