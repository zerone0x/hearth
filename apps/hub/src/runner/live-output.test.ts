import { describe, expect, test } from "bun:test";
import { LiveToolOutput, type ToolOutputPayload } from "./live-output";
import { redactSecrets } from "./runner";

const SECRET = "sk-live-0123456789abcdef";
const redact = (text: string) => redactSecrets(text, [SECRET]);
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
    append: s.append,
    log: (line) => logs.push(line),
    intervalMs: 5,
    ...extra,
  });
  return { out, logs };
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
});
