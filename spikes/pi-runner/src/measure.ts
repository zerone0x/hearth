/**
 * Measures startup and memory of N concurrent runners in one Bun process
 * (issue #40). Run: `bun spikes/pi-runner/src/measure.ts [N] [turns]`.
 * Prints one JSON object; docs/spikes/pi-runner.md records the results.
 */
const t0 = performance.now();
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const { FakeBox } = await import("./fake-box");
const { createFauxRuntime, createRunner } = await import("./runner");
const importMs = performance.now() - t0;

const n = Number(process.argv[2] ?? 20);
const turns = Number(process.argv[3] ?? 5);
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
function snapshot() {
  Bun.gc(true);
  const { rss, heapUsed } = process.memoryUsage();
  return { rss, heapUsed };
}

type Context = { messages: Array<{ role: string }> };
const reply = (context: Context) =>
  context.messages.at(-1)?.role === "toolResult"
    ? fauxAssistantMessage("done ".repeat(50))
    : fauxAssistantMessage(fauxToolCall("bash", { command: "cat big.log" }), {
        stopReason: "toolUse",
      });

const root = mkdtempSync(join(tmpdir(), "hearth-pi-measure-"));
try {
  const runtime = await createFauxRuntime(root);
  runtime.faux.setResponses(Array.from({ length: n * turns * 2 }, () => reply));
  const base = snapshot();

  const firstStart = performance.now();
  const start = async () => {
    const box = new FakeBox();
    return { box, ...(await createRunner({ box, runtime, agentDir: root, boxHome: "/" })) };
  };
  const first = await start();
  const firstMs = performance.now() - firstStart;

  const restStart = performance.now();
  const rest = await Promise.all(Array.from({ length: n - 1 }, () => start()));
  const restMs = performance.now() - restStart;
  const runners = [first, ...rest];
  const created = snapshot();

  // Each turn: one routed bash call returning ~4 KB, then a text reply.
  const output = "x".repeat(79).concat("\n").repeat(50);
  const turnsStart = performance.now();
  for (let t = 0; t < turns; t++) {
    await Promise.all(
      runners.map((r, i) => {
        r.box.execHandler = async ({ emit }) => {
          emit(output);
          return 0;
        };
        return r.session.prompt(`turn ${t} of session ${i}`);
      }),
    );
  }
  const turnsMs = performance.now() - turnsStart;
  const afterTurns = snapshot();

  for (const r of runners) r.session.dispose();
  const disposed = snapshot();

  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        sessions: n,
        turnsPerSession: turns,
        importPiMs: Math.round(importMs),
        firstSessionMs: Math.round(firstMs),
        nextSessionsConcurrentMs: Math.round(restMs),
        perExtraSessionMs: Math.round((restMs / Math.max(1, n - 1)) * 10) / 10,
        allTurnsMs: Math.round(turnsMs),
        rssMB: {
          afterImport: mb(base.rss),
          afterCreate: mb(created.rss),
          afterTurns: mb(afterTurns.rss),
          afterDispose: mb(disposed.rss),
        },
        heapUsedMB: {
          afterImport: mb(base.heapUsed),
          afterCreate: mb(created.heapUsed),
          afterTurns: mb(afterTurns.heapUsed),
          afterDispose: mb(disposed.heapUsed),
        },
        perSessionHeapMB: {
          created: mb((created.heapUsed - base.heapUsed) / n),
          afterTurns: mb((afterTurns.heapUsed - base.heapUsed) / n),
        },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
