/**
 * The app in a DOM (happy-dom) against a fake hub: what the user sees when a
 * call fails. It runs in its own process (`bun run test:dom`, part of
 * `bun run test`): modules loaded under the DOM would leak into the
 * server-rendered tests of `web.test.tsx` through the shared module cache.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://127.0.0.1:8787/" });
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import(
  "@testing-library/react"
);
const { QueryClientProvider } = await import("@tanstack/react-query");
const { App } = await import("./App");
const { createQueryClient } = await import("./queries");
const { ChatRuntime, Thread } = await import("./Thread");
const { applyHubEvents, emptyChat, isRunning, projectChat } = await import("./hearthPi");
const { DesktopPanel, loadNoVnc } = await import("./Desktop");

type Route = (method: string, path: string, body: unknown) => Response | undefined;

const SESSION = {
  id: "se_1",
  title: "Hello",
  state: "idle",
  createdAt: 0,
  lastActivityAt: 0,
  archivedAt: null,
};
const ok = (data: unknown) => Response.json({ ok: true, ...(data as object) });
const fail = (status: number, message: string) =>
  Response.json({ ok: false, error: { code: `x.${status}`, message } }, { status });

/** A hub that is signed in, has one empty session, and answers `extra` first. */
function hub(extra: Route) {
  const calls: Array<{ method: string; path: string }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    calls.push({ method, path });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const answer = extra(method, path, body);
    if (answer !== undefined) return answer;
    if (path === "/v1/auth/status") return ok({ setupRequired: false, authenticated: true });
    if (path === "/v1/sessions") return ok({ sessions: [SESSION] });
    if (path === "/v1/sessions/se_1") return ok({ session: SESSION });
    if (path.startsWith("/v1/sessions/se_1/events"))
      return ok({ events: [], cursor: 0, hasMore: false });
    return fail(404, `no route ${method} ${path}`);
  };
  globalThis.fetch = fetcher as typeof fetch;
  return calls;
}

function renderApp(hash: string) {
  window.location.hash = hash;
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeAll(() => {
  // Radix and the registry thread measure the viewport; happy-dom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

describe("app in a DOM", () => {
  test("a failed send keeps the typed text in the composer and shows the error", async () => {
    const calls = hub((method, path) =>
      method === "POST" && path === "/v1/sessions/se_1/messages"
        ? fail(500, "the hub broke")
        : undefined,
    );
    renderApp("#/s/se_1");
    const input = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "keep me" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(await screen.findByText("the hub broke")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("the hub broke");
    await waitFor(() => expect(input.value).toBe("keep me"));
    expect(calls.filter((c) => c.path === "/v1/sessions/se_1/messages")).toHaveLength(1);
  });

  test("a 401 on a query goes back to the sign-in form", async () => {
    hub((_method, path) => (path === "/v1/sessions" ? fail(401, "sign in first") : undefined));
    renderApp("#/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  test("a 401 on a mutation goes back to the sign-in form", async () => {
    hub((method, path) =>
      method === "POST" && path === "/v1/sessions" ? fail(401, "sign in first") : undefined,
    );
    renderApp("#/");
    fireEvent.click(await screen.findByRole("button", { name: "New session" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  test("the session list is a list named Sessions with one row per open session", async () => {
    hub(() => undefined);
    renderApp("#/");
    const list = await screen.findByRole("list", { name: "Sessions" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-testid")).toBe("session-row");
    expect(within(rows[0] as HTMLElement).getByRole("link").textContent).toBe("Hello");
  });
});

describe("tool card in a DOM", () => {
  test("an outcome-unknown call says so when opened", async () => {
    const S = "se_t";
    let seq = 0;
    const ev = (type: string, payload: unknown) => ({ seq: ++seq, ts: 0, type, payload });
    const step = {
      role: "assistant",
      content: [{ type: "toolCall", id: "u", name: "write", arguments: { path: "y" } }],
      stopReason: "toolUse",
      timestamp: 1,
    };
    const result = {
      role: "toolResult",
      toolCallId: "u",
      toolName: "write",
      content: [{ type: "text", text: "tool.outcome-unknown: its outcome is unknown" }],
      isError: true,
      timestamp: 1,
    };
    const chat = applyHubEvents(emptyChat(S), [
      ev("pi.message_start", { message: step }),
      ev("pi.message_start", { message: result }),
    ]);
    render(
      <ChatRuntime
        messages={projectChat(chat)}
        isRunning={isRunning(chat)}
        onSend={async () => {}}
        onInterrupt={async () => {}}
      >
        <Thread />
      </ChatRuntime>,
    );
    // The composer does not take focus on load, so a phone keyboard stays down.
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: "Message" }));
    const trigger = screen.getByRole("button", { name: "Tool call write: outcome unknown" });
    expect(screen.queryByText(/The box restarted during this call/)).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByText(/The box restarted during this call/)).toBeTruthy();
  });
});

describe("live tool output in a DOM", () => {
  test("a running sleep+echo command shows its output before it finishes, then its result", async () => {
    let seq = 0;
    const ev = (type: string, payload: unknown) => ({ seq: ++seq, ts: 0, type, payload });
    const command = "echo first; sleep 30; echo second";
    const call = { type: "toolCall", id: "b1", name: "bash", arguments: { command } };
    const step = { role: "assistant", content: [call], stopReason: "toolUse", timestamp: 1 };
    const running = [
      ev("message.user", { text: "run it" }),
      ev("pi.agent_start", {}),
      ev("pi.message_start", { message: { role: "user", content: "run it", timestamp: 1 } }),
      ev("pi.message_start", { message: step }),
      ev("pi.message_end", { message: step }),
      ev("pi.tool_execution_start", { toolCallId: "b1", toolName: "bash", args: { command } }),
      ev("tool.output", { toolCallId: "b1", seq: 0, text: "first\n" }),
    ];
    const result = {
      role: "toolResult",
      toolCallId: "b1",
      toolName: "bash",
      content: [{ type: "text", text: "first\nsecond\n" }],
      isError: false,
      timestamp: 2,
    };
    const finished = [
      // A chunk whose append raced the end: dropped, the result is the answer.
      ev("pi.tool_execution_end", { toolCallId: "b1", toolName: "bash", result, isError: false }),
      ev("tool.output", { toolCallId: "b1", seq: 1, text: "late\n" }),
      ev("pi.message_start", { message: result }),
      ev("pi.message_end", { message: result }),
      ev("pi.agent_end", {}),
    ];
    // The command is still running until the test lets it finish.
    let done = false;
    hub((_method, path) => {
      const match = /\/v1\/sessions\/se_1\/events\?after=(\d+)/.exec(path);
      if (match === null) return undefined;
      const after = Number(match[1]);
      const events = [...running, ...(done ? finished : [])].filter((e) => e.seq > after);
      const cursor = events.at(-1)?.seq ?? after;
      return ok({ events, cursor, hasMore: false });
    });
    renderApp("#/s/se_1");
    const trigger = await screen.findByRole("button", { name: "Tool call bash: running" });
    const log = await screen.findByRole("log", { name: "Live output of bash" });
    expect(log.textContent).toBe("first\n");
    // Still running: the card's name is unchanged and there is no result yet.
    expect(trigger.getAttribute("aria-label")).toBe("Tool call bash: running");
    expect(document.querySelector('[data-slot="tool-fallback-result"]')).toBeNull();
    done = true;
    await screen.findByRole("button", { name: "Tool call bash: done" }, { timeout: 5000 });
    expect(screen.queryByRole("log", { name: "Live output of bash" })).toBeNull();
    expect(screen.queryByText(/late/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tool call bash: done" }));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tool-fallback-result"]')?.textContent).toContain(
        "first\nsecond",
      ),
    );
  });
});

describe("desktop panel in a DOM", () => {
  /** A stand-in for noVNC's RFB and the WebSocket, counting what gets opened. */
  function fakes() {
    const opened = { sockets: 0, clients: 0 };
    const clients: FakeRfb[] = [];
    class FakeSocket extends EventTarget {
      constructor() {
        super();
        opened.sockets += 1;
      }
    }
    class FakeRfb extends EventTarget {
      viewOnly = false;
      scaleViewport = false;
      resizeSession = false;
      focused = 0;
      constructor() {
        super();
        opened.clients += 1;
        clients.push(this);
      }
      focus() {
        this.focused += 1;
      }
      disconnect() {}
    }
    const realSocket = globalThis.WebSocket;
    const realLoad = loadNoVnc.load;
    globalThis.WebSocket = FakeSocket as never;
    let release: (ok: boolean) => void = () => {};
    let loads = 0;
    loadNoVnc.load = () => {
      loads += 1;
      return new Promise((resolve, reject) => {
        release = (ok) => (ok ? resolve(FakeRfb as never) : reject(new Error("chunk failed")));
      });
    };
    const restore = () => {
      globalThis.WebSocket = realSocket;
      loadNoVnc.load = realLoad;
    };
    return {
      opened,
      clients,
      release: (ok = true) => release(ok),
      loads: () => loads,
      restore,
    };
  }

  test("noVNC loads on Open desktop, not before", async () => {
    const f = fakes();
    try {
      render(<DesktopPanel sessionId="se_1" />);
      expect(f.loads()).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
      expect(f.loads()).toBe(1);
      await act(async () => f.release());
      expect(f.opened).toEqual({ sockets: 1, clients: 1 });
    } finally {
      f.restore();
    }
  });

  test("a panel gone before noVNC loads opens no socket", async () => {
    const f = fakes();
    try {
      const view = render(<DesktopPanel sessionId="se_1" />);
      fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
      view.unmount();
      await act(async () => f.release());
      expect(f.opened).toEqual({ sockets: 0, clients: 0 });
    } finally {
      f.restore();
    }
  });

  test("a viewer that fails to load says so and offers Reconnect", async () => {
    const f = fakes();
    try {
      render(<DesktopPanel sessionId="se_1" />);
      fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
      await act(async () => f.release(false));
      expect(screen.getByText("The desktop viewer did not load.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
      expect(f.opened.sockets).toBe(0);
    } finally {
      f.restore();
    }
  });

  test("Take over sends input through noVNC; Release makes it view-only again", async () => {
    const f = fakes();
    let lock = { held: false, mine: false, holder: null as unknown, expiresAt: null as unknown };
    const mineLock = {
      held: true,
      mine: true,
      holder: { kind: "person", principalId: "usr_owner" },
      expiresAt: 1,
    };
    const free = { held: false, mine: false, holder: null, expiresAt: null };
    const calls = hub((method, path) => {
      if (path !== "/v1/sessions/se_1/desktop/lock" && !path.endsWith("/lock/release")) {
        return undefined;
      }
      if (method === "POST" && path.endsWith("/release")) lock = free;
      else if (method === "POST") lock = mineLock;
      return ok({ lock });
    });
    try {
      render(
        <QueryClientProvider client={createQueryClient()}>
          <DesktopPanel sessionId="se_1" />
        </QueryClientProvider>,
      );
      // No lock calls before the desktop is open.
      fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
      await act(async () => f.release());
      expect(calls.some((c) => c.path.includes("/desktop/lock"))).toBe(false);
      const client = f.clients[0] as (typeof f.clients)[number];
      expect(client.viewOnly).toBe(true);
      await act(async () => client.dispatchEvent(new Event("connect")));
      const take = await screen.findByRole("button", { name: "Take over" });
      await waitFor(() => expect((take as HTMLButtonElement).disabled).toBe(false));
      expect(client.viewOnly).toBe(true);

      fireEvent.click(take);
      await screen.findByRole("button", { name: "Release" });
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/v1/sessions/se_1/desktop/lock"),
      ).toBe(true);
      await waitFor(() => expect(client.viewOnly).toBe(false));
      expect(client.focused).toBe(1);
      expect(screen.getByText(/You are in control/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Release" }));
      await screen.findByRole("button", { name: "Take over" });
      await waitFor(() => expect(client.viewOnly).toBe(true));
    } finally {
      f.restore();
    }
  });

  test("a lock someone else holds disables Take over and says so", async () => {
    const f = fakes();
    hub((_method, path) =>
      path === "/v1/sessions/se_1/desktop/lock"
        ? ok({
            lock: {
              held: true,
              mine: false,
              holder: { kind: "person", principalId: "usr_x" },
              expiresAt: 1,
            },
          })
        : undefined,
    );
    try {
      render(
        <QueryClientProvider client={createQueryClient()}>
          <DesktopPanel sessionId="se_1" />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
      await act(async () => f.release());
      const client = f.clients[0] as (typeof f.clients)[number];
      await act(async () => client.dispatchEvent(new Event("connect")));
      await screen.findByText("Someone else is in control.");
      const take = screen.getByRole("button", { name: "Take over" }) as HTMLButtonElement;
      expect(take.disabled).toBe(true);
      expect(client.viewOnly).toBe(true);
    } finally {
      f.restore();
    }
  });
});
