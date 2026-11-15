import { describe, expect, test } from "bun:test";
import { LOG_REDACTED, Logger, parseLogLevel, redactLine } from "./log";

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
