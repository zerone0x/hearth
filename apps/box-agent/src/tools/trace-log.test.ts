/** box-agent logs each tool call as JSON with the hub's trace ids (decision 0021). */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@hearth/core";
import type { RpcResultFrame } from "@hearth/protocol";
import { ToolExecutor } from "./executor";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

async function run(frameExtra: Record<string, unknown>, method = "tool.exists") {
  const root = mkdtempSync(join(tmpdir(), "hearth-trace-log-"));
  dirs.push(root);
  const lines: string[] = [];
  const answers: RpcResultFrame[] = [];
  const executor = new ToolExecutor({
    root,
    send: (f) => answers.push(f),
    logger: new Logger({ component: "box-agent.tools", sink: (l) => lines.push(l) }),
  });
  const params =
    method === "tool.exec"
      ? { callId: "c_1", command: "exit 3", cwd: root, timeoutMs: 5000 }
      : { callId: "c_1", path: root };
  executor.handle({ type: "rpc", id: "tool_1", method, params, ...frameExtra });
  for (let i = 0; i < 200 && answers.length === 0; i++) await Bun.sleep(5);
  await Bun.sleep(5);
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("a call's log line carries the trace id and parent span of its traceparent", async () => {
  const lines = await run({ traceparent: `00-${TRACE}-${SPAN}-01` });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    level: "info",
    component: "box-agent.tools",
    msg: "tool call done",
    rpc_id: "tool_1",
    tool_call_id: "c_1",
    method: "tool.exists",
    trace_id: TRACE,
    parent_span_id: SPAN,
    ok: true,
  });
  expect(typeof lines[0]?.["duration_ms"]).toBe("number");
});

test("without a traceparent the ids are null, and exec logs its exit code", async () => {
  const lines = await run({}, "tool.exec");
  expect(lines[0]).toMatchObject({ trace_id: null, parent_span_id: null, exit_code: 3 });
});
