import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, call, desktopUrl, type EventPage, type HubEvent, JSON_HEADERS } from "./api";
import { DESKTOP_CLOSE_ASLEEP, DesktopStatus, desktopPhaseFor } from "./DesktopStatus";
import {
  applyHubEvent,
  applyHubEvents,
  emptyChat,
  type HearthChat,
  hearthToolStatus,
  isRunning,
  MAX_TOOL_OUTPUT,
  projectChat,
  toolTarget,
  toPiClientEvent,
} from "./hearthPi";
import { POLL_IDLE_MS, POLL_RUNNING_MS, pollInterval, readNewEvents } from "./queries";
import { ChatRuntime, Thread } from "./Thread";

let seq = 0;
function ev(type: string, payload: unknown = {}): HubEvent {
  seq += 1;
  return { seq, ts: 0, type, payload };
}

type Part = Record<string, unknown>;
const assistant = (content: Part[], stopReason = "stop") => ({
  role: "assistant",
  content,
  stopReason,
  timestamp: 1,
});
const text = (t: string): Part => ({ type: "text", text: t });
const toolCall = (id: string, name: string, args: unknown): Part => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const toolResult = (id: string, name: string, out: string, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [text(out)],
  isError,
  timestamp: 1,
});
const user = (t: string) => ({ role: "user", content: t, timestamp: 1 });

/** One turn as the runner records it: a step that calls `bash ls`, then the answer. */
function turn(): HubEvent[] {
  const step = assistant(
    [text("Let me look."), toolCall("c1", "bash", { command: "ls" })],
    "toolUse",
  );
  return [
    ev("message.user", { text: "list files" }),
    ev("pi.agent_start", { type: "agent_start" }),
    ev("pi.message_start", { message: user("list files") }),
    ev("pi.message_end", { message: user("list files") }),
    ev("pi.message_start", { message: assistant([]) }),
    ev("pi.message_update", { message: assistant([text("Let me")]) }),
    ev("pi.message_end", { message: step }),
    ev("pi.tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } }),
    ev("pi.tool_execution_update", {
      toolCallId: "c1",
      partialResult: { content: [text("a.t")] },
    }),
    ev("pi.tool_execution_end", {
      toolCallId: "c1",
      result: { content: [text("a.txt\n")] },
      isError: false,
    }),
    ev("pi.message_start", { message: toolResult("c1", "bash", "a.txt\n") }),
    ev("pi.message_end", { message: toolResult("c1", "bash", "a.txt\n") }),
    ev("pi.message_start", { message: assistant([]) }),
    ev("pi.message_end", { message: assistant([text("There is a.txt.")]) }),
    ev("pi.agent_end", { messages: [] }),
  ];
}

const S = "se_test";

/** The tool-call parts of the projection, each with the status assistant-ui would give it. */
function tools(chat: HearthChat) {
  return projectChat(chat).flatMap((m) =>
    typeof m.content === "string"
      ? []
      : m.content.flatMap((p) =>
          p.type === "tool-call" ? [{ ...p, status: m.status ?? { type: "complete" } }] : [],
        ),
  );
}

function render(chat: HearthChat): string {
  return renderToStaticMarkup(
    <ChatRuntime
      messages={projectChat(chat)}
      isRunning={isRunning(chat)}
      onSend={async () => {}}
      onInterrupt={async () => {}}
    >
      <Thread />
    </ChatRuntime>,
  );
}

describe("chat from the event log (react-pi reducer + projection)", () => {
  test("toPiClientEvent strips the pi. prefix and keeps the seq; other events are not pi's", () => {
    const e: HubEvent = {
      seq: 7,
      ts: 0,
      type: "pi.tool_execution_start",
      payload: { toolCallId: "x", type: "bogus" },
    };
    expect(toPiClientEvent(S, e)).toEqual({
      type: "tool_execution_start",
      toolCallId: "x",
      threadId: S,
      seq: 7,
    } as never);
    expect(toPiClientEvent(S, { ...e, type: "message.user" })).toBeNull();
    expect(toPiClientEvent(S, { ...e, type: "runner.pi.x" })).toBeNull();
  });

  test("a turn becomes the user's message and one assistant message with text, tool call and reply", () => {
    const events = turn();
    const chat = applyHubEvents(emptyChat(S), events);
    expect(isRunning(chat)).toBe(false);
    expect(chat.cursor).toBe(events.at(-1)?.seq as number);
    expect(chat.pending).toEqual([]);
    const messages = projectChat(chat);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const parts = messages[1]?.content as unknown as Part[];
    expect(parts.map((p) => p["type"])).toEqual(["text", "tool-call", "text"]);
    expect(parts[1]).toMatchObject({
      toolName: "bash",
      args: { command: "ls" },
      result: "a.txt\n",
    });
    expect(parts[2]).toMatchObject({ text: "There is a.txt." });
    expect(tools(chat).map(hearthToolStatus)).toEqual(["ok"]);
  });

  test("the user's message shows at once, then pi's own copy replaces it (no duplicate)", () => {
    const events = turn();
    const sent = applyHubEvents(emptyChat(S), events.slice(0, 1));
    expect(isRunning(sent)).toBe(true);
    expect(projectChat(sent)).toMatchObject([{ role: "user", content: [{ text: "list files" }] }]);
    const mirrored = applyHubEvents(sent, events.slice(1, 3));
    expect(mirrored.pending).toEqual([]);
    expect(projectChat(mirrored).filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("running from the send until agent_end; partial output shows while the call runs", () => {
    const events = turn();
    const mid = applyHubEvents(emptyChat(S), events.slice(0, 9));
    expect(isRunning(mid)).toBe(true);
    const [running] = tools(mid);
    expect(running).toMatchObject({ result: "a.t", isPreliminary: true });
    expect(hearthToolStatus(running as never)).toBe("running");
    expect(render(mid)).toContain('data-status="running"');
  });

  test("resume: re-applying a page at or before the cursor changes nothing, and pages compose", () => {
    const events = turn();
    const whole = applyHubEvents(emptyChat(S), events);
    const split = applyHubEvents(applyHubEvents(emptyChat(S), events.slice(0, 5)), events.slice(3));
    expect(projectChat(split)).toEqual(projectChat(whole));
    expect(split.cursor).toBe(whole.cursor);
    expect(applyHubEvents(whole, events)).toBe(whole);
  });

  test("a re-read runner.failed is not applied twice", () => {
    const failed = applyHubEvents(emptyChat(S), [
      ev("message.user", { text: "go" }),
      ev("runner.failed", { message: "x" }),
    ]);
    const again = applyHubEvent(failed, {
      seq: failed.cursor,
      ts: 0,
      type: "runner.failed",
      payload: {},
    });
    expect(again).toBe(failed);
    expect(failed.notices).toHaveLength(1);
  });

  test("tool errors, outcome unknown, and calls cut off by the end of the turn", () => {
    const step = assistant(
      [
        toolCall("e", "read", { path: "x" }),
        toolCall("u", "write", { path: "y" }),
        toolCall("i", "bash", { command: "sleep 9" }),
      ],
      "toolUse",
    );
    const unknown =
      "tool.outcome-unknown: Box bx restarted during tool_write; its outcome is unknown";
    const chat = applyHubEvents(emptyChat(S), [
      ev("message.user", { text: "go" }),
      ev("pi.agent_start"),
      ev("pi.message_start", { message: user("go") }),
      ev("pi.message_start", { message: step }),
      ev("pi.message_end", { message: step }),
      ev("pi.message_start", { message: toolResult("e", "read", "ENOENT", true) }),
      ev("pi.message_start", { message: toolResult("u", "write", unknown, true) }),
      ev("pi.tool_execution_start", { toolCallId: "i", toolName: "bash", args: {} }),
      ev("runner.interrupted", { reason: "interrupted by the user" }),
      ev("pi.agent_end", { messages: [] }),
    ]);
    expect(isRunning(chat)).toBe(false);
    expect(tools(chat).map(hearthToolStatus)).toEqual(["error", "outcome-unknown", "interrupted"]);
    const html = render(chat);
    expect(html).toContain('data-status="outcome-unknown"');
    expect(html).toContain('aria-label="Tool call bash: interrupted"');
    expect(projectChat(chat).at(-1)).toMatchObject({
      role: "system",
      content: [{ text: "Interrupted." }],
    });
  });

  test("hearthToolStatus: a call with no result is running only while its message runs", () => {
    const running = { type: "running" };
    const done = { type: "complete" };
    expect(hearthToolStatus({ status: running })).toBe("running");
    expect(hearthToolStatus({ status: done })).toBe("interrupted");
    expect(hearthToolStatus({ status: running, result: "x", isPreliminary: true })).toBe("running");
    expect(hearthToolStatus({ status: done, result: "x", isPreliminary: true })).toBe(
      "interrupted",
    );
    expect(hearthToolStatus({ status: done, result: "x" })).toBe("ok");
    expect(hearthToolStatus({ status: done, result: "x", isError: false })).toBe("ok");
    expect(hearthToolStatus({ status: done, result: "boom", isError: true })).toBe("error");
    expect(
      hearthToolStatus({ status: done, result: "its outcome is unknown", isError: true }),
    ).toBe("outcome-unknown");
  });

  test("runner.failed ends the turn with a visible error, where it happened", () => {
    const first = turn();
    const chat = applyHubEvents(emptyChat(S), [
      ...first,
      ev("message.user", { text: "again" }),
      ev("runner.failed", { message: "disk full" }),
    ]);
    expect(isRunning(chat)).toBe(false);
    expect(chat.pending).toEqual([]);
    const messages = projectChat(chat);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "system"]);
    expect(messages.at(-1)).toMatchObject({
      content: [{ text: "The runner failed: disk full" }],
      metadata: { custom: { tone: "error" } },
    });
    const html = render(chat);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The runner failed: disk full");
  });

  test("runner.failed during a running turn stops it", () => {
    const chat = applyHubEvents(emptyChat(S), [
      ev("message.user", { text: "go" }),
      ev("pi.agent_start"),
      ev("pi.message_start", { message: user("go") }),
      ev("runner.failed", { message: "boom" }),
    ]);
    expect(chat.pi.runStatus).toBe("failed");
    expect(isRunning(chat)).toBe(false);
  });

  test("the poll is fast while a turn runs and slow otherwise", () => {
    expect(POLL_RUNNING_MS).toBeLessThan(POLL_IDLE_MS);
    expect(pollInterval(undefined)).toBe(POLL_IDLE_MS);
    expect(pollInterval(emptyChat(S))).toBe(POLL_IDLE_MS);
    expect(pollInterval(applyHubEvents(emptyChat(S), [ev("pi.agent_start")]))).toBe(
      POLL_RUNNING_MS,
    );
  });

  test("a notice stays between the turns it happened between", () => {
    const chat = applyHubEvents(emptyChat(S), [...turn(), ev("runner.interrupted", {}), ...turn()]);
    expect(projectChat(chat).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "system",
      "user",
      "assistant",
    ]);
  });

  test("agent_end clears a send pi never mirrored", () => {
    const chat = applyHubEvents(emptyChat(S), [
      ev("message.user", { text: "x" }),
      ev("pi.agent_end"),
    ]);
    expect(chat.pending).toEqual([]);
    expect(isRunning(chat)).toBe(false);
  });

  test("tool output is capped", () => {
    const big = "x".repeat(MAX_TOOL_OUTPUT + 10);
    const step = assistant([toolCall("big", "bash", {})], "toolUse");
    const chat = applyHubEvents(emptyChat(S), [
      ev("pi.message_start", { message: step }),
      ev("pi.message_end", { message: step }),
      ev("pi.message_start", { message: toolResult("big", "bash", big) }),
    ]);
    const [tool] = tools(chat);
    expect(String(tool?.result).length).toBeLessThan(MAX_TOOL_OUTPUT + 20);
    expect(String(tool?.result)).toEndWith("(truncated)");
  });

  test("toolTarget: command, path, or pattern in path", () => {
    expect(toolTarget("bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolTarget("read", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolTarget("grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(toolTarget("find", { pattern: "*.ts" })).toBe("*.ts");
    expect(toolTarget("ls", null)).toBe("");
  });

  test("readNewEvents reads every page from the cursor, then stops", async () => {
    const events = turn();
    const asked: number[] = [];
    const pages = async (sessionId: string, after: number): Promise<EventPage> => {
      expect(sessionId).toBe(S);
      asked.push(after);
      const rest = events.filter((e) => e.seq > after);
      const page = rest.slice(0, 4);
      return { events: page, cursor: page.at(-1)?.seq ?? after, hasMore: rest.length > 4 };
    };
    const start = applyHubEvents(emptyChat(S), events.slice(0, 2));
    const chat = await readNewEvents(start, pages);
    expect(chat.cursor).toBe(events.at(-1)?.seq as number);
    expect(asked[0]).toBe(events[1]?.seq as number);
    expect(asked).toHaveLength(4);
    expect(projectChat(chat)).toEqual(projectChat(applyHubEvents(emptyChat(S), events)));
  });
});

describe("chat view", () => {
  test("an empty session says so; the composer has the Message input and Send", () => {
    const html = render(emptyChat(S));
    expect(html).toContain("No messages yet");
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain("Send");
    expect(html).not.toContain("Interrupt");
  });

  test("a tool card is collapsed, labelled with its tool and status, and escapes its target", () => {
    const step = assistant([toolCall("t", "bash", { command: "echo <hi>" })], "toolUse");
    const chat = applyHubEvents(emptyChat(S), [
      ev("pi.message_start", { message: step }),
      ev("pi.message_start", { message: toolResult("t", "bash", "<b>out</b>") }),
    ]);
    const html = render(chat);
    expect(html.match(/data-testid="tool-card"/g)).toHaveLength(1);
    expect(html).toContain('data-status="ok"');
    expect(html).toContain('aria-label="Tool call bash: done"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("echo &lt;hi&gt;");
  });

  test("while a turn runs the composer offers Interrupt", () => {
    const chat = applyHubEvents(emptyChat(S), [ev("message.user", { text: "go" })]);
    expect(render(chat)).toContain("Interrupt");
  });
});

describe("desktop", () => {
  test("close code 4410 shows the box asleep with a Wake button", () => {
    expect(DESKTOP_CLOSE_ASLEEP).toBe(4410);
    const asleep = desktopPhaseFor(4410, "box gone");
    expect(asleep).toEqual({ kind: "asleep" });
    const html = renderToStaticMarkup(<DesktopStatus phase={asleep} onWake={() => {}} />);
    expect(html).toContain("Box asleep — send a message or click Wake to reconnect.");
    expect(html).toMatch(/<button[^>]*>Wake<\/button>/);
    expect(JSON.stringify(desktopPhaseFor(4401, ""))).toContain("Signed out");
    expect(JSON.stringify(desktopPhaseFor(1006, ""))).toContain("code 1006");
  });
});

describe("api", () => {
  test("every call sends JSON, a POST without a body sends {}, same-origin credentials", async () => {
    const seen: Array<{ input: string; init: RequestInit }> = [];
    const fetcher = async (input: string, init: RequestInit) => {
      seen.push({ input, init });
      return Response.json({ ok: true, interrupted: true });
    };
    await call("GET", "/v1/sessions", undefined, fetcher);
    await call("POST", "/v1/sessions/a/interrupt", undefined, fetcher);
    expect(seen[0]?.init).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect(seen[0]?.init.body).toBeUndefined();
    expect(seen[1]?.init.body).toBe("{}");
    for (const s of seen) expect(s.init.headers).toEqual(JSON_HEADERS);
    expect(JSON_HEADERS["content-type"]).toBe("application/json");
  });

  test("a refusal becomes an ApiError with the hub's code", async () => {
    const fetcher = async () =>
      Response.json(
        { ok: false, error: { code: "auth.required", message: "sign in first" } },
        {
          status: 401,
        },
      );
    const error = await call("GET", "/v1/sessions", undefined, fetcher).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: "auth.required", message: "sign in first" });
  });

  test("the desktop URL is the page's own origin, ws or wss", () => {
    expect(desktopUrl("se 1", { protocol: "http:", host: "127.0.0.1:8787" })).toBe(
      "ws://127.0.0.1:8787/v1/sessions/se%201/desktop",
    );
    expect(desktopUrl("s", { protocol: "https:", host: "h.example" })).toBe(
      "wss://h.example/v1/sessions/s/desktop",
    );
  });
});
