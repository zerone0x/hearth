/**
 * Test fixture: a box-agent child process that streams `turn.event` frames.
 *
 * It uses the real `BoxAgent` (connection, outbox, backoff), so a test can kill
 * and restart the hub mid-stream and check that every event arrives exactly
 * once. pi is not wired before M1, so nothing else produces a stream yet.
 *
 * Environment: HEARTH_HUB_URL, HEARTH_BOX_ID, HEARTH_JOIN_TOKEN, plus
 * STREAM_SESSION_ID, STREAM_COUNT and STREAM_INTERVAL_MS. Prints one JSON line
 * per milestone on stdout: `{"event":"emitted"}` when every frame is queued and
 * `{"event":"all-acked"}` once the hub acked them all.
 */

import { BoxAgent } from "../connection";

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const sessionId = need("STREAM_SESSION_ID");
const count = Number(need("STREAM_COUNT"));
const intervalMs = Number(need("STREAM_INTERVAL_MS"));

const agent = new BoxAgent({
  hubUrl: need("HEARTH_HUB_URL"),
  boxId: need("HEARTH_BOX_ID"),
  joinToken: need("HEARTH_JOIN_TOKEN"),
  reconnectBaseMs: 20,
  reconnectMaxMs: 200,
  log: (line) => console.error(line),
});
process.on("SIGTERM", () => agent.stop());
agent.start();

const say = (event: string) => console.log(JSON.stringify({ event, connects: agent.connects }));

for (let i = 1; i <= count; i++) {
  agent.send({
    type: "turn.event",
    sessionId,
    turnId: "turn_stream",
    seq: i,
    event: { kind: "test.tick", n: i },
  });
  await Bun.sleep(intervalMs);
}
say("emitted");

const poll = setInterval(() => {
  if (agent.outbox.size === 0) {
    clearInterval(poll);
    say("all-acked");
  }
}, 10);

const exit = await agent.done;
clearInterval(poll);
process.exit(exit.kind === "stopped" ? 0 : 3);
