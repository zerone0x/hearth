import { describe, expect, test } from "bun:test";
import { Heartbeat, type HeartbeatClock, heartbeatBoundMs } from "./heartbeat";

/** A clock whose beats run only when the test calls `beat()`. */
function manualClock(): HeartbeatClock & { beat(): void; readonly ms: number[]; armed: number } {
  let fn: (() => void) | undefined;
  const clock = {
    ms: [] as number[],
    armed: 0,
    every(ms: number, beat: () => void) {
      clock.ms.push(ms);
      clock.armed += 1;
      fn = beat;
      return () => {
        clock.armed -= 1;
        fn = undefined;
      };
    },
    beat() {
      fn?.();
    },
  };
  return clock;
}

function setup(maxMisses = 3) {
  const clock = manualClock();
  const pings: number[] = [];
  const deaths: number[] = [];
  const hb = new Heartbeat({
    clock,
    intervalMs: 1_000,
    maxMisses,
    ping: (n) => pings.push(n),
    dead: (m) => deaths.push(m),
  });
  return { clock, pings, deaths, hb };
}

describe("Heartbeat", () => {
  test("beats on the configured interval and pings each beat until dead", () => {
    const { clock, pings, deaths, hb } = setup();
    hb.start();
    expect(clock.ms).toEqual([1_000]);
    clock.beat();
    clock.beat();
    expect(pings).toEqual([1, 2]);
    expect(hb.misses).toBe(2);
    expect(deaths).toEqual([]);
    clock.beat();
    expect(deaths).toEqual([3]);
    expect(pings).toEqual([1, 2]);
    expect(hb.running).toBe(false);
    expect(clock.armed).toBe(0);
    // Dead is reported once.
    clock.beat();
    expect(deaths).toEqual([3]);
  });

  test("a frame between beats resets the miss count", () => {
    const { clock, deaths, hb } = setup();
    hb.start();
    clock.beat();
    clock.beat();
    expect(hb.misses).toBe(2);
    hb.heard();
    clock.beat();
    expect(hb.misses).toBe(0);
    clock.beat();
    clock.beat();
    expect(deaths).toEqual([]);
    clock.beat();
    expect(deaths).toEqual([3]);
  });

  test("misses must be consecutive: a frame each beat keeps it alive forever", () => {
    const { clock, deaths, hb } = setup(2);
    hb.start();
    for (let i = 0; i < 50; i++) {
      clock.beat();
      hb.heard();
    }
    expect(deaths).toEqual([]);
  });

  test("maxMisses 1 declares dead on the first silent beat", () => {
    const { clock, deaths, hb } = setup(1);
    hb.start();
    clock.beat();
    expect(deaths).toEqual([1]);
  });

  test("stop cancels the clock; start again begins a fresh count", () => {
    const { clock, deaths, hb } = setup();
    hb.start();
    hb.start();
    expect(clock.armed).toBe(1);
    clock.beat();
    clock.beat();
    hb.stop();
    expect(clock.armed).toBe(0);
    hb.start();
    clock.beat();
    clock.beat();
    expect(deaths).toEqual([]);
  });

  test("a frame heard before start does not count for the new connection", () => {
    const { clock, deaths, hb } = setup(1);
    hb.heard();
    hb.start();
    clock.beat();
    expect(deaths).toEqual([1]);
  });

  test("the bound and invalid settings", () => {
    expect(heartbeatBoundMs(1_000, 3)).toBe(4_000);
    expect(heartbeatBoundMs()).toBe(20_000);
    const clock = manualClock();
    const base = { clock, ping: () => {}, dead: () => {} };
    expect(() => new Heartbeat({ ...base, maxMisses: 0 })).toThrow(RangeError);
    expect(() => new Heartbeat({ ...base, intervalMs: 0 })).toThrow(RangeError);
  });
});
