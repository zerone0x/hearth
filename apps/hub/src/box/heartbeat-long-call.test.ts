/**
 * No false positives from the heartbeat (issue #31, decision 0028): a real hub
 * and an in-process box-agent, both on injected clocks, while a tool call runs
 * for longer than the bound in injected time and sends no result frame. The
 * connection must stay up, because pings and pongs cross it on every beat.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxAgent } from "../../../box-agent/src/connection";
import { type Hub, startHub } from "../server";
import { ToolRpcClient } from "./tool-rpc";

/** A clock whose beats run only when the test calls `beat()`. */
function manualClock() {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    timers,
    every(_ms: number, fn: () => void) {
      const id = next++;
      timers.set(id, fn);
      return () => timers.delete(id);
    },
    beat() {
      for (const fn of [...timers.values()]) fn();
    },
  };
}

const hubs: Hub[] = [];
const agents: BoxAgent[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const a of agents.splice(0)) a.stop();
  for (const h of hubs.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(boxId: string) {
  const dir = mkdtempSync(join(tmpdir(), "hearth-long-call-"));
  dirs.push(dir);
  const root = join(dir, "ws");
  mkdirSync(root);
  const hubClock = manualClock();
  const boxClock = manualClock();
  const hubLines: string[] = [];
  const boxLines: string[] = [];
  const hub = startHub({
    dbPath: join(dir, "hub.db"),
    port: 0,
    boxPort: 0,
    log: (line) => hubLines.push(line),
    heartbeat: { intervalMs: 5_000, maxMisses: 3, clock: hubClock },
  });
  hubs.push(hub);
  const { token } = await hub.issueJoinToken(boxId, `ses_${boxId}`);
  const agent = new BoxAgent({
    hubUrl: hub.listenForBoxes("127.0.0.1"),
    boxId,
    joinToken: token,
    log: (line) => boxLines.push(line),
    tools: { root },
    heartbeat: { clock: boxClock },
  });
  agents.push(agent);
  agent.start();
  await hub.boxes.waitForBox(boxId, 10_000);
  let deaths = 0;
  hub.boxes.listen({
    dead: () => {
      deaths += 1;
    },
  });
  const client = new ToolRpcClient({ boxes: hub.boxes, log: () => {} });
  return { hub, root, hubClock, boxClock, hubLines, boxLines, client, deaths: () => deaths };
}

test("a long tool call with no result frame for 10 beats of each clock is not declared dead", async () => {
  const { hub, root, hubClock, boxClock, hubLines, boxLines, client, deaths } =
    await setup("box_long");
  const exec = client.call("box_long", "call_long", "tool.exec", {
    command: "sleep 2; echo done",
    cwd: root,
    timeoutMs: 60_000,
  });
  // 10 beats on each clock (50 s of injected time, past the 15 s bound) while
  // the tool runs, with a short real gap so pings and pongs cross the socket.
  for (let i = 0; i < 10; i++) {
    hubClock.beat();
    boxClock.beat();
    await Bun.sleep(30);
  }
  expect(deaths()).toBe(0);
  expect(hub.boxes.isConnected("box_long")).toBe(true);
  expect(boxLines.some((l) => l.includes("connection dead"))).toBe(false);
  expect(hubLines.some((l) => l.includes("connection dead"))).toBe(false);
  const result = await exec;
  expect(result.outcome).toBe("exited");
  expect(client.pending).toBe(0);
  client.close();
}, 20_000);

test("beats on the hub's clock alone keep a busy box alive: the box answers pings", async () => {
  const { hub, root, hubClock, client, deaths } = await setup("box_busy");
  const exec = client.call("box_busy", "call_busy", "tool.exec", {
    command: "i=0; while [ $i -lt 400000 ]; do i=$((i+1)); done; echo cpu",
    cwd: root,
    timeoutMs: 60_000,
  });
  for (let i = 0; i < 8; i++) {
    hubClock.beat();
    await Bun.sleep(30);
  }
  expect(deaths()).toBe(0);
  expect(hub.boxes.isConnected("box_busy")).toBe(true);
  const result = await exec;
  expect(result.outcome).toBe("exited");
  client.close();
}, 30_000);
