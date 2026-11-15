/**
 * E9 Channel (PRD §6.6, §7): message entry adapters such as Web and Telegram.
 * Interface only; adapters land with their milestones.
 */

import type { Principal } from "./identity";
import type { EpochMs, SessionId } from "./ids";

/** A message that arrived through a channel. */
export interface InboundMessage {
  /** Channel name, e.g. `telegram`. */
  readonly channel: string;
  /** Channel-native conversation id (e.g. a Telegram chat plus topic). */
  readonly conversationId: string;
  /** Channel-native message id, for deduplicating redeliveries from the channel. */
  readonly messageId: string;
  /**
   * Who sent it, as resolved by the adapter from its pairing. Display names in
   * chats are labels, not identity (PRD §10).
   */
  readonly principal: Principal;
  readonly text: string;
  readonly receivedAt: EpochMs;
}

/**
 * Hub-side handler for inbound messages. Called by the adapter once per inbound
 * message. Resolves when the hub has durably accepted the message; the adapter
 * acknowledges the channel only then.
 */
export type InboundHandler = (message: InboundMessage) => Promise<void>;

/** Something the hub sends out through a channel. */
export type OutboundMessage =
  | { readonly kind: "text"; readonly sessionId: SessionId; readonly text: string }
  | {
      readonly kind: "approval";
      readonly sessionId: SessionId;
      readonly approvalId: string;
      readonly summary: string;
    };

/**
 * A message entry adapter.
 *
 * Called by the hub: `start` once at startup (pollers run under a single lease,
 * PRD §10), `send` to deliver results and approval cards, `stop` on shutdown.
 */
export interface Channel {
  /** Short name, e.g. `web` or `telegram`. */
  readonly name: string;

  /** Begin receiving. Each inbound message is passed to `onMessage`. */
  start(onMessage: InboundHandler): Promise<void>;

  /**
   * Deliver a message to a conversation. Rejects with a classified
   * `HearthError` when the channel refuses it; the hub decides whether to retry.
   */
  send(conversationId: string, message: OutboundMessage): Promise<void>;

  /** Stop receiving. Resolves when no more `onMessage` calls will be made. */
  stop(): Promise<void>;
}
