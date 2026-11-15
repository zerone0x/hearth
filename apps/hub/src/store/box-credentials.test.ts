import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BOX_CREDENTIAL_PREFIX, JOIN_TOKEN_PREFIX, JOIN_TOKEN_TTL_MS } from "../box/credentials";
import { SqliteBoxCredentialStore } from "./box-credentials";
import { openDatabase } from "./database";

const scope = { workspaceId: "ws_default" };
let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function store(now: () => number = Date.now) {
  db = openDatabase(":memory:");
  return new SqliteBoxCredentialStore(db, { now });
}

describe("SqliteBoxCredentialStore", () => {
  test("a token is redeemed once for a credential bound to its box and session", async () => {
    const s = store();
    const { token, expiresAt } = await s.issueJoinToken(scope, "box_1", "ses_1");
    expect(token.startsWith(JOIN_TOKEN_PREFIX)).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now());
    const outcome = await s.redeemJoinToken("box_1", token);
    if (outcome.kind !== "issued") throw new Error(`expected issued, got ${outcome.reason}`);
    expect(outcome.credential.startsWith(BOX_CREDENTIAL_PREFIX)).toBe(true);
    expect(outcome.binding).toEqual({
      workspaceId: "ws_default",
      boxId: "box_1",
      sessionId: "ses_1",
    });
    expect(await s.verifyCredential("box_1", outcome.credential)).toEqual(outcome.binding);
    expect(await s.redeemJoinToken("box_1", token)).toEqual({ kind: "rejected", reason: "used" });
  });

  test("stores only hashes", async () => {
    const s = store();
    const { token } = await s.issueJoinToken(scope, "box_1", "ses_1");
    const outcome = await s.redeemJoinToken("box_1", token);
    if (outcome.kind !== "issued") throw new Error("expected issued");
    const dump = JSON.stringify([
      db?.query("SELECT * FROM box_join_token").all(),
      db?.query("SELECT * FROM box_credential").all(),
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(outcome.credential);
    expect(dump).toContain(createHash("sha256").update(token).digest("hex"));
  });

  test("an expired token is rejected", async () => {
    let now = 1_000;
    const s = store(() => now);
    const { token } = await s.issueJoinToken(scope, "box_1", "ses_1");
    now += JOIN_TOKEN_TTL_MS;
    expect(await s.redeemJoinToken("box_1", token)).toEqual({
      kind: "rejected",
      reason: "expired",
    });
  });

  test("a token for another box, or an unknown token, is rejected", async () => {
    const s = store();
    const { token } = await s.issueJoinToken(scope, "box_1", "ses_1");
    expect(await s.redeemJoinToken("box_2", token)).toEqual({
      kind: "rejected",
      reason: "wrong-box",
    });
    expect(await s.redeemJoinToken("box_1", `${JOIN_TOKEN_PREFIX}nope`)).toEqual({
      kind: "rejected",
      reason: "unknown",
    });
    expect(await s.redeemJoinToken("box_1", "not-a-token")).toEqual({
      kind: "rejected",
      reason: "unknown",
    });
    // The failed tries did not spend it.
    expect((await s.redeemJoinToken("box_1", token)).kind).toBe("issued");
  });

  test("a new boot's credential revokes the previous one", async () => {
    const s = store();
    const first = await s.redeemJoinToken(
      "box_1",
      (await s.issueJoinToken(scope, "box_1", "ses_1")).token,
    );
    const second = await s.redeemJoinToken(
      "box_1",
      (await s.issueJoinToken(scope, "box_1", "ses_1")).token,
    );
    if (first.kind !== "issued" || second.kind !== "issued") throw new Error("expected issued");
    expect(await s.verifyCredential("box_1", first.credential)).toBeUndefined();
    expect(await s.verifyCredential("box_1", second.credential)).toBeDefined();
    expect(await s.verifyCredential("box_2", second.credential)).toBeUndefined();
    expect(await s.verifyCredential("box_1", "garbage")).toBeUndefined();
  });

  test("rejects a TTL that is not a positive integer", async () => {
    const s = store();
    expect(s.issueJoinToken(scope, "box_1", "ses_1", 0)).rejects.toMatchObject({
      code: "box.invalid-ttl",
    });
  });
});
