import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, call, desktopUrl, type HubEvent, JSON_HEADERS } from "./api";
import {
  applyEvent,
  applyEvents,
  type ChatItem,
  EMPTY_CHAT,
  MAX_TOOL_OUTPUT,
  toolTarget,
} from "./chat";
import {
  ChatList,
  DESKTOP_CLOSE_ASLEEP,
  DesktopStatus,
  desktopPhaseFor,
  ToolCard,
} from "./components";

let seq = 0;
function ev(type: string, payload: unknown = {}): HubEvent {
  seq += 1;
  return { seq, ts: 0, type, payload };
}

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

function turn(): HubEvent[] {
  return [
    ev("message.user", { text: "list files" }),
    ev("pi.agent_start"),
    ev("pi.message_start", { message: { role: "user", content: "list files" } }),
    ev("pi.message_start", { message: assistant("") }),
    ev("pi.message_update", { message: assistant("Let me") }),
    ev("pi.message_update", { message: assistant("Let me look.") }),
    ev("pi.message_end", { message: assistant("Let me look.") }),
    ev("pi.tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } }),
    ev("pi.tool_execution_update", {
      toolCallId: "c1",
      partialResult: { content: [{ type: "text", text: "a.t" }] },
    }),
    ev("pi.tool_execution_end", {
      toolCallId: "c1",
      result: { content: [{ type: "text", text: "a.txt\n" }] },
      isError: false,
    }),
    ev("pi.message_start", { message: assistant("") }),
    ev("pi.message_end", { message: assistant("There is a.txt.") }),
    ev("pi.agent_end", { messages: [] }),
  ];
}

describe("chat from the event log", () => {
  test("a turn becomes user, assistant, tool card and reply; streaming updates replace text", () => {
    const events = turn();
    const state = applyEvents(EMPTY_CHAT, events);
    expect(state.running).toBe(false);
    expect(state.cursor).toBe(events.at(-1)?.seq as number);
    expect(state.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const [, first, tool, last] = state.items as ChatItem[];
    expect(first).toMatchObject({ text: "Let me look.", streaming: false });
    expect(tool).toMatchObject({ name: "bash", target: "ls", output: "a.txt\n", status: "ok" });
    expect(last).toMatchObject({ text: "There is a.txt.", streaming: false });
  });

  test("running from the user's message until agent_end", () => {
    const events = turn();
    const mid = applyEvents(EMPTY_CHAT, events.slice(0, 8));
    expect(mid.running).toBe(true);
    expect(mid.items.at(-1)).toMatchObject({ kind: "tool", status: "running" });
    // A partial result shows while the call runs.
    expect(applyEvent(mid, events[8] as HubEvent).items.at(-1)).toMatchObject({ output: "a.t" });
  });

  test("resume: re-applying a page at or before the cursor changes nothing, and pages compose", () => {
    const events = turn();
    const whole = applyEvents(EMPTY_CHAT, events);
    const split = applyEvents(applyEvents(EMPTY_CHAT, events.slice(0, 5)), events.slice(3));
    expect(split).toEqual(whole);
    expect(applyEvents(whole, events)).toBe(whole);
  });

  test("tool errors, outcome unknown, and calls cut off by the end of the turn", () => {
    const state = applyEvents(EMPTY_CHAT, [
      ev("message.user", { text: "go" }),
      ev("pi.tool_execution_start", { toolCallId: "e", toolName: "read", args: { path: "x" } }),
      ev("pi.tool_execution_end", {
        toolCallId: "e",
        result: { content: [{ type: "text", text: "ENOENT" }] },
        isError: true,
      }),
      ev("pi.tool_execution_start", { toolCallId: "u", toolName: "write", args: { path: "y" } }),
      ev("pi.tool_execution_end", {
        toolCallId: "u",
        result: {
          content: [
            {
              type: "text",
              text: "tool.outcome-unknown: Box bx restarted during tool_write; its outcome is unknown",
            },
          ],
        },
        isError: true,
      }),
      ev("pi.tool_execution_start", {
        toolCallId: "i",
        toolName: "bash",
        args: { command: "sleep 9" },
      }),
      ev("runner.interrupted", { reason: "interrupted by the user" }),
      ev("pi.agent_end", { messages: [] }),
    ]);
    const tools = state.items.filter((i) => i.kind === "tool");
    expect(tools.map((t) => (t.kind === "tool" ? t.status : ""))).toEqual([
      "error",
      "outcome-unknown",
      "interrupted",
    ]);
    expect(state.items.at(-1)).toMatchObject({ kind: "notice", text: "Interrupted." });
  });

  test("runner.failed ends the turn with a visible error", () => {
    const state = applyEvents(EMPTY_CHAT, [
      ev("message.user", { text: "go" }),
      ev("runner.failed", { message: "disk full" }),
    ]);
    expect(state.running).toBe(false);
    expect(state.items.at(-1)).toMatchObject({ kind: "notice", tone: "error" });
  });

  test("tool output is capped", () => {
    const state = applyEvents(EMPTY_CHAT, [
      ev("pi.tool_execution_start", { toolCallId: "big", toolName: "bash", args: {} }),
      ev("pi.tool_execution_end", {
        toolCallId: "big",
        result: { content: [{ type: "text", text: "x".repeat(MAX_TOOL_OUTPUT + 10) }] },
        isError: false,
      }),
    ]);
    const tool = state.items[0];
    expect(tool?.kind === "tool" && tool.output.length).toBeLessThan(MAX_TOOL_OUTPUT + 20);
  });

  test("toolTarget: command, path, or pattern in path", () => {
    expect(toolTarget("bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolTarget("read", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolTarget("grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(toolTarget("find", { pattern: "*.ts" })).toBe("*.ts");
    expect(toolTarget("ls", null)).toBe("");
  });
});

describe("components", () => {
  test("a tool card is a collapsible <details> with target, status and output", () => {
    const html = renderToStaticMarkup(
      <ToolCard
        item={{
          kind: "tool",
          key: "k",
          callId: "c",
          name: "bash",
          target: "echo <hi>",
          output: "<b>out</b>",
          status: "outcome-unknown",
        }}
      />,
    );
    expect(html).toStartWith("<details");
    expect(html).not.toContain(" open");
    expect(html).toContain('data-status="outcome-unknown"');
    expect(html).toContain("echo &lt;hi&gt;");
    expect(html).toContain("&lt;b&gt;out&lt;/b&gt;");
    expect(html).toContain("outcome unknown");
    expect(html).toContain("may or may not have taken effect");
  });

  test("the chat list renders every item, and an empty session says so", () => {
    expect(renderToStaticMarkup(<ChatList items={[]} />)).toContain("No messages yet");
    const state = applyEvents(EMPTY_CHAT, turn());
    const html = renderToStaticMarkup(<ChatList items={state.items} />);
    expect(html).toContain("list files");
    expect(html).toContain("There is a.txt.");
    expect(html.match(/<details/g)?.length).toBe(1);
  });

  test("close code 4410 shows the box asleep with a Wake button", () => {
    expect(DESKTOP_CLOSE_ASLEEP).toBe(4410);
    const asleep = desktopPhaseFor(4410, "box gone");
    expect(asleep).toEqual({ kind: "asleep" });
    const html = renderToStaticMarkup(<DesktopStatus phase={asleep} onWake={() => {}} />);
    expect(html).toContain("Box asleep — send a message or click Wake to reconnect.");
    expect(html).toContain(">Wake</button>");
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
