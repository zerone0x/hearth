import { describe, expect, test } from "bun:test";
import { LOG_REDACTED, Logger, parseLogLevel, redactLine, redactValues, secretForms } from "./log";

function capture(secrets: string[] = [], level?: "debug" | "info") {
  const lines: string[] = [];
  const logger = new Logger({
    component: "test",
    sink: (l) => lines.push(l),
    redact: (l) => redactLine(l, secrets),
    now: () => 0,
    ...(level === undefined ? {} : { level }),
  });
  return { lines, logger, parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe("Logger", () => {
  test("one JSON object per line with level, component, msg and ids", () => {
    const { logger, parsed } = capture();
    logger.child({ session_id: "se_1" }).child({ turn_id: "tu_1" }, "runner").info("hi", { n: 1 });
    expect(parsed()).toEqual([
      {
        ts: "1970-01-01T00:00:00.000Z",
        level: "info",
        component: "runner",
        msg: "hi",
        session_id: "se_1",
        turn_id: "tu_1",
        n: 1,
      },
    ]);
  });

  test("drops lines below the level", () => {
    const { logger, lines } = capture();
    logger.debug("quiet");
    expect(lines).toHaveLength(0);
    const verbose = capture([], "debug");
    verbose.logger.debug("loud");
    expect(verbose.lines).toHaveLength(1);
  });

  test("errors become message and code fields", () => {
    const { logger, parsed } = capture();
    const e = Object.assign(new Error("boom"), { code: "box.lost" });
    logger.error("failed", { session_id: "se_1" }, e);
    expect(parsed()[0]).toMatchObject({ level: "error", error: "boom", error_code: "box.lost" });
  });

  test("a known secret is redacted at the sink, in the message, fields and errors", () => {
    const secret = 'sec"ret-value-123';
    const { logger, lines } = capture([secret]);
    logger
      .child({ key: secret })
      .error(`echo ${secret}`, { nested: { v: secret } }, new Error(secret));
    expect(lines.join("\n")).not.toContain("ret-value-123");
    expect(lines.join("\n")).toContain(LOG_REDACTED);
  });

  test("a known secret is redacted raw, not only inside a JSON string", () => {
    expect(redactLine("plain plainSecretValue42 here", ["plainSecretValue42"])).toBe(
      `plain ${LOG_REDACTED} here`,
    );
  });

  test("overlapping secrets leave no tail, in either order of the list", () => {
    const user = "probeadmin";
    const password = "probeadmin-Zq9!SuffixLeak";
    for (const secrets of [
      [user, password],
      [password, user],
    ]) {
      expect(redactLine(`u=${user} pw=${password} end`, secrets)).toBe(
        `u=${LOG_REDACTED} pw=${LOG_REDACTED} end`,
      );
    }
    // Two values that overlap without one containing the other: one span.
    for (const secrets of [
      ["abc-OVER", "OVER-xyz"],
      ["OVER-xyz", "abc-OVER"],
    ]) {
      expect(redactValues("[abc-OVER-xyz]", secrets, "#")).toBe("[#]");
    }
    // The JSON-escaped form overlaps the raw one of another value.
    const quoted = 'zzpart"q-tail';
    for (const secrets of [
      ["zzpart", quoted],
      [quoted, "zzpart"],
    ]) {
      const line = JSON.stringify({ a: quoted, b: "zzpart" });
      expect(redactLine(line, secrets)).toBe(`{"a":"${LOG_REDACTED}","b":"${LOG_REDACTED}"}`);
    }
    expect(redactValues("no secret here", ["absent"], "#")).toBe("no secret here");
    expect(redactValues("aaaa", ["aa", ""], "#")).toBe("#");
    expect(redactValues("x-ab-y-ab", ["ab"], "#")).toBe("x-#-y-#");
    // A value that overlaps its own next occurrence is one span: nothing of it is left.
    expect(redactValues("x ababab y", ["abab"], "#")).toBe("x # y");
    expect(redactValues("pw=aaaa", ["aaa"], "#")).toBe("pw=#");
    expect(redactLine("x ababab y", ["abab"])).toBe(`x ${LOG_REDACTED} y`);
    // Touching values are one span; a value with a quote is found raw too.
    expect(redactValues("<abcdef>", ["def", "abc"], "#")).toBe("<#>");
    expect(redactValues('raw a"b\\c here', ['a"b\\c'], "#")).toBe("raw # here");
  });

  test("a value is found URL-encoded too, in each encoding and either hex case", () => {
    const value = 'Pw d!@#x9&"q';
    expect(secretForms(value)).toEqual([
      value,
      'Pw d!@#x9&\\"q',
      "Pw%20d!%40%23x9%26%22q",
      "Pw+d%21%40%23x9%26%22q",
      "Pw%20d!@#x9&%22q",
    ]);
    // A GET form submit writes the value form-urlencoded into the URL.
    expect(redactValues("/landing?u=&p=Pw+d%21%40%23x9%26%22q", [value], "#")).toBe(
      "/landing?u=&p=#",
    );
    expect(redactValues("?p=Pw%20d!%40%23x9%26%22q&n=1", [value], "#")).toBe("?p=#&n=1");
    expect(redactValues("/go/Pw%20d!@#x9&%22q/end", [value], "#")).toBe("/go/#/end");
    // Lower-case hex is the same URL.
    expect(redactValues("?p=Pw+d%21%40%23x9%26%22q", [value], "#")).toBe("?p=#");
    expect(redactValues("?p=pw+d%21%40%23x9%26%22q", [value], "#")).toBe(
      "?p=pw+d%21%40%23x9%26%22q",
    );
    expect(redactValues("?p=Pw+d%21%40%23x9%26%22Q", [value], "#")).toBe(
      "?p=Pw+d%21%40%23x9%26%22Q",
    );
    expect(redactLine("a=x%2fy%20z b=x%2Fy+z", ["x/y z"])).toBe(
      `a=${LOG_REDACTED} b=${LOG_REDACTED}`,
    );
    // An encoded form overlapping another value's raw form is one span.
    for (const secrets of [
      ["a b", "b-tail]"],
      ["b-tail]", "a b"],
    ]) {
      expect(redactValues("[a%20b-tail] end", secrets, "#")).toBe("[# end");
    }
    // An encoded form that overlaps its own next occurrence is one span too (#140):
    // `x%2Fx` at 0 and at 4, so no `%2Fx` tail is left, in either hex case.
    expect(redactValues("x%2Fx%2Fx", ["x/x"], "#")).toBe("#");
    expect(redactValues("[x%2fx%2Fx]", ["x/x"], "#")).toBe("[#]");
    // Regex characters in a value are literal.
    expect(redactValues("a.b%20 axb%20", ["a.b "], "#")).toBe("# axb%20");
    // A plain value has one form; a lone surrogate has no URL form but is still found raw.
    expect(secretForms("abc123")).toEqual(["abc123"]);
    expect(secretForms("x\ud800")).toEqual(["x\ud800", "x\\ud800"]);
    expect(redactValues("x\ud800 y", ["x\ud800"], "#")).toBe("# y");
  });

  test("credential shapes are redacted without being known", () => {
    const line = redactLine(
      'Authorization: Bearer abcdefghijk.lmn sk-ant-REALKEY1234567890 {"token":"tok_123456789"} password=hunter22',
    );
    expect(line).not.toContain("abcdefghijk");
    expect(line).not.toContain("REALKEY1234567890");
    expect(line).not.toContain("tok_123456789");
    expect(line).not.toContain("hunter22");
    expect(line).toContain(`Bearer ${LOG_REDACTED}`);
  });

  test("the default redactor runs even without one configured", () => {
    const lines: string[] = [];
    new Logger({ component: "c", sink: (l) => lines.push(l) }).info("key sk-abcdefghijklmnopqrstu");
    expect(lines[0]).not.toContain("abcdefghijklmnopqrstu");
  });

  test("parseLogLevel", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("debug")).toBe("debug");
    expect(() => parseLogLevel("loud")).toThrow();
  });
});
