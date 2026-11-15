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
