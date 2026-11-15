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
import { buildTrajectory } from "../obs/trajectory";
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
  attachGate: Promise<void> | undefined;
  startError: HearthError | undefined;
  stopError: HearthError | undefined;
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
    if (this.stopError !== undefined) throw this.stopError;
    const was = this.running.has(boxId) || this.exited.has(boxId);
    this.running.delete(boxId);
    this.exited.delete(boxId);
    this.connected.delete(boxId);
    return was ? "stopped" : "not-found";
  }

  async attach(boxId: string): Promise<BoxInfo | undefined> {
    if (this.attachGate !== undefined) await this.attachGate;
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

/** `shared` keeps the same provider across a hub restart (a second rig on the same file). */
function rig(
  overrides: Partial<SessionManagerOptions> = {},
  dbPath?: string,
  shared?: FakeBoxes,
): Rig {
  let path = dbPath;
  if (path === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    path = join(dir, "hub.db");
  }
  const db = openDatabase(path);
  const events = new SqliteEventStore(db);
  const store = new SqliteSessionStore(db);
  const boxes = shared ?? new FakeBoxes();
  const make = (more: Partial<SessionManagerOptions> = {}) => {
    const m = new SessionManager({
      authorizer: new AllowAllAuthorizer({ audit: new SqliteAuditSink(db) }),
      events,
      store,
      boxes,
      image: "img",
      idleMs: 60_000,
      runningGraceMs: 0,
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

  test("a tool call that arrives after the idle timer fired, before the hibernate ran, keeps the box", async () => {
    const r = rig({ idleMs: 40 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    (await r.manager.ensureBox(s.id)).release();
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "idle");
    await Bun.sleep(2);
    // Hold the session's lifecycle queue with a supervision step stuck in attach,
    // so the hibernate step the idle timer queues cannot run yet.
    let open: () => void = () => {};
    r.boxes.attachGate = new Promise((resolve) => {
      open = resolve;
    });
    const supervising = r.manager.supervise(s.id);
    await Bun.sleep(80); // the idle timer fires and queues the hibernate step
    const stops = () => r.boxes.calls.filter((c) => c.startsWith("stop")).length;
    const stopsBefore = stops();
    const pending = r.manager.ensureBox(s.id); // a tool call is now in flight
    await Bun.sleep(5);
    r.boxes.attachGate = undefined;
    open();
    await supervising;
    const lease = await pending;
    expect(stops()).toBe(stopsBefore);
    expect(r.boxes.calls.filter((c) => c.startsWith("start"))).toHaveLength(1);
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("running");
    expect(await statesOf(r, s.id)).not.toContain("hibernated");
    expect(r.store.operations(scope, s.id).map((o) => o.kind)).toEqual(["wake"]);
    lease.release();
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

  test("the box's life is in the session trajectory: state changes, a relaunch, the wake (decision 0021)", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    r.boxes.plan.push({ exit: 3 }, "connect");
    const lease = await r.manager.ensureBox(s.id);
    lease.release();
    const records = buildTrajectory(await eventsOf(r, s.id), {
      sessionId: s.id,
      versions: { pi: "p", hub: "h" },
    });
    const box = records.filter((x) => x.kind === "box");
    const ops = box.map((x) => x["op"]);
    expect(ops).toContain("session.state");
    expect(ops).toContain("session.operation");
    expect(ops).toContain("box.restarted");
    const restarted = box.find((x) => x["op"] === "box.restarted");
    expect(restarted).toMatchObject({
      box_id: lease.boxId,
      detail: { cause: "credential-lost", exitCode: 3, attempt: 1 },
    });
    expect(box.find((x) => x["op"] === "session.operation" && x["detail"] !== null)).toMatchObject({
      detail: { kind: "wake", outcome: "done", boxId: lease.boxId },
      box_id: lease.boxId,
    });
    // Every state change is there, in order, ending with the box up.
    const states = box.filter((x) => x["op"] === "session.state").map((x) => x["detail"]);
    expect(states.at(0)).toMatchObject({ to: "creating" });
    expect(states.map((d) => (d as { to: string }).to)).toContain("waking");
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

  test("a hibernate starts a fresh relaunch count", async () => {
    const r = rig({ idleMs: 20, maxCrashRetries: 1 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    r.boxes.plan.push({ exit: 137 }, "connect");
    (await r.manager.ensureBox(s.id)).release(); // uses the one crash retry
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "hibernated");
    r.boxes.plan.push({ exit: 137 }, "connect");
    const lease = await r.manager.ensureBox(s.id); // a fresh count: retried, not given up
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("running");
    expect(
      (await eventsOf(r, s.id, "box.restarted")).map(
        (e) => (e.payload as { attempt: number }).attempt,
      ),
    ).toEqual([1, 1]);
    expect(await eventsOf(r, s.id, "box.failed")).toHaveLength(0);
    lease.release();
  });

  test("a tool call queued behind the release of the last one keeps the session running", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    const first = await r.manager.ensureBox(s.id);
    // Hold the lifecycle queue so the release step and the next ensureBox queue up together.
    let open: () => void = () => {};
    r.boxes.attachGate = new Promise((resolve) => {
      open = resolve;
    });
    const supervising = r.manager.supervise(s.id);
    await Bun.sleep(5);
    first.release();
    const pending = r.manager.ensureBox(s.id);
    await Bun.sleep(5);
    r.boxes.attachGate = undefined;
    open();
    await supervising;
    const second = await pending;
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("running");
    expect(await statesOf(r, s.id)).toEqual(["creating", "idle", "waking", "running"]);
    second.release();
    await until(async () => (await r.manager.get(LOCAL_PRINCIPAL, s.id)).state === "idle");
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

  test("fail moves the session to failed through the state machine and stops its box (#43)", async () => {
    const r = rig();
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    const lease = await r.manager.ensureBox(s.id);
    expect(r.boxes.running.has(s.boxId as string)).toBe(true);
    const failed = await r.manager.fail(s.id, "runner failed: boom");
    expect(failed.state).toBe("failed");
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("failed");
    const last = (await eventsOf(r, s.id, "session.state")).at(-1);
    expect(last?.payload).toEqual({ from: "running", to: "failed", reason: "runner failed: boom" });
    expect(auditActions(r.db, s.id)).toContain("session.fail");
    expect(r.boxes.calls).toContain(`stop ${s.boxId}`);
    expect(r.boxes.running.has(s.boxId as string)).toBe(false);
    // The lease of the failed turn ends without moving the session out of failed.
    lease.release();
    await Bun.sleep(5);
    expect((await r.manager.get(LOCAL_PRINCIPAL, s.id)).state).toBe("failed");
    // Failing again is a no-op: one failed transition only.
    await r.manager.fail(s.id, "again");
    expect((await statesOf(r, s.id)).filter((x) => x === "failed")).toHaveLength(1);
    const tool = (await r.manager.ensureBox(s.id).catch((e: unknown) => e)) as HearthError;
    expect(tool.code).toBe("session.unavailable");
    // An archived session cannot fail.
    const other = await r.manager.create(LOCAL_PRINCIPAL);
    await r.manager.archive(LOCAL_PRINCIPAL, other.id);
    const refused = (await r.manager.fail(other.id, "x").catch((e: unknown) => e)) as HearthError;
    expect(refused.code).toBe("session.illegal-transition");
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

  test("a hub restart mid-wake stops the box it started (same provider across the restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    const path = join(dir, "hub.db");
    const first = rig({ connectDeadlineMs: 60_000 }, path);
    const s = await first.manager.create(LOCAL_PRINCIPAL);
    const boxId = s.boxId as string;
    first.boxes.plan.push("hang");
    void first.manager.ensureBox(s.id).catch(() => {});
    await until(() => first.boxes.running.has(boxId));
    await until(() => first.store.runningOperations(scope).length === 1);
    first.manager.stop();

    const second = rig({ superviseIntervalMs: 5, idleMs: 20 }, path, first.boxes);
    await second.manager.ready;
    await Bun.sleep(50);
    expect(second.store.getSession(scope, s.id)?.state).toBe("hibernated");
    expect(second.boxes.running.has(boxId)).toBe(false);
    expect(second.store.getBox(scope, boxId)?.state).toBe("stopped");
    expect((await eventsOf(second, s.id, "session.operation")).at(-1)?.payload).toMatchObject({
      kind: "wake",
      outcome: "interrupted",
      stop: "stopped",
    });
    const detail = second.db
      .query<{ d: string }, [string]>(
        "SELECT detail_json AS d FROM session_operation WHERE session_id = ?",
      )
      .get(s.id);
    expect(JSON.parse(detail?.d ?? "null")).toMatchObject({ stop: "stopped" });
  });

  test("a hub restart mid-hibernate, before the stop reached the provider, stops the box", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    const path = join(dir, "hub.db");
    const first = rig({ idleMs: 20 }, path);
    const s = await first.manager.create(LOCAL_PRINCIPAL);
    const boxId = s.boxId as string;
    (await first.manager.ensureBox(s.id)).release();
    let open: () => void = () => {};
    first.boxes.stopGate = new Promise((resolve) => {
      open = resolve;
    });
    await until(() => first.store.runningOperations(scope).length === 1);
    first.manager.stop();
    first.boxes.stopGate = undefined;
    expect(first.boxes.running.has(boxId)).toBe(true); // the stop never reached the provider

    const second = rig({ superviseIntervalMs: 5, idleMs: 20 }, path, first.boxes);
    await second.manager.ready;
    await Bun.sleep(50);
    expect(second.store.getSession(scope, s.id)?.state).toBe("hibernated");
    expect(second.boxes.running.has(boxId)).toBe(false);
    expect(second.store.getBox(scope, boxId)?.state).toBe("stopped");
    expect(second.store.operations(scope, s.id).map((o) => `${o.kind}:${o.status}`)).toEqual([
      "wake:done",
      "hibernate:interrupted",
    ]);
    expect((await eventsOf(second, s.id, "session.operation")).at(-1)?.payload).toMatchObject({
      kind: "hibernate",
      outcome: "interrupted",
      stop: "stopped",
    });
    open();
  });

  test("an interrupted hibernate records a stop outcome even when the box row already says stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    const path = join(dir, "hub.db");
    const first = rig({ idleMs: 5 }, path);
    const s = await first.manager.create(LOCAL_PRINCIPAL);
    const boxId = s.boxId as string;
    (await first.manager.ensureBox(s.id)).release();
    await until(() => first.store.getSession(scope, s.id)?.state === "hibernated");
    await until(() => first.store.runningOperations(scope).length === 0);
    first.manager.stop();
    // The hub died after the box row was written, before the operation was finished.
    first.store.beginOperation(scope, s.id, "hibernate", Date.now());

    const second = rig({}, path, first.boxes);
    await second.manager.ready;
    expect(second.boxes.calls.at(-1)).toBe(`stop ${boxId}`);
    expect((await eventsOf(second, s.id, "session.operation")).at(-1)?.payload).toMatchObject({
      kind: "hibernate",
      outcome: "interrupted",
      stop: "not-found",
    });
  });

  test("a stop that fails during restart recovery is recorded and logged, not swallowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    const path = join(dir, "hub.db");
    const first = rig({ connectDeadlineMs: 60_000 }, path);
    const s = await first.manager.create(LOCAL_PRINCIPAL);
    const boxId = s.boxId as string;
    first.boxes.plan.push("hang");
    void first.manager.ensureBox(s.id).catch(() => {});
    await until(() => first.boxes.running.has(boxId));
    await until(() => first.store.runningOperations(scope).length === 1);
    first.manager.stop();
    first.boxes.stopError = new HearthError("engine gone", {
      owner: "box",
      disposition: "retry",
      code: "box.provider-unavailable",
    });

    const lines: string[] = [];
    const second = rig({ log: (line) => lines.push(line) }, path, first.boxes);
    await second.manager.ready;
    expect((await eventsOf(second, s.id, "session.operation")).at(-1)?.payload).toMatchObject({
      kind: "wake",
      outcome: "interrupted",
      stop: "failed",
      code: "box.provider-unavailable",
      message: "engine gone",
    });
    expect(second.store.getBox(scope, boxId)?.state).toBe("running");
    expect(lines.some((l) => l.includes(`could not stop box ${boxId}`))).toBe(true);
    // The next wake stops the leftover runtime before it starts a new one.
    first.boxes.stopError = undefined;
    (await second.manager.ensureBox(s.id)).release();
    expect(second.boxes.calls.slice(-2)).toEqual([`stop ${boxId}`, `start ${boxId}`]);
  });

  test("a hub restart stops the box of a hibernated session whose box row still says running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-sessions-"));
    dirs.push(dir);
    const path = join(dir, "hub.db");
    const first = rig({ idleMs: 5 }, path);
    const s = await first.manager.create(LOCAL_PRINCIPAL);
    const boxId = s.boxId as string;
    (await first.manager.ensureBox(s.id)).release();
    await until(() => first.store.getBox(scope, boxId)?.state === "stopped");
    first.manager.stop();
    // A box row left running with no operation in flight (say, a crash between two writes).
    first.store.setBoxState(scope, boxId, "running");
    first.boxes.running.add(boxId);

    const second = rig({}, path, first.boxes);
    await second.manager.ready;
    expect(second.boxes.running.has(boxId)).toBe(false);
    expect(second.store.getBox(scope, boxId)?.state).toBe("stopped");
    expect((await eventsOf(second, s.id, "session.operation")).at(-1)?.payload).toMatchObject({
      kind: "recover",
      stop: "stopped",
    });
    // An idle session's box is left alone.
    const other = await second.manager.create(LOCAL_PRINCIPAL);
    (await second.manager.ensureBox(other.id)).release();
    await until(() => second.store.getSession(scope, other.id)?.state === "idle");
    second.manager.stop();
    const third = rig({}, path, first.boxes);
    await third.manager.ready;
    expect(third.boxes.running.has(other.boxId as string)).toBe(true);
  });

  test("back-to-back tool calls inside the running grace write no idle/running pair", async () => {
    const r = rig({ runningGraceMs: 60 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    for (let i = 0; i < 5; i++) {
      (await r.manager.ensureBox(s.id)).release();
      await Bun.sleep(5);
    }
    expect(r.store.getSession(scope, s.id)?.state).toBe("running");
    await until(() => r.store.getSession(scope, s.id)?.state === "idle");
    expect(await statesOf(r, s.id)).toEqual(["creating", "idle", "waking", "running", "idle"]);
    expect(
      auditActions(r.db, s.id).filter((a) => a === "session.run" || a === "session.idle"),
    ).toEqual(["session.idle", "session.run", "session.idle"]);
  });

  test("each release restarts the running grace", async () => {
    const r = rig({ runningGraceMs: 150 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    (await r.manager.ensureBox(s.id)).release();
    const first = Date.now();
    await Bun.sleep(90);
    (await r.manager.ensureBox(s.id)).release();
    // The first release's grace ends at +150; the second one's at about +240.
    await Bun.sleep(Math.max(0, first + 190 - Date.now()));
    expect(r.store.getSession(scope, s.id)?.state).toBe("running");
    await until(() => r.store.getSession(scope, s.id)?.state === "idle");
  });

  test("a grace step queued behind a new tool call leaves the session running", async () => {
    const r = rig({ runningGraceMs: 20 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    const first = await r.manager.ensureBox(s.id);
    // Hold the lifecycle queue so the grace step and the next ensureBox queue up together.
    let open: () => void = () => {};
    r.boxes.attachGate = new Promise((resolve) => {
      open = resolve;
    });
    const supervising = r.manager.supervise(s.id);
    await Bun.sleep(5);
    first.release();
    await Bun.sleep(50); // the grace timer fires and queues its step
    const pending = r.manager.ensureBox(s.id);
    await Bun.sleep(5);
    r.boxes.attachGate = undefined;
    open();
    await supervising;
    const second = await pending;
    await Bun.sleep(10);
    expect(r.store.getSession(scope, s.id)?.state).toBe("running");
    expect(await statesOf(r, s.id)).toEqual(["creating", "idle", "waking", "running"]);
    second.release();
    await until(() => r.store.getSession(scope, s.id)?.state === "idle");
  });

  test("with a running grace, the idle timer still hibernates after the configured idle time", async () => {
    const r = rig({ runningGraceMs: 40, idleMs: 150 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    (await r.manager.ensureBox(s.id)).release();
    const released = Date.now();
    await until(() => r.store.getSession(scope, s.id)?.state === "idle");
    await Bun.sleep(Math.max(0, released + 100 - Date.now()));
    expect(r.store.getSession(scope, s.id)?.state).toBe("idle");
    await until(() => r.store.getSession(scope, s.id)?.state === "hibernated");
    expect(Date.now() - released).toBeGreaterThanOrEqual(140);
    expect(r.store.getBox(scope, s.boxId as string)?.state).toBe("stopped");
  });

  test("a relaunch by supervision does not let the old idle timer hibernate the new box", async () => {
    const r = rig({ idleMs: 50, connectDeadlineMs: 60_000 });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    const boxId = s.boxId as string;
    (await r.manager.ensureBox(s.id)).release();
    await until(() => r.store.getSession(scope, s.id)?.state === "idle");
    await Bun.sleep(10);
    r.boxes.plan.push("hang");
    r.boxes.exit(boxId, 1);
    const supervising = r.manager.supervise(s.id); // relaunch, held until connect below
    await until(() => r.boxes.running.has(boxId));
    await Bun.sleep(70); // the old idle deadline passes during the relaunch
    r.boxes.connect(boxId);
    await supervising;
    await Bun.sleep(15);
    expect(r.store.getSession(scope, s.id)?.state).toBe("idle");
    expect(r.boxes.running.has(boxId)).toBe(true);
    await until(() => r.store.getSession(scope, s.id)?.state === "hibernated");
  });

  test("a short tool call clears the armed idle timer instead of racing it", async () => {
    const lines: string[] = [];
    const r = rig({ idleMs: 40, log: (line) => lines.push(line) });
    const s = await r.manager.create(LOCAL_PRINCIPAL);
    (await r.manager.ensureBox(s.id)).release();
    await until(() => r.store.getSession(scope, s.id)?.state === "idle");
    await Bun.sleep(20);
    const lease = await r.manager.ensureBox(s.id); // the idle timer was due during this call
    await Bun.sleep(50);
    lease.release();
    await until(() => r.store.getSession(scope, s.id)?.state === "idle");
    expect(lines.filter((l) => l.includes("hibernate skipped"))).toEqual([]);
    await until(() => r.store.getSession(scope, s.id)?.state === "hibernated");
  });

  test("without a provider, sessions work and ensureBox says box.no-provider", async () => {
    const r = rig();
    const m = r.make({ boxes: undefined as unknown as SessionBoxes });
    const s = await m.create(LOCAL_PRINCIPAL);
    const err = (await m.ensureBox(s.id).catch((e: unknown) => e)) as HearthError;
    expect(err.code).toBe("box.no-provider");
  });
});
