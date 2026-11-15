import { expect, test } from "bun:test";
import { decodeFrame, encodeFrame, type Frame } from "@hearth/protocol";
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

/** What the fake hub can do on one connection. */
interface HubConnection {
  send(frame: Frame): void;
  close(): void;
}

/**
 * A fake hub on port 0. It welcomes every `hello`, then hands the connection
 * (and its 1-based number) to `script`. It records every frame the box sends,
 * and `next` waits for the first later frame that matches.
 */
function fakeHub(script: (hub: HubConnection, connection: number) => void) {
  const received: Frame[] = [];
  const waiters: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  let connections = 0;
  let current: HubConnection | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, srv) {
      if (srv.upgrade(request)) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, message) {
        const decoded = decodeFrame(
          typeof message === "string" ? message : new Uint8Array(message),
        );
        if (!decoded.ok) throw new Error(decoded.error.message);
        const frame = decoded.frame;
        received.push(frame);
        for (const waiter of [...waiters]) {
          if (!waiter.match(frame)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
        if (frame.type !== "hello") return;
        connections += 1;
        const connection: HubConnection = {
          send: (out) => ws.send(encodeFrame(out)),
          close: () => ws.close(),
        };
        current = connection;
        connection.send({ type: "welcome", version: frame.version, boxId: frame.boxId });
        script(connection, connections);
      },
    },
  });
  const next = (match: (frame: Frame) => boolean): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the fake hub waited too long")), 3_000);
      waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  return {
    url: `ws://127.0.0.1:${server.port}/v1/box/socket`,
    received,
    next,
    connection: () => {
      if (current === undefined) throw new Error("no box connected");
      return current;
    },
    stop: () => server.stop(true),
  };
}

function agentFor(url: string, lines: string[], outboxLimit?: number): BoxAgent {
  return new BoxAgent({
    hubUrl: url,
    boxId: "box_commands",
    joinToken: "hjt_test",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    random: () => 0,
    log: (line) => lines.push(line),
    ...(outboxLimit === undefined ? {} : { outboxLimit }),
  });
}

const isPong = (nonce: number) => (frame: Frame) => frame.type === "pong" && frame.nonce === nonce;

/** The command id a `turn.end` or `hibernate.done` answers. */
function answered(frame: Frame): string | undefined {
  if (frame.type === "turn.end") return frame.turnId;
  if (frame.type === "hibernate.done") return frame.requestId;
  return undefined;
}

const answers = (frames: readonly Frame[]) => frames.map(answered).filter((id) => id !== undefined);

const command = (kind: "turn.start" | "session.hibernate", id: string): Frame =>
  kind === "turn.start"
    ? { type: "turn.start", sessionId: "s1", turnId: id, input: "hi" }
    : { type: "session.hibernate", sessionId: "s1", requestId: id };

for (const kind of ["turn.start", "session.hibernate"] as const) {
  test(`a re-sent ${kind} is answered once (decision 0005)`, async () => {
    const hub = fakeHub((conn) => {
      conn.send(command(kind, "c1"));
      conn.send(command(kind, "c1"));
      conn.send(command(kind, "c2"));
      // The box answers frames in order, so the pong comes after all of the above.
      conn.send({ type: "ping", nonce: 1 });
    });
    const agent = agentFor(hub.url, []);
    try {
      const pong = hub.next(isPong(1));
      agent.start();
      await pong;
      expect(answers(hub.received)).toEqual(["c1", "c2"]);
    } finally {
      agent.stop();
      await hub.stop();
    }
  });
}

test("a re-sent session.assign is not applied again (decision 0005)", async () => {
  const hub = fakeHub((conn, connection) => {
    if (connection !== 1) return;
    conn.send({ type: "session.assign", sessionId: "s1", requestId: "a1", resume: false });
    conn.send({ type: "session.assign", sessionId: "s2", requestId: "a2", resume: true });
    // A late re-send of the first assignment must not take the box back to s1.
    conn.send({ type: "session.assign", sessionId: "s1", requestId: "a1", resume: false });
    conn.send({ type: "ping", nonce: 1 });
  });
  const agent = agentFor(hub.url, []);
  try {
    const pong = hub.next(isPong(1));
    agent.start();
    await pong;
    // The session the box holds is reported in the hello of its next connect.
    const reconnect = hub.next((frame) => frame.type === "hello");
    hub.connection().close();
    const hello = await reconnect;
    expect(hello.type === "hello" ? hello.state.sessionId : undefined).toBe("s2");
  } finally {
    agent.stop();
    await hub.stop();
  }
});

for (const kind of ["turn.start", "session.hibernate"] as const) {
  test(`a ${kind} refused by a full outbox is logged, and its re-send is answered once acked`, async () => {
    const hub = fakeHub((conn) => {
      conn.send(command(kind, "c1"));
      conn.send(command(kind, "c2"));
      conn.send({ type: "ping", nonce: 2 });
    });
    const lines: string[] = [];
    const agent = agentFor(hub.url, lines, 1);
    try {
      const full = hub.next(isPong(2));
      agent.start();
      await full;
      expect(answers(hub.received)).toEqual(["c1"]);
      const refused = lines.filter((line) => line.includes(`refused ${kind} c2`));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain("outbox.full");

      const first = hub.received.find((frame) => answered(frame) === "c1");
      if (first === undefined || !("deliveryId" in first)) throw new Error("c1 has no answer");
      const retried = hub.next((frame) => answered(frame) === "c2");
      hub.connection().send({
        type: "delivery.ack",
        bootId: first.bootId,
        deliveryId: first.deliveryId,
      });
      hub.connection().send(command(kind, "c2"));
      await retried;
      expect(answers(hub.received)).toEqual(["c1", "c2"]);
    } finally {
      agent.stop();
      await hub.stop();
    }
  });
}
