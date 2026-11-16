import { describe, expect, test } from "bun:test";
import { LiveToolOutput, type ToolOutputPayload } from "./live-output";
import { redactSecrets, secretStart } from "./runner";

const SECRET = "sk-live-0123456789abcdef";
const redact = (text: string) => redactSecrets(text, [SECRET]);
/** The runner's redactor for `secrets`, as `SessionRunners` builds it. */
const redactor = (secrets: string[]) => ({
  redact: (text: string) => redactSecrets(text, secrets),
  secretStart: (text: string) => secretStart(text, secrets),
});
const bytes = (text: string) => new TextEncoder().encode(text);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A sink whose appends resolve at once, or when the test says so. */
function sink(options: { gated?: boolean; fail?: boolean } = {}) {
  const events: ToolOutputPayload[] = [];
  const gates: Array<() => void> = [];
  let calls = 0;
  const append = (payload: ToolOutputPayload) => {
    calls += 1;
    if (options.fail === true) return Promise.reject(new Error("disk full"));
    events.push(payload);
    if (options.gated !== true) return Promise.resolve();
    return new Promise<void>((resolve) => gates.push(resolve));
  };
  return {
    events,
    append,
    get calls() {
      return calls;
    },
    open: () => {
      for (const g of gates.splice(0)) g();
    },
    text: () => events.map((e) => e.text).join(""),
  };
}

function live(
  s: ReturnType<typeof sink>,
  extra: Partial<ConstructorParameters<typeof LiveToolOutput>[0]> = {},
) {
  const logs: string[] = [];
  const out = new LiveToolOutput({
    toolCallId: "call_1",
    redact,
    secretStart: (text) => secretStart(text, [SECRET]),
    append: s.append,
    log: (line) => logs.push(line),
    intervalMs: 5,
    ...extra,
  });
  return { out, logs };
}

/** A secret of `length` characters no 8-character run of which repeats or meets filler text. */
function pseudoSecret(length: number, seed: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWZ0123456789";
  let state = seed * 2654435761;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

/** The first 8-character piece of `secret` that `text` shows, if any. */
function shownPart(text: string, secret: string): string | undefined {
  const pieces = new Set<string>();
  for (let i = 0; i + 8 <= secret.length; i += 1) pieces.add(secret.slice(i, i + 8));
  for (let i = 0; i + 8 <= text.length; i += 1) {
    const piece = text.slice(i, i + 8);
    if (pieces.has(piece)) return piece;
  }
  return undefined;
}

describe("LiveToolOutput", () => {
  test("coalesces the chunks of one interval into one event", async () => {
    const s = sink();
    const { out } = live(s, { intervalMs: 30 });
    for (const line of ["a\n", "b\n", "c\n"]) out.write(bytes(line));
    expect(s.events).toHaveLength(0);
    await wait(60);
    expect(s.events).toEqual([{ toolCallId: "call_1", seq: 0, text: "a\nb\nc\n" }]);
    out.write(bytes("d\n"));
    await wait(60);
    expect(s.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(s.text()).toBe("a\nb\nc\nd\n");
  });

  test("a slow store gets one append at a time; output that waits goes out with the next", async () => {
    const s = sink({ gated: true });
    const { out } = live(s);
    out.write(bytes("one\n"));
    await wait(20);
    expect(s.calls).toBe(1);
    // The store is stuck: writes return at once and pile into the next event.
    for (let i = 0; i < 100; i += 1) out.write(bytes(`line ${i}\n`));
    await wait(40);
    expect(s.calls).toBe(1);
    s.open();
    await wait(30);
    expect(s.calls).toBe(2);
    expect(s.events[1]?.text.split("\n").length).toBe(101);
    s.open();
  });

  test("never emits a secret split across two chunks", async () => {
    const s = sink();
    const { out } = live(s);
    const cut = 10;
    out.write(bytes(`token ${SECRET.slice(0, cut)}`));
    await wait(30);
    // Nothing yet: the line is not complete, so the half secret waits.
    expect(s.events).toHaveLength(0);
    out.write(bytes(`${SECRET.slice(cut)} ok\nnext\n`));
    await wait(30);
    expect(s.text()).toBe("token [redacted] ok\nnext\n");
    for (const e of s.events) expect(e.text).not.toContain(SECRET.slice(0, cut));
  });

  test("every split point of a secret, line by line", async () => {
    for (let cut = 1; cut < SECRET.length; cut += 1) {
      const s = sink();
      const { out } = live(s, { intervalMs: 1 });
      out.write(bytes(`a\nb ${SECRET.slice(0, cut)}`));
      await wait(5);
      out.write(bytes(`${SECRET.slice(cut)}\n`));
      await wait(10);
      out.close();
      expect(s.text()).toBe("a\nb [redacted]\n");
      for (const e of s.events) expect(e.text).not.toContain(SECRET.slice(0, Math.max(cut, 3)));
    }
  });

  test("a long line is emitted in parts, holding back its tail, so a split secret stays whole", async () => {
    const s = sink();
    const { out } = live(s, { longLineChars: 100, holdChars: 40 });
    const filler = "x".repeat(200);
    out.write(bytes(`${filler}${SECRET.slice(0, 12)}`));
    await wait(30);
    // The part before the hold is out; the half secret is not.
    expect(s.text()).toBe(filler.slice(0, 200 + 12 - 40));
    out.write(bytes(`${SECRET.slice(12)}${"y".repeat(100)}\n`));
    await wait(30);
    expect(s.text()).toBe(`${filler}[redacted]${"y".repeat(100)}\n`);
    expect(s.text()).not.toContain(SECRET.slice(0, 12));
  });

  test("a complete secret across a candidate cut moves the cut back", async () => {
    const twoLines = "AAAA\nBBBB";
    const s = sink();
    const { out } = live(s, { redact: (t) => redactSecrets(t, [twoLines]) });
    out.write(bytes(`pre\n${twoLines} post`));
    await wait(30);
    // Cutting after "AAAA\n" would show half of the secret: only "pre\n" goes.
    expect(s.text()).toBe("pre\n");
    out.write(bytes("\n"));
    await wait(30);
    expect(s.text()).toBe("pre\n[redacted] post\n");
  });

  test("caps the streamed bytes per call and says so once", async () => {
    const s = sink();
    const { out } = live(s, { maxBytes: 13 });
    out.write(bytes("12345\n"));
    // The cap falls after "ab": the cut-off line is held back and dropped.
    out.write(bytes("6789\nabcdef\n"));
    await wait(30);
    out.write(bytes("more\n"));
    await wait(30);
    expect(s.text()).toBe("12345\n6789\n");
    expect(s.events.at(-1)?.truncated).toBe(true);
    expect(s.events.filter((e) => e.truncated === true)).toHaveLength(1);
    expect(s.text()).not.toContain("a");
  });

  test("a character split across two chunks is decoded whole", async () => {
    const s = sink();
    const { out } = live(s);
    const all = bytes("snow ☃ done\n");
    out.write(all.subarray(0, 6));
    out.write(all.subarray(6));
    await wait(30);
    expect(s.text()).toBe("snow ☃ done\n");
  });

  test("a long line of emoji is never cut inside a surrogate pair", async () => {
    const s = sink();
    const { out } = live(s, { longLineChars: 10, holdChars: 3 });
    // 20 emoji are 40 UTF-16 units; the hold cut (37) falls inside a pair.
    out.write(bytes("😀".repeat(20)));
    await wait(30);
    expect(s.events.length).toBeGreaterThan(0);
    for (const e of s.events) expect(e.text.isWellFormed()).toBe(true);
    expect(s.text()).toBe("😀".repeat(18));
  });

  test("close stops it: nothing held back or written later is emitted", async () => {
    const s = sink();
    const { out } = live(s);
    out.write(bytes(`done\n${SECRET.slice(0, 8)}`));
    out.close();
    out.write(bytes("later\n"));
    await wait(30);
    expect(s.events).toHaveLength(0);
  });

  test("a failed append stops this call's live output and is logged", async () => {
    const s = sink({ fail: true });
    const { out, logs } = live(s);
    out.write(bytes("a\n"));
    await wait(30);
    out.write(bytes("b\n"));
    await wait(30);
    expect(s.calls).toBe(1);
    expect(logs.join("\n")).toContain("live output of call_1 stopped: disk full");
  });

  test("a 2000-char secret on a 4000-char line, split across chunks, never shows in part", async () => {
    const secret = pseudoSecret(2000, 1);
    const s = sink();
    const { out } = live(s, redactor([secret]));
    out.write(bytes(`${"x".repeat(4000)}${secret.slice(0, 1500)}`));
    await wait(30);
    out.write(bytes(`${secret.slice(1500)}\n`));
    await wait(30);
    out.close();
    expect(s.text()).toBe(`${"x".repeat(4000)}[redacted]\n`);
    expect(shownPart(s.text(), secret)).toBeUndefined();
  });

  test("a PEM split at a line break between chunks never shows a line of it", async () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "q9Zr0d4x2Y1kLmN8pQrStUvWxYz0a1b2c3d4e5f6g7h8i9j0kLmN",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const firstLineEnd = pem.indexOf("\n") + 1;
    for (const cut of [firstLineEnd, pem.indexOf("\n", firstLineEnd) + 1]) {
      const s = sink();
      const { out } = live(s, redactor([pem]));
      out.write(bytes(`head\n${pem.slice(0, cut)}`));
      await wait(30);
      // Only the line before the key goes; its first lines wait for the rest.
      expect(s.text()).toBe("head\n");
      out.write(bytes(`${pem.slice(cut)}\ntail\n`));
      await wait(30);
      out.close();
      expect(s.text()).toBe("head\n[redacted]\ntail\n");
      expect(s.text()).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  test("every split offset of a 64-char and a 1500-char secret, on short and long lines", async () => {
    const cases = [
      { secret: pseudoSecret(64, 2), pre: "a\nb ", long: {} },
      // A hold shorter than the secret: only the secret-start rule keeps it whole.
      {
        secret: pseudoSecret(64, 3),
        pre: "x".repeat(200),
        long: { longLineChars: 100, holdChars: 40 },
      },
      { secret: pseudoSecret(1500, 4), pre: "a\nb ", long: {} },
      { secret: pseudoSecret(1500, 5), pre: "x".repeat(4000), long: {} },
    ];
    for (const { secret, pre, long } of cases) {
      // One stream per offset, all at once, so the test stays fast.
      const runs = [];
      for (let cut = 1; cut < secret.length; cut += 1) {
        const s = sink();
        runs.push({ cut, s, out: live(s, { ...redactor([secret]), intervalMs: 1, ...long }).out });
      }
      for (const r of runs) r.out.write(bytes(`${pre}${secret.slice(0, r.cut)}`));
      await wait(20);
      for (const r of runs) r.out.write(bytes(`${secret.slice(r.cut)} end\n`));
      await wait(40);
      for (const r of runs) {
        r.out.close();
        const shown = shownPart(r.s.text(), secret);
        if (shown !== undefined) throw new Error(`cut ${r.cut} of ${secret.length} shows ${shown}`);
        expect(r.s.text()).toBe(`${pre}[redacted] end\n`);
      }
    }
  }, 30_000);

  test("a JSON-escaped secret on a long line is held back from its first character", async () => {
    const secret = `pa"ss\\word-${pseudoSecret(40, 6)}`;
    const escaped = JSON.stringify(secret).slice(1, -1);
    for (let cut = 1; cut < escaped.length; cut += 1) {
      const s = sink();
      const { out } = live(s, { ...redactor([secret]), longLineChars: 20, holdChars: 4 });
      out.write(bytes(`{"k":"${"y".repeat(60)}${escaped.slice(0, cut)}`));
      await wait(15);
      expect(s.text()).not.toContain("pa\\");
      out.write(bytes(`${escaped.slice(cut)}"}\n`));
      await wait(15);
      out.close();
      expect(s.text()).toBe(`{"k":"${"y".repeat(60)}[redacted]"}\n`);
    }
  });

  test("a carriage return ends a line: progress output shows while it runs", async () => {
    const s = sink();
    const { out } = live(s);
    out.write(bytes("10%\r20%\r30"));
    await wait(30);
    expect(s.text()).toBe("10%\r20%\r");
  });

  test("a line that is not long waits whole for its break", async () => {
    const s = sink();
    const { out } = live(s);
    // 2000 chars: past the hold, short of a long line.
    out.write(bytes(`a\n${"y".repeat(2000)}`));
    await wait(30);
    expect(s.text()).toBe("a\n");
  });

  test("write says when it takes no more, so the box can be told to stop", async () => {
    const s = sink();
    const { out } = live(s, { maxBytes: 8 });
    expect(out.write(bytes("1234\n"))).toBe(true);
    expect(out.write(bytes("5678\n"))).toBe(false);
    expect(out.write(bytes("more\n"))).toBe(false);
    const closed = live(sink()).out;
    expect(closed.write(bytes("a\n"))).toBe(true);
    closed.close();
    expect(closed.write(bytes("b\n"))).toBe(false);
  });
});

describe("secretStart", () => {
  test("finds the longest tail that is a proper prefix of a secret, raw or JSON-escaped", () => {
    expect(secretStart("abc sk-li", [SECRET])).toBe(4);
    expect(secretStart("abc s", [SECRET])).toBe(4);
    expect(secretStart("abc sk-x", [SECRET])).toBe(8);
    // A tail that starts like the secret but then differs is not held.
    expect(secretStart("abc sk-live-0X", [SECRET])).toBe(14);
    expect(secretStart("", [SECRET])).toBe(0);
    // A whole secret at the end is the redactor's job, not a tail.
    expect(secretStart(`abc ${SECRET}`, [SECRET])).toBe(4 + SECRET.length);
    // Repeats inside the secret: the longest matching tail wins.
    expect(secretStart("xaaa", ["aaaab"])).toBe(1);
    expect(secretStart('k "pa\\"s', ['pa"ss'])).toBe(3);
    expect(secretStart("k pa", ['pa"ss', "zzz"])).toBe(2);
    expect(secretStart("k pa", [""])).toBe(4);
    // A longer secret that starts with a shorter one holds the shorter back.
    expect(secretStart("k abc", ["abc", "abcdef"])).toBe(2);
  });
});
