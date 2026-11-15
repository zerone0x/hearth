import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AllowAllAuthorizer,
  type Authorizer,
  type BoxInfo,
  type BoxSpec,
  DEFAULT_WORKSPACE_ID,
  HearthError,
  LOCAL_PRINCIPAL,
  type StopOutcome,
} from "@hearth/core";
import { openDatabase, SqliteAuditSink, SqliteEventStore, SqliteSessionStore } from "../store";
import { classifyExit } from "./exits";
import { type SessionBoxes, SessionManager, type SessionManagerOptions } from "./manager";
import { canTransition, SESSION_STATES, type SessionState, TRANSITIONS } from "./states";

const scope = { workspaceId: DEFAULT_WORKSPACE_ID };

type Plan = "connect" | "hang" | { readonly exit: number };

/** A provider plus connection table in memory. Each start follows the next `plan` entry. */
class FakeBoxes implements SessionBoxes {
  readonly providerName = "fake";
  readonly calls: string[] = [];
  readonly plan: Plan[] = [];
  readonly connected = new Set<string>();
  readonly exited = new Map<string, number>();
  readonly running = new Set<string>();
  stopGate: Promise<void> | undefined;
  startError: HearthError | undefined;
  readonly #waiters = new Map<string, Set<() => void>>();

  async start(_principal: unknown, spec: BoxSpec): Promise<BoxInfo> {
    this.calls.push(`start ${spec.boxId}`);
    if (this.startError !== undefined) throw this.startError;
    this.running.add(spec.boxId);
    const step = this.plan.shift() ?? "connect";
    if (step === "connect") setTimeout(() => this.connect(spec.boxId), 1);
    else if (step !== "hang") setTimeout(() => this.exit(spec.boxId, step.exit), 1);
    return this.#info(spec.boxId, "running");
  }

  async stop(boxId: string): Promise<StopOutcome> {
    this.calls.push(`stop ${boxId}`);
    if (this.stopGate !== undefined) await this.stopGate;
    const was = this.running.has(boxId) || this.exited.has(boxId);
    this.running.delete(boxId);
    this.exited.delete(boxId);
    this.connected.delete(boxId);
    return was ? "stopped" : "not-found";
  }

  async attach(boxId: string): Promise<BoxInfo | undefined> {
    const code = this.exited.get(boxId);
    if (code !== undefined) return { ...this.#info(boxId, "exited"), exitCode: code };
    return this.running.has(boxId) ? this.#info(boxId, "running") : undefined;
  }

  isConnected(boxId: string): boolean {
    return this.connected.has(boxId);
  }

  waitForBox(boxId: string, deadlineMs: number): Promise<void> {
    if (this.connected.has(boxId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const set = this.#waiters.get(boxId) ?? new Set();
      this.#waiters.set(boxId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        set.delete(done);
        reject(new Error("deadline"));
      }, deadlineMs);
      set.add(done);
    });
  }

  connect(boxId: string): void {
    this.connected.add(boxId);
    for (const wake of [...(this.#waiters.get(boxId) ?? [])]) wake();
  }

  exit(boxId: string, code: number): void {
    this.connected.delete(boxId);
    this.running.delete(boxId);
    this.exited.set(boxId, code);
  }

  #info(boxId: string, state: BoxInfo["state"]): BoxInfo {
    return {
      boxId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      sessionId: "",
      state,
      image: "img",
      volumeRef: `vol-${boxId}`,
      labels: {},
      createdAt: 0,
    };
  }
}

const dirs: string[] = [];
const managers: SessionManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  db: Database;
  boxes: FakeBoxes;
  events: SqliteEventStore;
  store: SqliteSessionStore;
  manager: SessionManager;
  make(overrides?: Partial<SessionManagerOptions>): SessionManager;
}

function rig(overrides: Partial<SessionManagerOptions> = {}, dbPath?: string): Rig {
  let path = dbPath;
  if (path === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    path = join(dir, "hub.db");
  }
  const db = openDatabase(path);
  const events = new SqliteEventStore(db);
  const store = new SqliteSessionStore(db);
  const boxes = new FakeBoxes();
  const make = (more: Partial<SessionManagerOptions> = {}) => {
    const m = new SessionManager({
      authorizer: new AllowAllAuthorizer({ audit: new SqliteAuditSink(db) }),
      events,
      store,
      boxes,
      image: "img",
      idleMs: 60_000,
      exitPollMs: 2,
      connectDeadlineMs: 200,
      superviseIntervalMs: 0,
      log: () => {},
      ...overrides,
      ...more,
    });
    managers.push(m);
    return m;
  };
  return { db, boxes, events, store, manager: make(), make };
}

async function eventsOf(r: Rig, sessionId: string, type?: string) {
  const page = await r.events.read(scope, sessionId, 0, 1000);
  return page.events.filter((e) => type === undefined || e.type === type);
}

async function statesOf(r: Rig, sessionId: string): Promise<string[]> {
  return (await eventsOf(r, sessionId, "session.state")).map(
    (e) => (e.payload as { to: string }).to,
  );
}

function auditActions(db: Database, sessionId: string): string[] {
  return db
    .query<{ action: string }, [string]>(
      "SELECT action FROM audit WHERE resource_type = 'session' AND resource_id = ? ORDER BY id",
    )
    .all(sessionId)
    .map((r) => r.action);
}

async function until(cond: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

describe("state machine table", () => {
  test("allows exactly the documented transitions", () => {
    const allowed = SESSION_STATES.flatMap((from) =>
      SESSION_STATES.filter((to) => canTransition(from, to)).map((to) => `${from}>${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        "creating>idle",
        "creating>failed",
        "creating>archived",
        "idle>running",
        "idle>waking",
        "idle>hibernated",
        "idle>failed",
        "idle>archived",
        "running>idle",
        "running>waking",
        "running>failed",
        "running>archived",
        "waking>running",
        "waking>idle",
        "waking>hibernated",
        "waking>failed",
        "waking>archived",
        "hibernated>waking",
        "hibernated>failed",
        "hibernated>archived",
        "failed>archived",
      ].sort(),
    );
    expect(TRANSITIONS.archived).toEqual([]);
    for (const s of SESSION_STATES) expect(canTransition(s, s as SessionState)).toBe(false);
  });
});

describe("exit classification", () => {
  test("2 gives up, 3 relaunches, anything else is a crash", () => {
    expect(classifyExit(2)).toEqual({
      cause: "config",
      disposition: "give-up",
      code: "box.config",
    });
    expect(classifyExit(3)).toEqual({
      cause: "credential-lost",
      disposition: "retry",
      code: "box.credential-lost",
    });
    for (const code of [0, 1, 4, 137, 143, undefined]) {
      expect(classifyExit(code)).toEqual({
        cause: "crash",
        disposition: "retry-cold",
        code: "box.crashed",
      });
    }
  });
});

describe("SessionManager", () => {
  test("create is lazy: creating → idle, no box, every transition audited and logged", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL, { title: "t" });
    expect(s.state).toBe("idle");
    expect(s.boxId).toMatch(/^bx_/);
    expect(r.boxes.calls).toEqual([]);
    expect(await statesOf(r, s.id)).toEqual(["creating", "idle"]);
    expect(auditActions(r.db, s.id)).toEqual(["session.create", "session.idle"]);
    expect((await r.manager.list(LOCAL_PRINCIPAL)).map((x) => x.id)).toEqual([s.id]);
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("idle");
  });

  test("ensureBox starts the box once, even for concurrent tool calls, and release goes idle", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    const [a, b] = await Promise.all([r.manager.ensureBox(s.id), r.manager.ensureBox(s.id)]);
    expect(a.boxId).toBe(s.boxId as string);
    expect(r.boxes.calls.filter((c) => c.startsWith("start"))).toHaveLength(1);
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("running");
    a.release();
    a.release();
    await Bun.sleep(5);
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("running");
    b.release();
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "idle");
    expect(await statesOf(r, s.id)).toEqual(["creating", "idle", "waking", "running", "idle"]);
    expect(auditActions(r.db, s.id)).toContain("session.wake");
    const ops = r.store.operations(scope, s.id);
    expect(ops.map((o) => `${o.kind}:${o.status}`)).toEqual(["wake:done"]);
  });

  test("hibernates after the idle time, never while a tool call is in flight, and wakes on demand", async () => {
    const r = rig({ idleMs: 30 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    const lease = await r.manager.ensureBox(s.id);
    await Bun.sleep(80);
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("running");
    expect(r.boxes.calls.filter((c) => c.startsWith("stop"))).toHaveLength(1); // the pre-start stop
    lease.release();
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "hibernated");
    expect(r.boxes.running.has(s.boxId as string)).toBe(false);
    expect(r.store.getBox(scope, s.boxId as string)?.state).toBe("stopped");

    const again = await r.manager.ensureBox(s.id);
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("running");
    again.release();
    expect(await statesOf(r, s.id)).toEqual([
      "creating",
      "idle",
      "waking",
      "running",
      "idle",
      "hibernated",
      "waking",
      "running",
    ]);
    expect(r.store.operations(scope, s.id).map((o) => `${o.kind}:${o.status}`)).toEqual([
      "wake:done",
      "hibernate:done",
      "wake:done",
    ]);
  });

  test("a wake waits for a hibernate in flight", async () => {
    const r = rig({ idleMs: 5 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    (await r.manager.ensureBox(s.id)).release();
    let open: () => void = () => {};
    r.boxes.stopGate = new Promise((resolve) => {
      open = resolve;
    });
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "hibernated");
    const pending = r.manager.ensureBox(s.id);
    await Bun.sleep(20);
    const startsBefore = r.boxes.calls.filter((c) => c.startsWith("start")).length;
    expect(startsBefore).toBe(1);
    r.boxes.stopGate = undefined;
    open();
    const lease = await pending;
    lease.release();
    const tail = r.boxes.calls.slice(-3);
    expect(tail[0]).toMatch(/^stop/);
    expect(tail.at(-1)).toMatch(/^start/);
  });

  test("an exit 2 while booting gives up visibly: box.failed and session failed", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    r.boxes.plan.push({ exit: 2 });
    const err = await r.manager.ensureBox(s.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HearthError);
    expect((err as HearthError).code).toBe("box.config");
    expect((err as HearthError).disposition).toBe("give-up");
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("failed");
    const failed = await eventsOf(r, s.id, "box.failed");
    expect(failed.map((e) => e.payload)).toMatchObject([
      { cause: "config", code: "box.config", exitCode: 2 },
    ]);
    expect(await eventsOf(r, s.id, "box.restarted")).toEqual([]);
    expect(r.boxes.calls.filter((c) => c.startsWith("start"))).toHaveLength(1);
    const again = await r.manager.ensureBox(s.id).catch((e: unknown) => e);
    expect((again as HearthError).code).toBe("session.unavailable");
  });

  test("an exit 3 relaunches with a fresh token and says so", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    r.boxes.plan.push({ exit: 3 }, "connect");
    const lease = await r.manager.ensureBox(s.id);
    lease.release();
    expect(r.boxes.calls.filter((c) => c.startsWith("start"))).toHaveLength(2);
    const restarted = await eventsOf(r, s.id, "box.restarted");
    expect(restarted.map((e) => e.payload)).toMatchObject([
      {
        cause: "credential-lost",
        code: "box.credential-lost",
        exitCode: 3,
        attempt: 1,
        maxAttempts: 3,
      },
    ]);
  });

  test("relaunches are bounded: the attempt after the last one gives up", async () => {
    const r = rig({ maxCredentialRelaunches: 2 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    r.boxes.plan.push({ exit: 3 }, { exit: 3 }, { exit: 3 }, "connect");
    const err = (await r.manager.ensureBox(s.id).catch((e: unknown) => e)) as HearthError;
    expect(err.code).toBe("box.credential-lost");
    expect(err.disposition).toBe("give-up");
    expect(r.boxes.calls.filter((c) => c.startsWith("start"))).toHaveLength(3);
    expect(
      (await eventsOf(r, s.id, "box.restarted")).map(
        (e) => (e.payload as { attempt: number }).attempt,
      ),
    ).toEqual([1, 2]);
    expect(await eventsOf(r, s.id, "box.failed")).toHaveLength(1);
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("failed");
  });

  test("crash retries are bounded separately, and a box that never connects counts as a crash", async () => {
    const r = rig({ maxCrashRetries: 1 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    r.boxes.plan.push({ exit: 3 }, "hang", { exit: 137 });
    const err = (await r.manager.ensureBox(s.id).catch((e: unknown) => e)) as HearthError;
    expect(err.code).toBe("box.crashed");
    const restarted = (await eventsOf(r, s.id, "box.restarted")).map(
      (e) => (e.payload as { cause: string }).cause,
    );
    expect(restarted).toEqual(["credential-lost", "connect-deadline"]);
  });

  test("supervision relaunches a box that crashed while the session was idle", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    (await r.manager.ensureBox(s.id)).release();
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "idle");
    r.boxes.exit(s.boxId as string, 137);
    r.manager.boxClosed(s.boxId as string);
    await until(async () => (await eventsOf(r, s.id, "box.restarted")).length === 1);
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "idle");
    expect(r.boxes.isConnected(s.boxId as string)).toBe(true);
    expect((await eventsOf(r, s.id, "box.restarted"))[0]?.payload).toMatchObject({
      cause: "crash",
      exitCode: 137,
      disposition: "retry-cold",
    });
    expect((await statesOf(r, s.id)).slice(-2)).toEqual(["waking", "idle"]);
  });

  test("supervision gives up on exit 2 of a running box and fails the session", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    const lease = await r.manager.ensureBox(s.id);
    r.boxes.exit(s.boxId as string, 2);
    await r.manager.supervise();
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("failed");
    expect(await eventsOf(r, s.id, "box.failed")).toHaveLength(1);
    lease.release();
  });

  test("a box that stays up past the stable time starts a fresh count", async () => {
    let now = 1_000;
    const r = rig({ maxCrashRetries: 1, stableMs: 100, now: () => now });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    (await r.manager.ensureBox(s.id)).release();
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "idle");
    for (let i = 0; i < 3; i++) {
      now += 1_000;
      r.boxes.exit(s.boxId as string, 1);
      await r.manager.supervise();
      await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "idle");
    }
    expect(await eventsOf(r, s.id, "box.restarted")).toHaveLength(3);
    expect(await eventsOf(r, s.id, "box.failed")).toHaveLength(0);
  });

  test("a start the provider refuses goes back to hibernated with a visible box.failed", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    r.boxes.startError = new HearthError("no firewall", {
      owner: "box",
      disposition: "give-up",
      code: "box.egress-unfiltered",
    });
    const err = (await r.manager.ensureBox(s.id).catch((e: unknown) => e)) as HearthError;
    expect(err.code).toBe("box.egress-unfiltered");
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("hibernated");
    expect((await eventsOf(r, s.id, "box.failed"))[0]?.payload).toMatchObject({
      cause: "start",
      code: "box.egress-unfiltered",
    });
    r.boxes.startError = undefined;
    (await r.manager.ensureBox(s.id)).release();
  });

  test("a denied transition changes nothing", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    const deny: Authorizer = {
      authorize: async () => ({ allowed: false, policy: "test", reason: "no" }),
    };
    const m = r.make({ authorizer: deny });
    await m.ready;
    const err = (await m.ensureBox(s.id).catch((e: unknown) => e)) as HearthError;
    expect(err.code).toBe("authz.denied");
    expect(r.boxes.calls).toEqual([]);
    expect(r.store.getSession(scope, s.id)?.state).toBe("idle");
    expect(await statesOf(r, s.id)).toEqual(["creating", "idle"]);
  });

  test("illegal transitions are refused: archive twice, tool call on an archived session", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    (await r.manager.ensureBox(s.id)).release();
    const archived = await r.manager.archive(LOCAL_PRINCIPAL, s.id);
    expect(archived.state).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();
    expect(r.boxes.running.has(s.boxId as string)).toBe(false);
    const twice = (await r.manager
      .archive(LOCAL_PRINCIPAL, s.id)
      .catch((e: unknown) => e)) as HearthError;
    expect(twice.code).toBe("session.illegal-transition");
    const tool = (await r.manager.ensureBox(s.id).catch((e: unknown) => e)) as HearthError;
    expect(tool.code).toBe("session.unavailable");
    const missing = (await r.manager
      .get(LOCAL_PRINCIPAL, "se_nope")
      .catch((e: unknown) => e)) as HearthError;
    expect(missing.code).toBe("session.not-found");
  });

  test("a hub restart mid-wake marks the wake interrupted and surfaces it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    const path = join(dir, "hub.db");
    const first = rig({ connectDeadlineMs: 60_000 }, path);
    const s = await first.manager.create(LOCAL_PRINCIPAL);
    first.boxes.plan.push("hang");
    void first.manager.ensureBox(s.id).catch(() => {});
    await until(() => first.store.getSession(scope, s.id)?.state === "waking");
    await until(() => first.store.runningOperations(scope).length === 1);
    first.manager.stop();

    const second = rig({}, path);
    await second.manager.ready;
    expect(second.store.getSession(scope, s.id)?.state).toBe("hibernated");
    expect(second.store.operations(scope, s.id).map((o) => `${o.kind}:${o.status}`)).toEqual([
      "wake:interrupted",
    ]);
    const ops = await eventsOf(second, s.id, "session.operation");
    expect(ops.at(-1)?.payload).toMatchObject({ kind: "wake", outcome: "interrupted" });
    expect((await statesOf(second, s.id)).at(-1)).toBe("hibernated");
    // The next tool call wakes it again, visibly.
    (await second.manager.ensureBox(s.id)).release();
    expect((await statesOf(second, s.id)).slice(-2)).toEqual(["waking", "running"]);
  });

  test("a hub restart turns running sessions idle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    const path = join(dir, "hub.db");
    const first = rig({}, path);
    const s = await first.manager.create(LOCAL_PRINCIPAL);
    await first.manager.ensureBox(s.id);
    first.manager.stop();
    const second = rig({}, path);
    await second.manager.ready;
    expect(second.store.getSession(scope, s.id)?.state).toBe("idle");
    expect((await eventsOf(second, s.id, "session.state")).at(-1)?.payload).toMatchObject({
      from: "running",
      to: "idle",
      reason: "the hub restarted",
    });
  });

  test("without a provider, sessions work and ensureBox says box.no-provider", async () => {
    const r = rig();
    const m = r.make({ boxes: undefined as unknown as SessionBoxes });
    const s = await m.create(LOCAL_PRINCIPAL);
    const err = (await m.ensureBox(s.id).catch((e: unknown) => e)) as HearthError;
    expect(err.code).toBe("box.no-provider");
  });
});
