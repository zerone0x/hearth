import { describe, expect, test } from "bun:test";
import { HearthError } from "@hearth/core";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, reconnectDelay } from "./connection";
import { MAX_OUTBOX_FRAMES, type OutboundFrame, Outbox } from "./outbox";

function tick(n: number): OutboundFrame {
  return {
    type: "turn.event",
    sessionId: "ses_1",
    turnId: "turn_1",
    seq: n,
    event: { kind: "test.tick", n },
  };
}

describe("Outbox", () => {
  test("stamps increasing delivery ids of its boot and keeps frames until acked", () => {
    const outbox = new Outbox("boot_a");
    expect(outbox.lastDeliveryId).toBe(0);
    const a = outbox.enqueue(tick(1));
    const b = outbox.enqueue(tick(2));
    expect([a.bootId, a.deliveryId, b.deliveryId]).toEqual(["boot_a", 1, 2]);
    expect(outbox.lastDeliveryId).toBe(2);
    expect(outbox.ack("boot_a", 1)).toBe(true);
    expect(outbox.pending()).toEqual([b]);
  });

  test("redelivers in delivery order whatever order acks came in", () => {
    const outbox = new Outbox("boot_a");
    for (let i = 1; i <= 5; i++) outbox.enqueue(tick(i));
    outbox.ack("boot_a", 2);
    outbox.ack("boot_a", 4);
    expect(outbox.pending().map((f) => f.deliveryId)).toEqual([1, 3, 5]);
  });

  test("ignores acks of another boot or of unknown ids", () => {
    const outbox = new Outbox("boot_a");
    outbox.enqueue(tick(1));
    expect(outbox.ack("boot_b", 1)).toBe(false);
    expect(outbox.ack("boot_a", 9)).toBe(false);
    expect(outbox.size).toBe(1);
  });

  test("refuses a frame past its limit with outbox.full, without using up an id", () => {
    const outbox = new Outbox("boot_a", 2);
    outbox.enqueue(tick(1));
    outbox.enqueue(tick(2));
    let error: unknown;
    try {
      outbox.enqueue(tick(3));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HearthError);
    expect(error).toMatchObject({ code: "outbox.full", owner: "box" });
    expect(outbox.lastDeliveryId).toBe(2);
    outbox.ack("boot_a", 1);
    expect(outbox.enqueue(tick(3)).deliveryId).toBe(3);
  });

  test("the default limit is MAX_OUTBOX_FRAMES", () => {
    expect(new Outbox("boot_a").limit).toBe(MAX_OUTBOX_FRAMES);
    expect(() => new Outbox("boot_a", 0)).toThrow(RangeError);
  });
});

describe("reconnectDelay", () => {
  test("grows exponentially, is capped, and keeps at least half of its cap", () => {
    expect(reconnectDelay(0, () => 0)).toBe(RECONNECT_BASE_MS / 2);
    expect(reconnectDelay(0, () => 0.999)).toBeLessThan(RECONNECT_BASE_MS);
    expect(reconnectDelay(3, () => 0)).toBe((RECONNECT_BASE_MS * 8) / 2);
    expect(reconnectDelay(100, () => 0)).toBe(RECONNECT_MAX_MS / 2);
    expect(reconnectDelay(100, () => 0.999)).toBeLessThan(RECONNECT_MAX_MS);
  });

  test("is jittered: different random draws give different delays", () => {
    const delays = new Set([0.1, 0.4, 0.7, 0.9].map((r) => reconnectDelay(5, () => r)));
    expect(delays.size).toBe(4);
  });
});
