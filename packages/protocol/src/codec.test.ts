import { describe, expect, test } from "bun:test";
import {
  checkHelloVersion,
  type DecodeErrorCode,
  decodeFrame,
  encodeFrame,
  FRAME_SPECS,
  FRAME_TYPES,
  type Frame,
  type FrameOf,
  type FrameType,
  isReliable,
  MAX_ID_LENGTH,
  MAX_JSON_DEPTH,
  PROTOCOL_VERSION,
  STREAM_DATA_HEADER_BYTES,
  type WireMessage,
} from "./index";

const delivery = { bootId: "boot-1", deliveryId: 7 };

/** At least one sample per frame type; the mapped type makes a missing type a compile error. */
const SAMPLES: { readonly [T in FrameType]: readonly FrameOf<T>[] } = {
  hello: [
    {
      type: "hello",
      version: { major: 1, minor: 0 },
      boxId: "box-1",
      bootId: "boot-1",
      credential: "tok",
    },
  ],
  welcome: [
    { type: "welcome", version: { major: 1, minor: 2 }, boxId: "box-1" },
    { type: "welcome", version: { major: 1, minor: 0 }, boxId: "box-1", credential: "per-box" },
  ],
  reject: [
    { type: "reject", reason: "bad-credential", message: "token already used" },
    {
      type: "reject",
      reason: "version-mismatch",
      message: "box speaks 2.0, hub speaks 1.0",
      hubVersion: { major: 1, minor: 0 },
      boxVersion: { major: 2, minor: 0 },
    },
  ],
  "session.assign": [{ type: "session.assign", sessionId: "s1", resume: false }],
  "turn.start": [{ type: "turn.start", sessionId: "s1", turnId: "t1", input: "hello\nworld ✓" }],
  "turn.event": [
    {
      type: "turn.event",
      ...delivery,
      sessionId: "s1",
      turnId: "t1",
      seq: 0,
      event: { kind: "text", text: "hi", nested: { list: [1, null, true, "x"] } },
    },
  ],
  "turn.end": [
    { type: "turn.end", ...delivery, sessionId: "s1", turnId: "t1", outcome: "completed" },
    {
      type: "turn.end",
      ...delivery,
      sessionId: "s1",
      turnId: "t1",
      outcome: "failed",
      failure: { owner: "model-provider", retryable: true, message: "stream stalled" },
    },
  ],
  "session.hibernate": [{ type: "session.hibernate", sessionId: "s1", requestId: "r1" }],
  "hibernate.done": [
    { type: "hibernate.done", ...delivery, sessionId: "s1", requestId: "r1", outcome: "busy" },
    {
      type: "hibernate.done",
      ...delivery,
      sessionId: "s1",
      requestId: "r1",
      outcome: "failed",
      failure: { owner: "box", retryable: false, message: "disk full" },
    },
  ],
  "usage.report": [
    {
      type: "usage.report",
      ...delivery,
      sessionId: "s1",
      turnId: "t1",
      model: "anthropic/claude",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 3,
    },
  ],
  rpc: [{ type: "rpc", id: "q1", method: "files.list", params: { dir: "src" } }],
  "rpc.result": [
    { type: "rpc.result", id: "q1", ok: true, result: ["a.ts", "b.ts"] },
    {
      type: "rpc.result",
      id: "q1",
      ok: false,
      error: { code: "not-found", message: "no such dir" },
    },
  ],
  "delivery.ack": [{ type: "delivery.ack", ...delivery }],
  "desktop.lock": [
    { type: "desktop.lock", epoch: 3, holder: { kind: "person", id: "u1" }, leaseMs: 30_000 },
    { type: "desktop.lock", epoch: 4, holder: null, leaseMs: 0 },
  ],
  ping: [{ type: "ping", nonce: 42 }],
  pong: [{ type: "pong", nonce: 42 }],
  "stream.open": [
    { type: "stream.open", streamId: 2, kind: "vnc" },
    { type: "stream.open", streamId: 3, kind: "file", path: "out/report.pdf", mode: "read" },
  ],
  "stream.data": [
    { type: "stream.data", streamId: 2, seq: 0, data: new Uint8Array([0, 1, 2, 255]) },
    { type: "stream.data", streamId: 0xffff_ffff, seq: 0xffff_ffff, data: new Uint8Array() },
  ],
  "stream.close": [
    { type: "stream.close", streamId: 2, reason: "done" },
    { type: "stream.close", streamId: 2, reason: "revoked", message: "lock lost" },
  ],
};

const ALL_SAMPLES: readonly Frame[] = Object.values(SAMPLES).flat();

function decodeOk(message: WireMessage): Frame {
  const result = decodeFrame(message);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.frame;
}

function expectError(message: WireMessage, code: DecodeErrorCode, path?: string) {
  const result = decodeFrame(message);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.message.length).toBeGreaterThan(0);
  if (path !== undefined) expect(result.error.path).toBe(path);
}

/** A valid sample of `type`, as a mutable plain object for corrupting. */
function sample(type: FrameType, index = 0): Record<string, unknown> {
  const frame = SAMPLES[type][index];
  if (frame === undefined) throw new Error(`no sample ${type}[${index}]`);
  return structuredClone(frame) as unknown as Record<string, unknown>;
}

describe("round trip", () => {
  test("every frame type has a sample", () => {
    for (const type of FRAME_TYPES) expect(SAMPLES[type].length).toBeGreaterThan(0);
  });

  for (const frame of ALL_SAMPLES) {
    test(`${frame.type} ${JSON.stringify(frame).slice(0, 60)}`, () => {
      const wire = encodeFrame(frame);
      expect(decodeOk(wire)).toEqual(frame);
    });
  }

  test("stream.data is binary and every other frame is text", () => {
    for (const frame of ALL_SAMPLES) {
      const wire = encodeFrame(frame);
      expect(typeof wire === "string").toBe(frame.type !== "stream.data");
    }
  });

  test("stream.data decodes from an ArrayBuffer and from a view with an offset", () => {
    const frame: Frame = { type: "stream.data", streamId: 9, seq: 5, data: new Uint8Array([7, 8]) };
    const wire = encodeFrame(frame) as Uint8Array;
    expect(decodeOk(wire.slice().buffer)).toEqual(frame);
    const padded = new Uint8Array(wire.byteLength + 3);
    padded.set(wire, 3);
    expect(decodeOk(padded.subarray(3))).toEqual(frame);
  });

  test("decoded stream bytes do not alias the transport buffer", () => {
    const wire = encodeFrame({
      type: "stream.data",
      streamId: 1,
      seq: 0,
      data: new Uint8Array([1]),
    });
    const bytes = Buffer.from(wire as Uint8Array);
    const frame = decodeOk(bytes);
    bytes[STREAM_DATA_HEADER_BYTES] = 99;
    expect(frame.type === "stream.data" && frame.data[0]).toBe(1);
  });

  test("unknown fields are dropped, so a newer minor can add optional fields", () => {
    const frame = decodeOk(JSON.stringify({ ...sample("ping"), addedInMinor: { x: 1 } }));
    expect(frame).toEqual({ type: "ping", nonce: 42 });
  });
});

describe("delivery guarantees", () => {
  test("exactly the box → hub frames that change hub state are at-least-once", () => {
    const reliable = FRAME_TYPES.filter((t) => FRAME_SPECS[t].guarantee === "at-least-once");
    expect([...reliable].sort()).toEqual([
      "hibernate.done",
      "turn.end",
      "turn.event",
      "usage.report",
    ]);
    for (const type of reliable) expect(FRAME_SPECS[type].direction).toBe("box-to-hub");
  });

  test("pings and stream bytes are fire-and-forget", () => {
    for (const type of ["ping", "pong", "stream.data"] as const) {
      expect(FRAME_SPECS[type].guarantee).toBe("fire-and-forget");
    }
  });

  test("every at-least-once frame carries bootId and deliveryId", () => {
    for (const frame of ALL_SAMPLES) {
      if (!isReliable(frame)) continue;
      expect(frame.bootId).toBe("boot-1");
      expect(frame.deliveryId).toBe(7);
      for (const key of ["bootId", "deliveryId"]) {
        const broken = { ...(structuredClone(frame) as unknown as Record<string, unknown>) };
        delete broken[key];
        expectError(JSON.stringify(broken), "invalid-field", key);
      }
    }
  });

  test("deliveryId must be a positive integer", () => {
    for (const bad of [0, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1]) {
      expectError(
        JSON.stringify({ ...sample("delivery.ack"), deliveryId: bad }),
        "invalid-field",
        "deliveryId",
      );
    }
  });
});

describe("rejects malformed messages", () => {
  test("not JSON", () => {
    expectError("{", "invalid-json");
    expectError("", "invalid-json");
  });

  test("JSON that is not a frame", () => {
    for (const text of ["null", "[]", "42", '"ping"', "{}", '{"type":7}']) {
      expectError(text, "not-a-frame");
    }
  });

  test("unknown type", () => {
    const result = decodeFrame('{"type":"turn.explode"}');
    expect(result).toEqual({
      ok: false,
      error: {
        code: "unknown-type",
        message: 'unknown frame type "turn.explode"',
        frameType: "turn.explode",
      },
    });
    expectError('{"type":"__proto__"}', "unknown-type");
    expectError('{"type":"toString"}', "unknown-type");
  });

  test("stream.data sent as text", () => {
    expectError('{"type":"stream.data","streamId":1,"seq":0,"data":"AAE="}', "invalid-field");
  });

  test("binary messages that are not stream.data", () => {
    expectError(new Uint8Array(), "invalid-binary");
    expectError(new Uint8Array(STREAM_DATA_HEADER_BYTES - 1).fill(1), "invalid-binary");
    expectError(new Uint8Array(STREAM_DATA_HEADER_BYTES).fill(2), "invalid-binary");
  });

  test("every required field of every sample is checked", () => {
    for (const frame of ALL_SAMPLES) {
      if (frame.type === "stream.data") continue;
      for (const key of Object.keys(frame)) {
        if (key === "type") continue;
        const optional =
          (frame.type === "welcome" && key === "credential") ||
          (frame.type === "stream.close" && key === "message");
        const broken = structuredClone(frame) as unknown as Record<string, unknown>;
        delete broken[key];
        const result = decodeFrame(JSON.stringify(broken));
        if (optional) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok ? "ok" : result.error.code).toBe("invalid-field");
        }
      }
    }
  });

  test("wrong field types", () => {
    expectError(JSON.stringify({ ...sample("ping"), nonce: "1" }), "invalid-field", "nonce");
    expectError(
      JSON.stringify({ ...sample("session.assign"), resume: 1 }),
      "invalid-field",
      "resume",
    );
    expectError(JSON.stringify({ ...sample("hello"), version: "1.0" }), "invalid-field", "version");
    expectError(
      JSON.stringify({ ...sample("hello"), version: { major: 1, minor: -1 } }),
      "invalid-field",
      "version.minor",
    );
    expectError(
      JSON.stringify({ ...sample("turn.end"), outcome: "maybe" }),
      "invalid-field",
      "outcome",
    );
    expectError(
      JSON.stringify({ ...sample("stream.close"), streamId: 2 ** 32 }),
      "invalid-field",
      "streamId",
    );
  });

  test("ids must be non-empty, bounded and free of whitespace", () => {
    for (const bad of ["", "a b", "a\nb", "x".repeat(MAX_ID_LENGTH + 1)]) {
      expectError(
        JSON.stringify({ ...sample("session.assign"), sessionId: bad }),
        "invalid-field",
        "sessionId",
      );
    }
  });

  test("failure is required for failed outcomes and forbidden otherwise", () => {
    const failed = sample("turn.end", 1);
    delete failed["failure"];
    expectError(JSON.stringify(failed), "invalid-field", "failure");
    const completed = { ...sample("turn.end"), failure: sample("turn.end", 1)["failure"] };
    expectError(JSON.stringify(completed), "invalid-field", "failure");
    expectError(
      JSON.stringify({
        ...sample("hibernate.done", 1),
        failure: { owner: "nobody", retryable: true, message: "" },
      }),
      "invalid-field",
      "failure.owner",
    );
  });

  test("turn.event needs an object event with a kind", () => {
    for (const event of [null, [], "text", {}, { kind: 1 }, { kind: "" }]) {
      expectError(JSON.stringify({ ...sample("turn.event"), event }), "invalid-field", "event");
    }
  });

  test("opaque JSON payloads are depth-limited", () => {
    let params: unknown = 1;
    for (let i = 0; i <= MAX_JSON_DEPTH + 1; i++) params = [params];
    expectError(JSON.stringify({ ...sample("rpc"), params }), "invalid-field");
  });

  test("a __proto__ key in a payload stays plain data", () => {
    const frame = decodeOk(
      '{"type":"rpc","id":"q","method":"m","params":{"__proto__":{"polluted":1}}}',
    );
    expect(frame.type === "rpc" && Object.getPrototypeOf(frame.params)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("rpc.result must not mix result and error", () => {
    expectError(
      JSON.stringify({ ...sample("rpc.result"), error: { code: "x", message: "" } }),
      "invalid-field",
      "error",
    );
    expectError(
      JSON.stringify({ ...sample("rpc.result", 1), result: 1 }),
      "invalid-field",
      "result",
    );
    expectError(
      JSON.stringify({ type: "rpc.result", id: "q", ok: true }),
      "invalid-field",
      "result",
    );
  });

  test("a free desktop lock has no lease", () => {
    expectError(
      JSON.stringify({ ...sample("desktop.lock", 1), leaseMs: 5 }),
      "invalid-field",
      "leaseMs",
    );
    expectError(
      JSON.stringify({ ...sample("desktop.lock"), holder: { kind: "robot", id: "x" } }),
      "invalid-field",
      "holder.kind",
    );
  });

  test("version-mismatch rejects must name both versions", () => {
    const broken = sample("reject", 1);
    delete broken["boxVersion"];
    expectError(JSON.stringify(broken), "invalid-field", "boxVersion");
  });
});

describe("no hub-local paths", () => {
  const open = (path: unknown) => JSON.stringify({ ...sample("stream.open", 1), path });

  test("file streams take workspace-relative paths", () => {
    expect(decodeOk(open("a/b/c.txt"))).toMatchObject({ path: "a/b/c.txt" });
    expect(decodeOk(open("a/..b/c"))).toMatchObject({ path: "a/..b/c" });
  });

  test("absolute, drive, parent and empty paths are rejected", () => {
    for (const bad of [
      "/etc/passwd",
      "\\\\host\\share",
      "C:\\x",
      "c:x",
      "../x",
      "a/../../x",
      "a\\..\\x",
      "",
      "a\u0000b",
      5,
    ]) {
      expectError(open(bad), "invalid-field", "path");
    }
  });

  test("vnc streams carry no path", () => {
    expectError(JSON.stringify({ ...sample("stream.open"), path: "x" }), "invalid-field", "path");
  });
});

describe("encode", () => {
  test("rejects stream ids and sequence numbers that do not fit in 32 bits", () => {
    for (const bad of [-1, 2 ** 32, 1.5, Number.NaN]) {
      const data = new Uint8Array();
      expect(() => encodeFrame({ type: "stream.data", streamId: bad, seq: 0, data })).toThrow(
        RangeError,
      );
      expect(() => encodeFrame({ type: "stream.data", streamId: 0, seq: bad, data })).toThrow(
        RangeError,
      );
    }
  });
});

describe("handshake version check", () => {
  const hello = (major: number, minor: number) =>
    ({ ...SAMPLES.hello[0], version: { major, minor } }) as FrameOf<"hello">;

  test("accepts any minor of the same major", () => {
    expect(checkHelloVersion(hello(1, 0))).toBeNull();
    expect(checkHelloVersion(hello(1, 9))).toBeNull();
  });

  test("rejects another major, naming both versions", () => {
    const reject = checkHelloVersion(hello(2, 1));
    expect(reject).toEqual({
      type: "reject",
      reason: "version-mismatch",
      message: "box speaks protocol 2.1 but the hub speaks 1.0; major versions must match",
      hubVersion: PROTOCOL_VERSION,
      boxVersion: { major: 2, minor: 1 },
    });
    expect(reject && decodeOk(encodeFrame(reject))).toEqual(reject);
    expect(checkHelloVersion(hello(1, 0), { major: 2, minor: 0 })?.reason).toBe("version-mismatch");
  });
});
