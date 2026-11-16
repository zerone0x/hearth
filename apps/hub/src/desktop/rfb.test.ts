/** The RFB input filter (decisions 0016, 0033): what a viewer may send, and what it may not. */

import { describe, expect, test } from "bun:test";
import { MAX_CUT_TEXT_BYTES, MAX_ENCODINGS, RfbInputFilter, RfbViolation } from "./rfb";

const enc = (s: string) => new TextEncoder().encode(s);

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

function i32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return [...b];
}

/** Version, security None, ClientInit not shared. */
const HANDSHAKE = bytes(enc("RFB 003.008\n"), [1], [0]);
const SET_PIXEL_FORMAT = bytes([0, 0, 0, 0], new Array(16).fill(7));
const UPDATE_REQUEST = bytes([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const KEY = bytes([4, 1, 0, 0, 0, 0, 0, 0x61]);
const POINTER = bytes([5, 1, 0, 10, 0, 20]);
const CUT = bytes([6, 0, 0, 0], i32(5), enc("hello"));
const DESKTOP_SIZE = bytes([251, 0, 4, 0, 3, 0, 1, 0], new Array(16).fill(0));
const QEMU_KEY = bytes([255, 0, 0, 1], new Array(8).fill(0));
const ENABLE_CU = bytes([150, 1], new Array(8).fill(0));
const FENCE = bytes([248, 0, 0, 0, 0, 0, 0, 0, 2, 9, 9]);

function setEncodings(list: number[]): Uint8Array {
  return bytes([2, 0, list.length >> 8, list.length & 0xff], ...list.map(i32));
}

function feed(filter: RfbInputFilter, input: Uint8Array, chunk: number): Uint8Array {
  const out: number[] = [];
  for (let at = 0; at < input.byteLength; at += chunk) {
    out.push(...filter.push(input.subarray(at, at + chunk)));
  }
  return Uint8Array.from(out);
}

describe("RfbInputFilter", () => {
  test("passes the handshake with ClientInit forced to shared, and the view messages", () => {
    for (const chunk of [1, 3, 7, 1000]) {
      const filter = new RfbInputFilter();
      const input = bytes(
        HANDSHAKE,
        SET_PIXEL_FORMAT,
        setEncodings([7, 0, -223, -313, -312, -258, -308]),
        UPDATE_REQUEST,
      );
      const out = feed(filter, input, chunk);
      expect([...out]).toEqual([
        ...enc("RFB 003.008\n"),
        1,
        1, // shared
        ...SET_PIXEL_FORMAT,
        ...setEncodings([7, 0, -223, -308]),
        ...UPDATE_REQUEST,
      ]);
      expect(filter.dropped).toBe(0);
    }
  });

  test("drops every input message, whole, at any chunking", () => {
    for (const chunk of [1, 2, 5, 4096]) {
      const filter = new RfbInputFilter();
      filter.push(HANDSHAKE);
      const input = bytes(
        KEY,
        UPDATE_REQUEST,
        POINTER,
        CUT,
        DESKTOP_SIZE,
        QEMU_KEY,
        ENABLE_CU,
        FENCE,
        UPDATE_REQUEST,
      );
      expect([...feed(filter, input, chunk)]).toEqual([...UPDATE_REQUEST, ...UPDATE_REQUEST]);
      expect(filter.dropped).toBe(7);
    }
  });

  test("skips extended (negative-length) clipboard text too", () => {
    const filter = new RfbInputFilter();
    filter.push(HANDSHAKE);
    const out = filter.push(bytes([6, 0, 0, 0], i32(-4), [1, 2, 3, 4], UPDATE_REQUEST));
    expect([...out]).toEqual([...UPDATE_REQUEST]);
  });

  test("ends the stream on what it cannot follow", () => {
    const cases: [string, Uint8Array][] = [
      ["RFB 003.003", enc("RFB 003.003\n")],
      ["garbage version", enc("GET / HTTP/1")],
      ["VNC auth", bytes(enc("RFB 003.008\n"), [2])],
      ["unknown type", bytes(HANDSHAKE, [7])],
      [
        "too many encodings",
        bytes(HANDSHAKE, [2, 0, (MAX_ENCODINGS + 1) >> 8, (MAX_ENCODINGS + 1) & 0xff]),
      ],
      ["huge cut text", bytes(HANDSHAKE, [6, 0, 0, 0], i32(MAX_CUT_TEXT_BYTES + 1))],
      ["qemu audio", bytes(HANDSHAKE, [255, 1])],
      ["long fence", bytes(HANDSHAKE, [248, 0, 0, 0, 0, 0, 0, 0, 65])],
    ];
    for (const [name, input] of cases) {
      const filter = new RfbInputFilter();
      expect(() => filter.push(input), name).toThrow(RfbViolation);
    }
  });

  test("forwards nothing before the version line is complete", () => {
    const filter = new RfbInputFilter();
    expect(filter.push(enc("RFB 003.00")).byteLength).toBe(0);
    expect(new TextDecoder().decode(filter.push(enc("8\n")))).toBe("RFB 003.008\n");
  });

  test("a message at the encodings cap passes", () => {
    const filter = new RfbInputFilter();
    filter.push(HANDSHAKE);
    const list = new Array(MAX_ENCODINGS).fill(5);
    expect(filter.push(setEncodings(list)).byteLength).toBe(4 + 4 * MAX_ENCODINGS);
  });
});

describe("RfbInputFilter gate (the desktop lock, decision 0033)", () => {
  const VIEW = bytes(HANDSHAKE, UPDATE_REQUEST);
  const VIEW_OUT = bytes(enc("RFB 003.008\n"), [1, 1], UPDATE_REQUEST);

  test("while the gate allows, key and pointer events pass whole, at any chunking", () => {
    for (const chunk of [1, 3, 7, 1000]) {
      const filter = new RfbInputFilter(() => true);
      const out = feed(filter, bytes(VIEW, KEY, POINTER, UPDATE_REQUEST), chunk);
      expect([...out]).toEqual([...VIEW_OUT, ...KEY, ...POINTER, ...UPDATE_REQUEST]);
      expect(filter.passed).toBe(2);
      expect(filter.dropped).toBe(0);
    }
  });

  test("the gate never opens the other input: clipboard, desktop size, QEMU keys", () => {
    const filter = new RfbInputFilter(() => true);
    const out = feed(filter, bytes(VIEW, CUT, DESKTOP_SIZE, QEMU_KEY, ENABLE_CU, FENCE), 1000);
    expect([...out]).toEqual([...VIEW_OUT]);
    expect(filter.passed).toBe(0);
    expect(filter.dropped).toBe(5);
  });

  test("the gate is asked per message: input stops at the first message after it closes", () => {
    let open = true;
    const asked: number[] = [];
    const filter = new RfbInputFilter(() => {
      asked.push(asked.length);
      return open;
    });
    expect([...filter.push(VIEW)]).toEqual([...VIEW_OUT]);
    expect(asked.length).toBe(0); // the handshake and view messages never ask
    expect([...filter.push(KEY)]).toEqual([...KEY]);
    open = false;
    // A key event split across two pushes is judged once, when it is complete.
    expect([...filter.push(POINTER.subarray(0, 3))]).toEqual([]);
    expect([...filter.push(bytes(POINTER.subarray(3), KEY, UPDATE_REQUEST))]).toEqual([
      ...UPDATE_REQUEST,
    ]);
    expect(filter.dropped).toBe(2);
    open = true;
    expect([...filter.push(POINTER)]).toEqual([...POINTER]);
    expect(asked.length).toBe(4);
    expect(filter.passed).toBe(2);
  });

  test("the default gate is view-only", () => {
    const filter = new RfbInputFilter();
    expect([...feed(filter, bytes(VIEW, KEY, POINTER), 1000)]).toEqual([...VIEW_OUT]);
    expect(filter.dropped).toBe(2);
  });
});
