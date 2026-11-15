/**
 * A recorded-shape Hearth event log: the envelope of `GET /v1/sessions/:id/events`
 * (`{seq, ts, type, payload}`, apps/web/src/api.ts on PR #66) with `pi.<type>`
 * events whose payload is the pi AgentSessionEvent the runner records as-is
 * (apps/hub/src/runner/runner.ts:391 on PR #63). Hand-written for the spike,
 * with the event types runner.test.ts:378-412 asserts are present (membership,
 * not order), in pi's emit order; runner.entry is left out (the chat ignores it).
 */
export interface HubEvent {
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly payload: unknown;
}

const t0 = 1_763_230_000_000;
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: t0 });
const assistant = (content: unknown[], stopReason = "stop") => ({
  role: "assistant",
  content,
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason,
  timestamp: t0,
});
const toolResult = (toolCallId: string, toolName: string, text: string, isError = false) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError,
  timestamp: t0,
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const c1 = call("c1", "bash", { command: "ls -la ~/project" });
const c2 = call("c2", "read", { path: "README.md" });
const c3 = call("c3", "bash", { command: "npm test" });
const a1 = assistant([{ type: "text", text: "Let me look at the project first." }, c1, c2], "toolUse");
const a2 = assistant([{ type: "text", text: "Now I'll run the tests." }, c3], "toolUse");
const a3 = assistant([
  {
    type: "text",
    text: "The project has a README and a test script. **2 of 3 tests pass**; `parse.test.ts` fails on an empty input. Want me to fix it?",
  },
]);

const bodies: Array<[string, unknown]> = [
  ["runner.header", { version: 1 }],
  ["message.user", { text: "What's in my project, and do the tests pass?" }],
  ["pi.agent_start", { type: "agent_start" }],
  ["pi.turn_start", { type: "turn_start" }],
  ["pi.message_start", { type: "message_start", message: user("What's in my project, and do the tests pass?") }],
  ["pi.message_end", { type: "message_end", message: user("What's in my project, and do the tests pass?") }],
  ["pi.message_start", { type: "message_start", message: assistant([]) }],
  [
    "pi.message_update",
    {
      type: "message_update",
      message: assistant([{ type: "text", text: "Let me look" }]),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Let me look" },
    },
  ],
  ["pi.message_update", { type: "message_update", message: a1, assistantMessageEvent: { type: "toolcall_end", contentIndex: 2 } }],
  ["pi.message_end", { type: "message_end", message: a1 }],
  ["pi.tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: c1.arguments }],
  ["pi.tool_execution_update", { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: c1.arguments, partialResult: { content: [{ type: "text", text: "total 24\n" }] } }],
  ["pi.tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "total 24\ndrwxr-xr-x  src\n-rw-r--r--  README.md\n-rw-r--r--  package.json" }] }, isError: false }],
  ["pi.message_start", { type: "message_start", message: toolResult("c1", "bash", "total 24\ndrwxr-xr-x  src\n-rw-r--r--  README.md\n-rw-r--r--  package.json") }],
  ["pi.message_end", { type: "message_end", message: toolResult("c1", "bash", "total 24\ndrwxr-xr-x  src\n-rw-r--r--  README.md\n-rw-r--r--  package.json") }],
  ["pi.tool_execution_start", { type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: c2.arguments }],
  ["pi.tool_execution_end", { type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: { content: [{ type: "text", text: "# demo\nA tiny parser." }] }, isError: false }],
  ["pi.message_start", { type: "message_start", message: toolResult("c2", "read", "# demo\nA tiny parser.") }],
  ["pi.message_end", { type: "message_end", message: toolResult("c2", "read", "# demo\nA tiny parser.") }],
  ["pi.turn_end", { type: "turn_end" }],
  ["pi.turn_start", { type: "turn_start" }],
  ["pi.message_start", { type: "message_start", message: assistant([]) }],
  ["pi.message_end", { type: "message_end", message: a2 }],
  ["pi.tool_execution_start", { type: "tool_execution_start", toolCallId: "c3", toolName: "bash", args: c3.arguments }],
  ["pi.tool_execution_end", { type: "tool_execution_end", toolCallId: "c3", toolName: "bash", result: { content: [{ type: "text", text: "FAIL parse.test.ts > empty input\nTests: 1 failed, 2 passed" }] }, isError: true }],
  ["pi.message_start", { type: "message_start", message: toolResult("c3", "bash", "FAIL parse.test.ts > empty input\nTests: 1 failed, 2 passed", true) }],
  ["pi.message_end", { type: "message_end", message: toolResult("c3", "bash", "FAIL parse.test.ts > empty input\nTests: 1 failed, 2 passed", true) }],
  ["pi.turn_end", { type: "turn_end" }],
  ["pi.turn_start", { type: "turn_start" }],
  ["pi.message_start", { type: "message_start", message: assistant([]) }],
  ["pi.message_end", { type: "message_end", message: a3 }],
  ["runner.usage", { provider: "faux", model: "faux-1" }],
  ["pi.turn_end", { type: "turn_end" }],
  ["pi.agent_end", { type: "agent_end", messages: [] }],
];

export const RECORDED_LOG: readonly HubEvent[] = bodies.map(([type, payload], i) => ({
  seq: i + 1,
  ts: t0 + i * 100,
  type,
  payload,
}));
