/**
 * The desktop lock (decision 0033) with a fake clock, authorizer, sessions and
 * event log: who may take it, the lease and its timeout, the record written
 * before each change, and the check the agent's tools use.
 */

import { describe, expect, test } from "bun:test";
import {
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  LOCAL_PRINCIPAL,
  type Principal,
} from "@hearth/core";
import { DESKTOP_LOCK_EVENT, DesktopLocks, USER_IN_CONTROL } from "./lock";

const OTHER: Principal = { ...LOCAL_PRINCIPAL, id: "usr_other" };
const TTL = 1_000;

function setup(options: { allow?: (action: string) => boolean; failEvents?: boolean } = {}) {
  const clock = { now: 10_000 };
  const calls: string[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const states = new Map<string, string>([["ses_1", "idle"]]);
  const authorizer: Authorizer = {
    async authorize(principal, action, resource) {
      calls.push(`authorize ${principal.id} ${action} ${resource.workspaceId}/${resource.id}`);
      return (options.allow ?? (() => true))(action)
        ? { allowed: true, policy: "test" }
        : { allowed: false, policy: "test", reason: "no" };
    },
  };
  const fail = { events: options.failEvents === true };
  const locks = new DesktopLocks({
    authorizer,
    sessions: {
      scope: { workspaceId: DEFAULT_WORKSPACE_ID },
      async get(_p, id) {
        calls.push(`get ${id}`);
        const state = states.get(id);
        if (state === undefined) {
          throw new HearthError(`no session ${id}`, {
            owner: "user",
            disposition: "give-up",
            code: "session.not-found",
          });
        }
        return { id, state } as never;
      },
    },
    events: {
      async append(_scope, _id, event) {
        if (fail.events) throw new Error("disk full");
        events.push({ type: event.type, payload: event.payload as Record<string, unknown> });
        return { seq: events.length, duplicate: false };
      },
    },
    ttlMs: TTL,
    now: () => clock.now,
    log: () => undefined,
  });
  const actions = () => events.map((e) => e.payload["action"]);
  return { clock, calls, events, states, locks, fail, actions };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof HearthError ? error.code : undefined;
}

describe("DesktopLocks: acquire and release", () => {
  test("acquire authorizes desktop.control first, records, then holds", async () => {
    const t = setup();
    expect(t.locks.isDesktopLocked("ses_1")).toBe(false);
    const view = await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    expect(t.calls).toEqual([
      `authorize ${LOCAL_PRINCIPAL.id} desktop.control ${DEFAULT_WORKSPACE_ID}/ses_1`,
      "get ses_1",
    ]);
    expect(view).toEqual({
      held: true,
      mine: true,
      holder: { kind: "person", principalId: LOCAL_PRINCIPAL.id },
      expiresAt: 10_000 + TTL,
    });
    expect(t.events).toEqual([
      {
        type: DESKTOP_LOCK_EVENT,
        payload: {
          action: "acquired",
          holder: { kind: "person", principalId: LOCAL_PRINCIPAL.id },
          expiresAt: 10_000 + TTL,
        },
      },
    ]);
    expect(t.locks.isDesktopLocked("ses_1")).toBe(true);
    expect(t.locks.isDesktopLocked("ses_2")).toBe(false);
  });

  test("first come, first served: another principal is refused with desktop.locked", async () => {
    const t = setup();
    await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    expect(await codeOf(t.locks.acquire(OTHER, "ses_1"))).toBe("desktop.locked");
    expect(await codeOf(t.locks.release(OTHER, "ses_1"))).toBe("desktop.locked");
    expect(t.locks.holder("ses_1")?.principalId).toBe(LOCAL_PRINCIPAL.id);
    const seen = await t.locks.state(OTHER, "ses_1");
    expect(seen.held).toBe(true);
    expect(seen.mine).toBe(false);
    expect(t.actions()).toEqual(["acquired"]);
  });

  test("taking a lock one holds renews it without a second record", async () => {
    const t = setup();
    await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    t.clock.now += TTL - 1;
    const view = await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    expect(view.expiresAt).toBe(t.clock.now + TTL);
    expect(t.actions()).toEqual(["acquired"]);
  });

  test("release records and frees; releasing a free lock changes nothing", async () => {
    const t = setup();
    await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    const view = await t.locks.release(LOCAL_PRINCIPAL, "ses_1");
    expect(view).toEqual({ held: false, mine: false, holder: null, expiresAt: null });
    expect(t.locks.isDesktopLocked("ses_1")).toBe(false);
    await t.locks.release(LOCAL_PRINCIPAL, "ses_1");
    expect(t.actions()).toEqual(["acquired", "released"]);
    // Free again: another principal may take it now.
    expect((await t.locks.acquire(OTHER, "ses_1")).mine).toBe(true);
  });

  test("an event that cannot be written grants nothing", async () => {
    const t = setup({ failEvents: true });
    await expect(t.locks.acquire(LOCAL_PRINCIPAL, "ses_1")).rejects.toThrow("disk full");
    expect(t.locks.isDesktopLocked("ses_1")).toBe(false);
    expect(t.locks.allowsInput("ses_1", LOCAL_PRINCIPAL.id)).toBe(false);
  });

  test("an archived or failed session cannot be taken over", async () => {
    const t = setup();
    for (const state of ["archived", "failed"]) {
      t.states.set("ses_1", state);
      expect(await codeOf(t.locks.acquire(LOCAL_PRINCIPAL, "ses_1"))).toBe("session.unavailable");
    }
    expect(t.events).toEqual([]);
  });

  test("an unknown session is not-found to a caller who may act", async () => {
    const t = setup();
    expect(await codeOf(t.locks.acquire(LOCAL_PRINCIPAL, "ses_nope"))).toBe("session.not-found");
    expect(await codeOf(t.locks.release(LOCAL_PRINCIPAL, "ses_nope"))).toBe("session.not-found");
    expect(await codeOf(t.locks.state(LOCAL_PRINCIPAL, "ses_nope"))).toBe("session.not-found");
  });

  test("a refused caller gets authz.denied before any session is read, known id or not", async () => {
    const t = setup({ allow: (action) => action !== "desktop.control" });
    for (const id of ["ses_1", "ses_nope"]) {
      expect(await codeOf(t.locks.acquire(LOCAL_PRINCIPAL, id))).toBe("authz.denied");
      expect(await codeOf(t.locks.release(LOCAL_PRINCIPAL, id))).toBe("authz.denied");
    }
    expect(t.calls.filter((c) => c.startsWith("get"))).toEqual([]);
    expect(t.events).toEqual([]);
    expect(t.locks.isDesktopLocked("ses_1")).toBe(false);
  });

  test("reading the lock is desktop.view", async () => {
    const t = setup({ allow: (action) => action !== "desktop.view" });
    expect(await codeOf(t.locks.state(LOCAL_PRINCIPAL, "ses_1"))).toBe("authz.denied");
    expect(t.calls).toEqual([
      `authorize ${LOCAL_PRINCIPAL.id} desktop.view ${DEFAULT_WORKSPACE_ID}/ses_1`,
    ]);
  });
});

describe("DesktopLocks: the lease", () => {
  test("a lease nobody renews lapses exactly at its expiry", async () => {
    const t = setup();
    await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    t.clock.now += TTL - 1;
    expect(t.locks.isDesktopLocked("ses_1")).toBe(true);
    t.clock.now += 1;
    expect(t.locks.isDesktopLocked("ses_1")).toBe(false);
    expect(t.locks.allowsInput("ses_1", LOCAL_PRINCIPAL.id)).toBe(false);
    await Bun.sleep(0);
    expect(t.actions()).toEqual(["acquired", "expired"]);
  });

  test("input from the holder renews the lease; input from anyone else does not", async () => {
    const t = setup();
    await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    t.clock.now += TTL - 1;
    expect(t.locks.allowsInput("ses_1", OTHER.id)).toBe(false);
    expect(t.locks.allowsInput("ses_1", LOCAL_PRINCIPAL.id)).toBe(true);
    t.clock.now += TTL - 1;
    expect(t.locks.isDesktopLocked("ses_1")).toBe(true);
    t.clock.now += 1;
    expect(t.locks.isDesktopLocked("ses_1")).toBe(false);
  });

  test("the timer expires an idle lease and records it, without anyone asking", async () => {
    const clock = { now: 0 };
    const events: unknown[] = [];
    const locks = new DesktopLocks({
      authorizer: { authorize: async () => ({ allowed: true, policy: "test" }) },
      sessions: {
        scope: { workspaceId: DEFAULT_WORKSPACE_ID },
        get: async (_p, id) => ({ id, state: "idle" }) as never,
      },
      events: {
        append: async (_s, _id, event) => {
          events.push(event.payload);
          return { seq: events.length, duplicate: false };
        },
      },
      ttlMs: 30,
      now: () => clock.now,
      log: () => undefined,
    });
    await locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    // Renewed just before the first timer fires: it re-arms instead of expiring.
    clock.now = 20;
    expect(locks.allowsInput("ses_1", LOCAL_PRINCIPAL.id)).toBe(true);
    clock.now = 35;
    await Bun.sleep(45);
    expect(events.map((e) => (e as { action: string }).action)).toEqual(["acquired"]);
    clock.now = 50;
    await Bun.sleep(40);
    expect(events.map((e) => (e as { action: string }).action)).toEqual(["acquired", "expired"]);
    locks.shutdown();
  });

  test("viewerLeft releases only the holder's lock", async () => {
    const t = setup();
    await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    await t.locks.viewerLeft("ses_1", OTHER.id);
    expect(t.locks.isDesktopLocked("ses_1")).toBe(true);
    await t.locks.viewerLeft("ses_1", LOCAL_PRINCIPAL.id);
    expect(t.locks.isDesktopLocked("ses_1")).toBe(false);
    expect(t.actions()).toEqual(["acquired", "viewer-left"]);
  });
});

describe("DesktopLocks: the check the agent's tools use", () => {
  test("assertUnlocked refuses with desktop.locked, 'user is in control', while a person holds it", async () => {
    const t = setup();
    expect(() => t.locks.assertUnlocked("ses_1")).not.toThrow();
    await t.locks.acquire(LOCAL_PRINCIPAL, "ses_1");
    let error: unknown;
    try {
      t.locks.assertUnlocked("ses_1");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("desktop.locked");
    expect((error as HearthError).message).toBe(USER_IN_CONTROL);
    await t.locks.release(LOCAL_PRINCIPAL, "ses_1");
    expect(() => t.locks.assertUnlocked("ses_1")).not.toThrow();
  });
});
