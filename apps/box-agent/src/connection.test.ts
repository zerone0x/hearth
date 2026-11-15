import { expect, test } from "bun:test";
import { BoxAgent } from "./connection";

test("every failed dial is logged with its attempt number, next delay and reason", async () => {
  // A port that was free a moment ago: nothing listens on it now.
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const url = `ws://127.0.0.1:${port}/v1/box/socket`;

  const lines: string[] = [];
  const agent = new BoxAgent({
    hubUrl: url,
    boxId: "box_unreachable",
    joinToken: "hjt_unused",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    random: () => 0,
    log: (line) => lines.push(line),
  });
  agent.start();
  const dials = () => lines.filter((l) => l.includes("dial attempt"));
  const deadline = Date.now() + 3_000;
  while (dials().length < 3 && Date.now() < deadline) await Bun.sleep(10);
  agent.stop();

  const logged = dials();
  expect(logged.length).toBeGreaterThanOrEqual(3);
  // Delays with random() = 0 are half the capped exponential: 5, 10, 10 ms.
  expect(logged[0]).toStartWith(`box-agent: dial attempt 1 to ${url} failed: could not connect (`);
  expect(logged[0]).toEndWith("; next attempt in 5 ms");
  expect(logged[1]).toContain("dial attempt 2 ");
  expect(logged[1]).toEndWith("; next attempt in 10 ms");
  expect(logged[2]).toContain("dial attempt 3 ");
  expect(logged[2]).toEndWith("; next attempt in 10 ms");
});
