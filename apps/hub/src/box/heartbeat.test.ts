/**
 * The hub's heartbeat on box connections (issue #31, decision 0028), on an
 * injected clock: no test here sleeps for a beat. A fake box speaks the
 * protocol over a real WebSocket and either answers pings or goes silent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_ID, HearthError } from "@hearth/core";
import { decodeFrame, encodeFrame, type Frame, PROTOCOL_VERSION } from "@hearth/protocol";
import { buildTrajectory } from "../obs/trajectory";
import { startHub } from "../server";
import { CLOSE_CODES, CONNECTION_DEAD_EVENT, type ConnectionDeath } from "./connections";

const STEP_MS = 5_000;

/** A clock whose beats run only when the test calls `beat()`; any number of timers. */
function manualClock() {
  const timers = new Map<number, { ms: number; fn: () => void }>();
  let next = 0;
  return {
    timers,
    every(ms: number, fn: () => void) {
      const id = next++;
      timers.set(id, { ms, fn });
      return () => timers.delete(id);
    },
    beat() {
      for (const t of [...timers.values()]) t.fn();
    },
  };
}

const hubs: ReturnType<typeof startHub>[] = [];
const dirs: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const h of hubs.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hearth-heartbeat-"));
  dirs.push(dir);
  const clock = manualClock();
  const lines: string[] = [];
  const h = startHub({
    dbPath: join(dir, "hub.db"),
    port: 0,
    boxPort: 0,
    log: (line) => lines.push(line),
    heartbeat: { intervalMs: 1_000, maxMisses: 3, clock },
  });
  hubs.push(h);
  return { h, clock, lines, url: h.listenForBoxes("127.0.0.1") };
}

/** Resolve when `check` holds; the loop is bounded by `STEP_MS`. */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + STEP_MS;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** A box that says hello and records what the hub sends; `answerPings` makes it healthy. */
async function fakeBox(url: string, boxId: string, token: string, answerPings: boolean) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: Frame[] = [];
  let closeCode: number | undefined;
  ws.addEventListener("message", (event) => {
    const decoded = decodeFrame(event.data as string);
    if (!decoded.ok) return;
    frames.push(decoded.frame);
    if (answerPings && decoded.frame.type === "ping") {
      ws.send(encodeFrame({ type: "pong", nonce: decoded.frame.nonce }));
    }
  });
  ws.addEventListener("close", (event) => {
    closeCode = event.code;
  });
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(
    encodeFrame({
      type: "hello",
      version: PROTOCOL_VERSION,
      boxId,
      bootId: `boot_${boxId}`,
      credential: token,
      state: { sessionId: null, turnId: null, lastDeliveryId: 0 },
    }),
  );
  await until(() => frames.some((f) => f.type === "welcome"), "welcome");
  return {
    ws,
    frames,
    pings: () => frames.filter((f) => f.type === "ping").length,
    get closed() {
      return closeCode !== undefined;
    },
  };
}

describe("hub heartbeat", () => {
  test("a silent box is declared dead after maxMisses beats, not before", async () => {
    const { h, clock, lines, url } = setup();
    const { token } = await h.issueJoinToken("box_silent", "ses_silent");
    const deaths: ConnectionDeath[] = [];
    const disconnects: string[] = [];
    h.boxes.listen({
      dead: (_boxId, _bootId, death) => deaths.push(death),
      disconnected: (boxId) => disconnects.push(`${boxId}:${deaths.length}`),
    });
    const told: string[] = [];
    const boxClosed = h.sessions.boxClosed.bind(h.sessions);
    h.sessions.boxClosed = (boxId) => {
      told.push(boxId);
      boxClosed(boxId);
    };
    const box = await fakeBox(url, "box_silent", token, false);
    await until(() => h.boxes.isConnected("box_silent"), "connected");
    expect([...clock.timers.values()].map((t) => t.ms)).toEqual([1_000]);
    // A call in flight on the connection, with a deadline far beyond the beats.
    const echo = h.boxes.rpc("box_silent", "echo", "x", 600_000);
    echo.catch(() => {});

    clock.beat();
    clock.beat();
    await until(() => box.pings() === 2, "two pings");
    expect(h.boxes.isConnected("box_silent")).toBe(true);
    expect(deaths).toEqual([]);

    clock.beat();
    expect(h.boxes.isConnected("box_silent")).toBe(false);
    expect(deaths).toEqual([{ misses: 3, intervalMs: 1_000 }]);
    // `dead` comes first, then `disconnected`; the session manager is told.
    expect(disconnects).toEqual(["box_silent:1"]);
    expect(told).toContain("box_silent");
    // The call fails now with a typed error, not at its deadline.
    const error = await echo.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HearthError);
    expect((error as HearthError).code).toBe("box.connection-dead");
    expect(lines.some((l) => l.includes("box box_silent connection dead"))).toBe(true);
    // The hub's beats stopped with the connection.
    expect(clock.timers.size).toBe(0);
    await until(() => box.closed, "the box's socket to close");

    // The event log and the trajectory record the death.
    // (The append is asynchronous; poll the log, bounded.)
    let events = (await h.events.read({ workspaceId: DEFAULT_WORKSPACE_ID }, "ses_silent", 0, 100))
      .events;
    const end = Date.now() + STEP_MS;
    while (!events.some((e) => e.type === CONNECTION_DEAD_EVENT) && Date.now() < end) {
      await Bun.sleep(5);
      events = (await h.events.read({ workspaceId: DEFAULT_WORKSPACE_ID }, "ses_silent", 0, 100))
        .events;
    }
    const recorded = events.find((e) => e.type === CONNECTION_DEAD_EVENT);
    expect(recorded?.payload).toEqual({
      boxId: "box_silent",
      bootId: "boot_box_silent",
      detectedBy: "hub",
      misses: 3,
      intervalMs: 1_000,
      closeCode: CLOSE_CODES.heartbeatTimeout,
    });
    const trajectory = buildTrajectory(events, { sessionId: "ses_silent", versions: { pi: "p", hub: "h" } });
    expect(trajectory).toContainEqual(
      expect.objectContaining({ kind: "box", op: CONNECTION_DEAD_EVENT, box_id: "box_silent" }),
    );
  });

  test("a box that answers pings stays connected beat after beat", async () => {
    const { h, clock, url } = setup();
    const { token } = await h.issueJoinToken("box_alive", "ses_alive");
    const box = await fakeBox(url, "box_alive", token, true);
    await until(() => h.boxes.isConnected("box_alive"), "connected");
    for (let i = 1; i <= 8; i++) {
      clock.beat();
      // Let the pong come back before the next beat.
      await until(
        () => box.frames.filter((f) => f.type === "ping").length === i,
        `ping ${i}`,
      );
      await Bun.sleep(20);
    }
    expect(h.boxes.isConnected("box_alive")).toBe(true);
  });

  test("a frame other than pong also counts as alive", async () => {
    const { h, clock, url } = setup();
    const { token } = await h.issueJoinToken("box_chatty", "ses_chatty");
    const box = await fakeBox(url, "box_chatty", token, false);
    await until(() => h.boxes.isConnected("box_chatty"), "connected");
    for (let i = 0; i < 6; i++) {
      // The box pings the hub on its own clock; the hub's pong is not needed here.
      box.ws.send(encodeFrame({ type: "ping", nonce: i }));
      await until(() => box.frames.filter((f) => f.type === "pong").length === i + 1, "pong");
      clock.beat();
    }
    expect(h.boxes.isConnected("box_chatty")).toBe(true);
    clock.beat();
    clock.beat();
    clock.beat();
    expect(h.boxes.isConnected("box_chatty")).toBe(false);
  });
});
