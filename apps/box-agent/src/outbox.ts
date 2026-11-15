/**
 * The box's outbox for at-least-once frames (PRD §8.1 principle 5).
 *
 * Every `turn.event`, `turn.end`, `hibernate.done` and `usage.report` gets the
 * next `deliveryId` of this boot and stays here until the hub acks it with
 * `delivery.ack`. After a reconnect the agent redelivers everything still here,
 * in `deliveryId` order, with the same `bootId` and `deliveryId`.
 */

import { HearthError } from "@hearth/core";
import type { ReliableFrame } from "@hearth/protocol";

/**
 * Most unacked frames the outbox holds. When the hub is unreachable for long,
 * a producer hits this instead of growing memory without bound; it then gets
 * an explicit `outbox.full` error, never a silent drop.
 */
export const MAX_OUTBOX_FRAMES = 1_024;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A reliable frame before the outbox stamps its delivery. */
export type OutboundFrame = DistributiveOmit<ReliableFrame, "bootId" | "deliveryId">;

export class Outbox {
  readonly bootId: string;
  readonly limit: number;
  readonly #pending = new Map<number, ReliableFrame>();
  #lastDeliveryId = 0;

  constructor(bootId: string, limit: number = MAX_OUTBOX_FRAMES) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`Outbox limit ${String(limit)} is not a positive integer`);
    }
    this.bootId = bootId;
    this.limit = limit;
  }

  /** The highest `deliveryId` assigned in this boot, 0 when none (`hello.state.lastDeliveryId`). */
  get lastDeliveryId(): number {
    return this.#lastDeliveryId;
  }

  get size(): number {
    return this.#pending.size;
  }

  /**
   * Stamp `frame` with the next delivery and keep it until it is acked.
   * Throws a `box`-owned `outbox.full` `HearthError` when `limit` frames are
   * already waiting; the frame is then not taken and no id is used up.
   */
  enqueue(frame: OutboundFrame): ReliableFrame {
    if (this.#pending.size >= this.limit) {
      throw new HearthError(
        `The outbox holds ${this.limit} unacked frames (MAX_OUTBOX_FRAMES); the hub is not acking`,
        { owner: "box", disposition: "retry", code: "outbox.full" },
      );
    }
    this.#lastDeliveryId += 1;
    const stamped = {
      ...frame,
      bootId: this.bootId,
      deliveryId: this.#lastDeliveryId,
    } as ReliableFrame;
    this.#pending.set(stamped.deliveryId, stamped);
    return stamped;
  }

  /** Drop an acked delivery. Returns `false` for an ack of another boot or an unknown id. */
  ack(bootId: string, deliveryId: number): boolean {
    if (bootId !== this.bootId) return false;
    return this.#pending.delete(deliveryId);
  }

  /** Everything not acked yet, oldest first: what to redeliver after a reconnect. */
  pending(): ReliableFrame[] {
    return [...this.#pending.values()].sort((a, b) => a.deliveryId - b.deliveryId);
  }
}
