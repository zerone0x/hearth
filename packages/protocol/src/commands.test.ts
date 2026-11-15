import { describe, expect, test } from "bun:test";
import {
  type CommandFrame,
  type CommandHistory,
  decodeFrame,
  encodeFrame,
  FRAME_SPECS,
  FRAME_TYPES,
  type Frame,
  isCommand,
  isDuplicateCommand,
} from "./index";

/**
 * A minimal box that follows the protocol's rule: it applies a command only
 * when `isDuplicateCommand` says it is new, and records what it applied.
 */
class FakeBox {
  sessionId: string | null = null;
  readonly turnIds = new Set<string>();
  readonly hibernateRequestIds = new Set<string>();
  readonly applied: string[] = [];

  history(): CommandHistory {
    return {
      sessionId: this.sessionId,
      turnIds: this.turnIds,
      hibernateRequestIds: this.hibernateRequestIds,
    };
  }

  /** Receives one wire message, as the box-agent would. */
  receive(message: string | Uint8Array): void {
    const result = decodeFrame(message);
    if (!result.ok) throw new Error(result.error.message);
    const frame = result.frame;
    if (!isCommand(frame) || isDuplicateCommand(this.history(), frame)) return;
    switch (frame.type) {
      case "session.assign":
        this.sessionId = frame.sessionId;
        this.applied.push(`assign ${frame.sessionId}`);
        break;
      case "turn.start":
        this.turnIds.add(frame.turnId);
        this.applied.push(`turn ${frame.turnId}`);
        break;
      case "session.hibernate":
        this.hibernateRequestIds.add(frame.requestId);
        this.sessionId = null;
        this.applied.push(`hibernate ${frame.requestId}`);
        break;
    }
  }
}

const assign: CommandFrame = { type: "session.assign", sessionId: "s1", resume: false };
const turn: CommandFrame = { type: "turn.start", sessionId: "s1", turnId: "t1", input: "hi" };
const hibernate: CommandFrame = { type: "session.hibernate", sessionId: "s1", requestId: "r1" };

describe("re-sent commands are idempotent", () => {
  test("the commands are exactly the hub → box frames that change box state", () => {
    const commands = FRAME_TYPES.filter((type) => isCommand({ type } as unknown as Frame)).sort();
    expect(commands).toEqual(["session.assign", "session.hibernate", "turn.start"]);
    for (const type of commands) {
      expect(FRAME_SPECS[type]).toEqual({ direction: "hub-to-box", guarantee: "fire-and-forget" });
    }
  });

  test("a turn.start for a known turnId never runs the turn twice", () => {
    const box = new FakeBox();
    box.receive(encodeFrame(assign));
    box.receive(encodeFrame(turn));
    // Reconnect: the hub re-sends everything it has not seen an effect of.
    box.receive(encodeFrame(assign));
    box.receive(encodeFrame(turn));
    box.receive(encodeFrame({ ...turn, input: "a different input" } as CommandFrame));
    expect(box.applied).toEqual(["assign s1", "turn t1"]);
    box.receive(encodeFrame({ ...turn, turnId: "t2" } as CommandFrame));
    expect(box.applied).toEqual(["assign s1", "turn t1", "turn t2"]);
  });

  test("a turn stays known after it ended", () => {
    const history: CommandHistory = {
      sessionId: "s1",
      turnIds: new Set(["t1"]),
      hibernateRequestIds: new Set(),
    };
    expect(isDuplicateCommand(history, turn)).toBe(true);
  });

  test("session.hibernate is applied once per requestId", () => {
    const box = new FakeBox();
    box.receive(encodeFrame(assign));
    box.receive(encodeFrame(hibernate));
    box.receive(encodeFrame(hibernate));
    expect(box.applied).toEqual(["assign s1", "hibernate r1"]);
    box.receive(encodeFrame({ ...hibernate, requestId: "r2" } as CommandFrame));
    expect(box.applied.at(-1)).toBe("hibernate r2");
  });

  test("session.assign is a duplicate only while that session is assigned", () => {
    const box = new FakeBox();
    box.receive(encodeFrame(assign));
    box.receive(encodeFrame(assign));
    expect(box.applied).toEqual(["assign s1"]);
    // After hibernation the same session may be assigned again, as a resume.
    box.receive(encodeFrame(hibernate));
    box.receive(encodeFrame({ ...assign, resume: true } as CommandFrame));
    expect(box.applied).toEqual(["assign s1", "hibernate r1", "assign s1"]);
    // Another session is never a duplicate.
    expect(isDuplicateCommand(box.history(), { ...assign, sessionId: "s2" } as CommandFrame)).toBe(
      false,
    );
  });

  test("a new boot starts with an empty history", () => {
    const fresh: CommandHistory = {
      sessionId: null,
      turnIds: new Set(),
      hibernateRequestIds: new Set(),
    };
    for (const command of [assign, turn, hibernate]) {
      expect(isDuplicateCommand(fresh, command)).toBe(false);
    }
  });
});
