import { describe, expect, test } from "bun:test";
import {
  checkHelloVersion,
  type DecodeErrorCode,
  decodeFrame,
  EncodeError,
  encodeFrame,
  FRAME_SPECS,
  FRAME_TYPES,
  type Frame,
  type FrameOf,
  type FrameType,
  isReliable,
  MAX_ECHOED_TYPE_LENGTH,
  MAX_ID_LENGTH,
  MAX_JSON_DEPTH,
  PROTOCOL_VERSION,
  rejectHello,
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
      state: { sessionId: null, turnId: null, lastDeliveryId: 0 },
    },
    {
      type: "hello",
      version: { major: 1, minor: 3 },
      boxId: "box-1",
      bootId: "boot-1",
      credential: "per-box",
      state: { sessionId: "s1", turnId: "t1", lastDeliveryId: 41 },
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
  "session.assign": [{ type: "session.assign", sessionId: "s1", requestId: "a1", resume: false }],
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
      failure: { owner: "model-provider", disposition: "retry", message: "stream stalled" },
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
      failure: { owner: "box", disposition: "retry-cold", message: "disk full" },
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

  test("an unknown type is capped before it is echoed", () => {
    const long = "x".repeat(100_000);
    const result = decodeFrame(JSON.stringify({ type: long }));
    if (result.ok) throw new Error("expected an error");
    expect(result.error.code).toBe("unknown-type");
    expect(result.error.frameType).toBe(`${"x".repeat(MAX_ECHOED_TYPE_LENGTH)}…`);
    expect(result.error.message.length).toBeLessThan(MAX_ECHOED_TYPE_LENGTH + 40);
    const exact = "y".repeat(MAX_ECHOED_TYPE_LENGTH);
    const kept = decodeFrame(JSON.stringify({ type: exact }));
    expect(kept.ok ? null : kept.error.frameType).toBe(exact);
  });

  test("the cap counts code points, so a surrogate pair is never split", () => {
    // One ASCII char shifts every pair onto an odd UTF-16 offset, so a cap at
    // MAX_ECHOED_TYPE_LENGTH UTF-16 units would cut a pair in half.
    const astral = "\u{1F525}";
    const type = `x${astral.repeat(MAX_ECHOED_TYPE_LENGTH)}`;
    const result = decodeFrame(JSON.stringify({ type }));
    if (result.ok) throw new Error("expected an error");
    expect(result.error.code).toBe("unknown-type");
    const shown = result.error.frameType ?? "";
    expect(shown).toBe(`x${astral.repeat(MAX_ECHOED_TYPE_LENGTH - 1)}…`);
    expect([...shown].length).toBe(MAX_ECHOED_TYPE_LENGTH + 1);
    expect(shown).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    // Exactly the cap in code points (but more UTF-16 units) is kept whole.
    const exact = astral.repeat(MAX_ECHOED_TYPE_LENGTH);
    const kept = decodeFrame(JSON.stringify({ type: exact }));
    expect(kept.ok ? null : kept.error.frameType).toBe(exact);
  });

  test("control and bidi characters in an unknown type are not echoed", () => {
    for (const bad of ["\u202e", "\u2066", "\u200f", "\u0085", "\u0007", "\u061c"]) {
      const result = decodeFrame(JSON.stringify({ type: `turn${bad}.start` }));
      if (result.ok) throw new Error("expected an error");
      expect(result.error.code).toBe("unknown-type");
      expect(result.error.frameType).toBe("turn\ufffd.start");
      expect(result.error.message).not.toContain(bad);
    }
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
        failure: { owner: "nobody", disposition: "retry", message: "" },
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

  test("opaque JSON payloads nest at most MAX_JSON_DEPTH levels", () => {
    const nest = (levels: number, inner: unknown, wrap: (v: unknown) => unknown) => {
      let value = inner;
      for (let i = 0; i < levels; i++) value = wrap(value);
      return value;
    };
    const rpc = (params: unknown) => JSON.stringify({ ...sample("rpc"), params });
    for (const wrap of [(v: unknown) => [v], (v: unknown) => ({ k: v })]) {
      // The innermost container counts as a level even when it is empty.
      for (const inner of [1, [], {}]) {
        const innerLevels = typeof inner === "object" ? 1 : 0;
        const atLimit = nest(MAX_JSON_DEPTH - innerLevels, inner, wrap);
        expect(decodeOk(rpc(atLimit))).toMatchObject({ params: atLimit });
        expectError(rpc(nest(MAX_JSON_DEPTH + 1 - innerLevels, inner, wrap)), "invalid-field");
      }
    }
    // The turn.event `event` object itself is the first level.
    const event = nest(MAX_JSON_DEPTH - 1, { kind: "x" }, (v) => ({ kind: "x", v }));
    expect(decodeOk(JSON.stringify({ ...sample("turn.event"), event }))).toMatchObject({ event });
    const deeper = { kind: "x", v: event };
    expectError(JSON.stringify({ ...sample("turn.event"), event: deeper }), "invalid-field");
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

  test("only version-mismatch rejects carry versions", () => {
    for (const key of ["hubVersion", "boxVersion"]) {
      const extra = { ...sample("reject"), [key]: { major: 1, minor: 0 } };
      expectError(JSON.stringify(extra), "invalid-field", key);
    }
  });

  test("failures carry a disposition, not a retryable flag", () => {
    for (const disposition of ["retry", "retry-cold", "give-up"]) {
      const frame = sample("turn.end", 1);
      frame["failure"] = { owner: "gateway", disposition, message: "x" };
      expect(decodeOk(JSON.stringify(frame))).toMatchObject({ failure: { disposition } });
    }
    const legacy = sample("turn.end", 1);
    legacy["failure"] = { owner: "box", retryable: true, message: "x" };
    expectError(JSON.stringify(legacy), "invalid-field", "failure.disposition");
    const bad = sample("hibernate.done", 1);
    bad["failure"] = { owner: "box", disposition: "later", message: "x" };
    expectError(JSON.stringify(bad), "invalid-field", "failure.disposition");
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

  test("control and bidi characters are rejected", () => {
    for (const ch of ["\u0085", "\u009b", "؜", "‎", "‏", "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"]) {
      expectError(open(`invoice${ch}fdp.exe`), "invalid-field", "path");
    }
    expect(decodeOk(open("docs/résumé ✓.pdf"))).toMatchObject({ path: "docs/résumé ✓.pdf" });
  });

  test("vnc streams reject every file-only field alike", () => {
    expectError(JSON.stringify({ ...sample("stream.open"), path: "x" }), "invalid-field", "path");
    expectError(
      JSON.stringify({ ...sample("stream.open"), mode: "read" }),
      "invalid-field",
      "mode",
    );
    // A field no variant knows is still dropped, as for any frame.
    expect(decodeOk(JSON.stringify({ ...sample("stream.open"), addedInMinor: 1 }))).toEqual(
      SAMPLES["stream.open"][0] as Frame,
    );
  });
});

describe("encode", () => {
  test("throws instead of producing a text frame the decoder rejects", () => {
    const bad = [
      { type: "ping", nonce: -1 },
      { type: "ping", nonce: 1.5 },
      { type: "session.assign", sessionId: "a b", requestId: "a1", resume: false },
      { type: "stream.open", streamId: 2, kind: "vnc", mode: "read" },
      { type: "stream.open", streamId: 3, kind: "file", path: "../x", mode: "read" },
      { type: "turn.end", ...delivery, sessionId: "s", turnId: "t", outcome: "failed" },
      { type: "rpc", id: "q", method: "m", params: undefined },
      { type: "nope" },
    ] as unknown as Frame[];
    for (const frame of bad) {
      let thrown: unknown;
      try {
        encodeFrame(frame);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(EncodeError);
      expect(thrown).toBeInstanceOf(RangeError);
    }
  });

  test("refuses values JSON would change or cannot write", () => {
    const rpc = { type: "rpc", id: "q", method: "m" };
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    const cases: [unknown, string][] = [
      [[1, undefined], "params"],
      [{ list: [undefined] }, "params.list"],
      [{ n: Number.NaN }, "params.n"],
      [{ f: () => 1 }, "params.f"],
      [new Date(0), "params"],
      [{ at: new Date(0) }, "params.at"],
      [10n, "params"],
      [{ n: [1n] }, "params.n.0"],
      [{ toJSON: () => "x" }, "params"],
      [cyclic, "params.self"],
    ];
    for (const [params, path] of cases) {
      let thrown: unknown;
      try {
        encodeFrame({ ...rpc, params } as unknown as Frame);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(EncodeError);
      expect((thrown as EncodeError).error.path).toBe(path);
    }
    // A plain key named toJSON is ordinary JSON.
    expect(typeof encodeFrame({ ...rpc, params: { toJSON: 1 } } as unknown as Frame)).toBe(
      "string",
    );
  });

  test("encodes a hello of another major (the version check is the decoder's)", () => {
    const v2 = { ...SAMPLES.hello[0], version: { major: 2, minor: 0 } } as Frame;
    expect(typeof encodeFrame(v2)).toBe("string");
  });

  test.each([0x5eed, 1, 2, 3, 99, 12345])(
    "property: whatever encodes, decodes to the same frame (seed %d)",
    (seed) => {
      const random = seeded(seed);
      let encoded = 0;
      let refused = 0;
      for (let i = 0; i < 4000; i++) {
        const frame = mutate(ALL_SAMPLES[i % ALL_SAMPLES.length] as Frame, random);
        let wire: string | Uint8Array;
        try {
          wire = encodeFrame(frame);
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          refused++;
          continue;
        }
        encoded++;
        const result = decodeFrame(wire, frame.type === "hello" ? { version: frame.version } : {});
        if (!result.ok) throw new Error(`encoded but rejected: ${JSON.stringify(result.error)}`);
        expect(result.frame).toEqual(frame);
      }
      // Both branches must be exercised for the property to mean anything.
      expect(encoded).toBeGreaterThan(500);
      expect(refused).toBeGreaterThan(500);
    },
  );

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

describe("version first", () => {
  /** A hello as a hypothetical v2 might send it: same `type` and `version`, nothing else alike. */
  const v2Hello = JSON.stringify({
    type: "hello",
    version: { major: 2, minor: 4 },
    box: { id: 17, labels: ["gpu"] },
    auth: { scheme: "mtls" },
    resumeFrom: [3, 9],
  });

  test("a v2-shaped hello is a version-mismatch, not a malformed hello", () => {
    const result = decodeFrame(v2Hello);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "version-mismatch",
        message: "hello speaks protocol 2.4 but this side speaks 1.0; major versions must match",
        frameType: "hello",
        peerVersion: { major: 2, minor: 4 },
      },
    });
    if (result.ok) return;
    const reject = rejectHello(result.error);
    expect(reject).toEqual({
      type: "reject",
      reason: "version-mismatch",
      message: "box speaks protocol 2.4 but the hub speaks 1.0; major versions must match",
      hubVersion: PROTOCOL_VERSION,
      boxVersion: { major: 2, minor: 4 },
    });
    expect(decodeOk(encodeFrame(reject))).toEqual(reject);
  });

  test("an older major is refused the same way", () => {
    const v0 = JSON.stringify({ type: "hello", version: { major: 0, minor: 9 } });
    const result = decodeFrame(v0);
    expect(result.ok ? null : result.error.code).toBe("version-mismatch");
  });

  test("the decoder checks against the version it is given", () => {
    const ours = decodeFrame(JSON.stringify(SAMPLES.hello[0]), { version: { major: 2, minor: 0 } });
    expect(ours.ok ? null : ours.error.peerVersion).toEqual({ major: 1, minor: 0 });
    expect(decodeFrame(v2Hello, { version: { major: 2, minor: 0 } }).ok).toBe(false);
  });

  test("a same-major hello with a bad field is still malformed", () => {
    const broken = sample("hello");
    delete broken["boxId"];
    const result = decodeFrame(JSON.stringify(broken));
    if (result.ok) throw new Error("expected an error");
    expect(result.error.code).toBe("invalid-field");
    expect(rejectHello(result.error)).toEqual({
      type: "reject",
      reason: "malformed-hello",
      message: result.error.message,
    });
    expectError(
      JSON.stringify({ type: "hello", version: { major: "2" } }),
      "invalid-field",
      "version.major",
    );
  });
});

describe("box state in hello", () => {
  const withState = (state: unknown) => JSON.stringify({ ...sample("hello"), state });

  test("reports the session, the running turn and the last delivery id", () => {
    expect(decodeOk(JSON.stringify(SAMPLES.hello[1]))).toMatchObject({
      state: { sessionId: "s1", turnId: "t1", lastDeliveryId: 41 },
    });
    expect(decodeOk(withState({ sessionId: "s1", turnId: null, lastDeliveryId: 0 }))).toMatchObject(
      {
        state: { sessionId: "s1", turnId: null, lastDeliveryId: 0 },
      },
    );
  });

  test("is required and checked", () => {
    expectError(withState(undefined), "invalid-field", "state");
    expectError(
      withState({ sessionId: null, turnId: "t1", lastDeliveryId: 0 }),
      "invalid-field",
      "state.turnId",
    );
    expectError(withState({ turnId: null, lastDeliveryId: 0 }), "invalid-field", "state.sessionId");
    expectError(
      withState({ sessionId: "a b", turnId: null, lastDeliveryId: 0 }),
      "invalid-field",
      "state.sessionId",
    );
    for (const bad of [-1, 1.5, "3", null]) {
      expectError(
        withState({ sessionId: null, turnId: null, lastDeliveryId: bad }),
        "invalid-field",
        "state.lastDeliveryId",
      );
    }
  });

  test("hello stays fire-and-forget: the state is a snapshot sent on every connect", () => {
    expect(FRAME_SPECS.hello.guarantee).toBe("fire-and-forget");
  });
});

// ---------------------------------------------------------------------------
// Property-test helpers

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Values that are valid for some fields and invalid for others. */
const POOL: readonly unknown[] = [
  undefined,
  null,
  true,
  0,
  1,
  7,
  -1,
  1.5,
  2 ** 32,
  Number.MAX_SAFE_INTEGER + 1,
  Number.NaN,
  "",
  "s1",
  "a b",
  "../x",
  "dir/file.txt",
  "x‮y",
  "x".repeat(MAX_ID_LENGTH + 1),
  "retry-cold",
  "failed",
  "file",
  "vnc",
  "read",
  {},
  [],
  { kind: "text" },
  { major: 1, minor: 0 },
  { major: 2, minor: 0 },
  new Uint8Array([1, 2]),
  [1, undefined],
  { list: [undefined] },
  new Date(0),
  10n,
];

/** A copy of `frame` with one field, top-level or one object down, replaced by a pool value. */
function mutate(frame: Frame, random: () => number): Frame {
  const copy = structuredClone(frame) as unknown as Record<string, unknown>;
  if (random() < 0.15) return copy as unknown as Frame;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  let target = copy;
  let keys = Object.keys(copy).filter((k) => k !== "type");
  const nested = keys.filter((k) => {
    const v = copy[k];
    return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
  });
  if (nested.length > 0 && random() < 0.4) {
    target = copy[pick(nested)] as Record<string, unknown>;
    keys = Object.keys(target);
  }
  if (keys.length === 0) return copy as unknown as Frame;
  target[pick(keys)] = structuredClone(pick(POOL));
  return copy as unknown as Frame;
}
