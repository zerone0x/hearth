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
const { SYSTEM_SECRET_NOTE } = await import("./SettingsPage");

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
    if (path === "/v1/settings/access-mode")
      return ok({ mode: "ask", source: "default", updatedAt: null });
    if (path === "/v1/sessions/se_1/access-mode")
      return ok({ sessionId: "se_1", override: null, global: "ask", mode: "ask" });
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

describe("settings page in a DOM", () => {
  const KEY = {
    id: "sec_1",
    name: "anthropic-key",
    kind: "model-key",
    scope: null,
    policy: {},
    meta: {},
    fingerprint: "hmac:3f9a00112233",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
  };
  const LOGIN = {
    ...KEY,
    id: "sec_2",
    name: "github",
    kind: "login",
    policy: { origins: ["https://github.com"], allow_any_field: false },
    fingerprint: "hmac:91c2aabbccdd",
  };
  const TOKEN = {
    ...KEY,
    id: "sec_4",
    name: "gh-cli",
    kind: "token",
    policy: { use: "hub", hosts: [] },
    fingerprint: "hmac:77aa11bb22cc",
  };

  function settingsHub(
    model: Record<string, unknown>,
    vault: Record<string, unknown> = { state: "enabled", kekCheck: "abc", key: "current" },
    secrets: readonly unknown[] = [KEY, LOGIN],
  ) {
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    hub((method, path, body) => {
      if (path === "/v1/vault/status") return ok(vault);
      if (path === "/v1/secrets" && method === "GET") return ok({ secrets });
      if (path === "/v1/settings/model" && method === "GET") return ok(model);
      if (method !== "GET") {
        sent.push({ method, path, body });
        if (path === "/v1/settings/model") return ok({ ...model, ...(body as object) });
        if (path === "/v1/secrets") return ok({ id: "sec_3", fingerprint: "hmac:0b7e44556677" });
        if (path.endsWith("/value")) return ok({ fingerprint: "hmac:ffff00001111", version: 2 });
        if (method === "DELETE") return new Response(null, { status: 204 });
      }
      return undefined;
    });
    return sent;
  }

  const NONE = {
    source: "none",
    provider: null,
    model: null,
    keyRef: null,
    keyFingerprint: null,
    updatedAt: null,
  };

  test("the secrets table shows fingerprints, scope and origins; the header links to it", async () => {
    settingsHub(NONE);
    renderApp("#/");
    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("#/settings");
    window.location.hash = "#/settings";
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const table = await screen.findByRole("table", { name: "Secrets" });
    const rows = within(table).getAllByTestId("secret-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("hmac:3f9a00112233");
    expect(rows[0]?.textContent).toContain("global");
    expect(rows[0]?.textContent).toContain("never");
    expect(rows[1]?.textContent).toContain("https://github.com");
  });

  test("adding a secret posts its value once, shows the fingerprint, and forgets the value", async () => {
    const sent = settingsHub(NONE);
    renderApp("#/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    const form = await screen.findByRole("form", { name: "Add secret" });
    // The kind picks the fields: a site login asks for origins, a username and a password.
    const kind = within(form).getByLabelText("Kind");
    fireEvent.change(kind, { target: { value: "login" } });
    expect(within(form).getByLabelText("Origins")).toBeTruthy();
    expect(within(form).getByLabelText("username")).toBeTruthy();
    fireEvent.change(kind, { target: { value: "model-key" } });
    expect(within(form).queryByLabelText("Origins")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "openai-key" } });
    const value = within(form).getByLabelText("Value") as HTMLInputElement;
    expect(value.type).toBe("password");
    expect(value.autocomplete).toBe("off");
    fireEvent.change(value, { target: { value: "sk-dom-test-secret" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    });
    expect(await within(form).findByText("hmac:0b7e44556677")).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/secrets",
        body: { name: "openai-key", kind: "model-key", fields: { value: "sk-dom-test-secret" } },
      },
    ]);
    // Cleared after the save, and nowhere on the page.
    expect(value.value).toBe("");
    expect(document.body.innerHTML).not.toContain("sk-dom-test-secret");
  });

  test("a token can be made usable by box commands, with the warning, on add and on rotate (decision 0041)", async () => {
    const sent = settingsHub(NONE, undefined, [
      TOKEN,
      { ...TOKEN, id: "sec_5", name: "npm", policy: { use: "box-env", hosts: [] } },
    ]);
    renderApp("#/settings");
    const table = await screen.findByRole("table", { name: "Secrets" });
    const rows = within(table).getAllByTestId("secret-row");
    expect(rows[0]?.textContent).not.toContain("visible to commands in the box");
    expect(rows[1]?.textContent).toContain("visible to commands in the box");

    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    const form = await screen.findByRole("form", { name: "Add secret" });
    // Only a token has the switch.
    expect(within(form).queryByRole("switch")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Kind"), { target: { value: "token" } });
    const toggle = within(form).getByRole("switch", { name: "Usable by box commands" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(form.textContent).not.toContain("visible to commands in the box");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(form.textContent).toContain("visible to commands in the box");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "github" } });
    fireEvent.change(within(form).getByLabelText("Value"), { target: { value: "ghp_dom" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    });
    await waitFor(() =>
      expect(sent.at(-1)).toEqual({
        method: "POST",
        path: "/v1/secrets",
        body: {
          name: "github",
          kind: "token",
          policy: { use: "box-env" },
          fields: { value: "ghp_dom" },
        },
      }),
    );
    fireEvent.keyDown(form, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add secret" })).toBeNull());

    // Rotate starts from the entry's use and sends the one chosen.
    fireEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: "Rotate" }));
    const rotate = await screen.findByRole("form", { name: "Rotate secret" });
    const again = within(rotate).getByRole("switch", { name: "Usable by box commands" });
    expect(again.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(again);
    fireEvent.change(within(rotate).getByLabelText("Value"), { target: { value: "npm_new" } });
    await act(async () => {
      fireEvent.click(within(rotate).getByRole("button", { name: "Rotate" }));
    });
    await waitFor(() =>
      expect(sent.at(-1)).toEqual({
        method: "PUT",
        path: "/v1/secrets/sec_5/value",
        body: { fields: { value: "npm_new" }, use: "hub" },
      }),
    );
  });

  test("rotate sends the new value to the entry; delete asks first", async () => {
    const sent = settingsHub(NONE);
    renderApp("#/settings");
    const table = await screen.findByRole("table", { name: "Secrets" });
    const first = within(table).getAllByTestId("secret-row")[0] as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Rotate" }));
    const form = await screen.findByRole("form", { name: "Rotate secret" });
    const value = within(form).getByLabelText("Value") as HTMLInputElement;
    fireEvent.change(value, { target: { value: "sk-dom-new" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Rotate" }));
    });
    expect(await within(form).findByText("hmac:ffff00001111")).toBeTruthy();
    expect(sent.at(-1)).toEqual({
      method: "PUT",
      path: "/v1/secrets/sec_1/value",
      body: { fields: { value: "sk-dom-new" } },
    });
    // Cleared after the save while the dialog is still open, and nowhere on the page.
    expect(value.value).toBe("");
    expect(document.body.innerHTML).not.toContain("sk-dom-new");
    fireEvent.keyDown(form, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("form", { name: "Rotate secret" })).toBeNull());

    fireEvent.click(within(first).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("vault:anthropic-key will fail");
    expect(sent.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() =>
      expect(sent.at(-1)).toEqual({ method: "DELETE", path: "/v1/secrets/sec_1", body: undefined }),
    );
  });

  test("a hub-managed entry (Bifrost's secrets, 0046) shows no Rotate or Delete", async () => {
    const SYSTEM = {
      ...TOKEN,
      id: "sec_9",
      name: "bifrost-encryption-key",
      fingerprint: "hmac:5e5e00aa11bb",
      system: true,
    };
    settingsHub(NONE, undefined, [KEY, SYSTEM]);
    renderApp("#/settings");
    const table = await screen.findByRole("table", { name: "Secrets" });
    const rows = within(table).getAllByTestId("secret-row");
    const managed = rows[1] as HTMLElement;
    expect(managed.textContent).toContain("bifrost-encryption-key");
    expect(managed.textContent).toContain(SYSTEM_SECRET_NOTE);
    expect(within(managed).queryByRole("button")).toBeNull();
    // An ordinary entry keeps both.
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "Rotate" })).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  // Non-modal (0038), so nothing else stops a stray click from dismissing it (#142).
  test("the delete confirm stays open after a click outside it; Cancel closes it", async () => {
    const sent = settingsHub(NONE);
    renderApp("#/settings");
    const table = await screen.findByRole("table", { name: "Secrets" });
    const first = within(table).getAllByTestId("secret-row")[0] as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    // Radix listens for outside pointer-downs from the next tick on.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // A whole click on the page behind it: Radix may wait for the click to dismiss.
    await act(async () => {
      fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
      fireEvent.mouseDown(document.body, { button: 0 });
      fireEvent.pointerUp(document.body, { button: 0, pointerType: "mouse" });
      fireEvent.mouseUp(document.body, { button: 0 });
      fireEvent.click(document.body, { button: 0 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.queryByRole("alertdialog")).toBe(confirm);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sent.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  test("the model card saves provider, model and the vault key", async () => {
    const sent = settingsHub({
      ...NONE,
      source: "settings",
      provider: "anthropic",
      model: "claude-old",
      keyRef: "vault:anthropic-key",
      keyFingerprint: KEY.fingerprint,
    });
    renderApp("#/settings");
    const form = await screen.findByRole("form", { name: "Model" });
    const key = within(form).getByLabelText("Key") as HTMLSelectElement;
    expect(key.value).toBe("vault:anthropic-key");
    expect(key.selectedOptions[0]?.textContent).toBe(`anthropic-key (${KEY.fingerprint})`);
    fireEvent.change(within(form).getByLabelText("Model"), { target: { value: "claude-new" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    });
    expect(await screen.findByText("Saved. New turns use anthropic/claude-new.")).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "PUT",
        path: "/v1/settings/model",
        body: { provider: "anthropic", model: "claude-new", keyRef: "vault:anthropic-key" },
      },
    ]);
  });

  test("with the model set in deploy/.env the card is read-only", async () => {
    settingsHub({ ...NONE, source: "env", provider: "anthropic", model: "claude-env" });
    renderApp("#/settings");
    const form = await screen.findByRole("form", { name: "Model" });
    expect(within(form).getByText("Set by deploy/.env")).toBeTruthy();
    expect((within(form).getByLabelText("Model") as HTMLInputElement).disabled).toBe(true);
    expect(within(form).queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("a disabled vault says why and blocks adding and rotating", async () => {
    settingsHub(NONE, {
      state: "disabled",
      reason: "key-missing",
      message: "add deploy/secrets/vault_key and restart the hub",
    });
    renderApp("#/settings");
    expect(await screen.findByText("The vault is off (key-missing)")).toBeTruthy();
    expect(screen.getByText("add deploy/secrets/vault_key and restart the hub")).toBeTruthy();
    await screen.findByRole("table", { name: "Secrets" });
    expect((screen.getByRole("button", { name: "Add secret" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    for (const button of screen.getAllByRole("button", { name: "Rotate" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe("access mode in a DOM (decision 0045)", () => {
  /** A hub whose global default and session override change as the UI saves them. */
  function accessHub(initial: { global: "yolo" | "ask"; override: "yolo" | "ask" | null }) {
    const state = { ...initial };
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    const sessionView = () => ({
      sessionId: "se_1",
      override: state.override,
      global: state.global,
      mode: state.override ?? state.global,
    });
    hub((method, path, body) => {
      if (path === "/v1/vault/status")
        return ok({ state: "enabled", kekCheck: "a", key: "current" });
      if (path === "/v1/secrets") return ok({ secrets: [] });
      if (path === "/v1/settings/model")
        return ok({ source: "none", provider: null, model: null, keyRef: null });
      if (path === "/v1/settings/access-mode") {
        if (method === "PUT") {
          sent.push({ method, path, body });
          state.global = (body as { mode: "yolo" | "ask" }).mode;
        }
        return ok({ mode: state.global, source: "settings", updatedAt: 5 });
      }
      if (path === "/v1/sessions/se_1/access-mode") {
        if (method === "PUT") {
          sent.push({ method, path, body });
          state.override = (body as { mode: "yolo" | "ask" | null }).mode;
        }
        return ok(sessionView());
      }
      return undefined;
    });
    return { sent };
  }

  test("the Settings card saves the global default", async () => {
    const { sent } = accessHub({ global: "ask", override: null });
    renderApp("#/settings");
    const form = await screen.findByRole("form", { name: "Access mode" });
    const select = within(form).getByLabelText("Default for sessions") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("ask"));
    expect([...select.options].map((o) => o.value)).toEqual(["ask", "yolo"]);
    fireEvent.change(select, { target: { value: "yolo" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    });
    expect(
      await within(form).findByText(
        "Saved. Sessions that follow the default use yolo from their next tool call.",
      ),
    ).toBeTruthy();
    expect(sent).toEqual([
      { method: "PUT", path: "/v1/settings/access-mode", body: { mode: "yolo" } },
    ]);
  });

  test("the session header shows the mode and sets or clears the override", async () => {
    const { sent } = accessHub({ global: "yolo", override: null });
    renderApp("#/s/se_1");
    const select = (await screen.findByLabelText("Access")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("default"));
    expect(select.selectedOptions[0]?.textContent).toBe("Default (yolo)");
    expect(screen.getByTestId("access-mode").dataset["mode"]).toBe("yolo");

    await act(async () => {
      fireEvent.change(select, { target: { value: "ask" } });
    });
    await waitFor(() => expect(screen.getByTestId("access-mode").dataset["mode"]).toBe("ask"));
    expect(select.value).toBe("ask");

    await act(async () => {
      fireEvent.change(select, { target: { value: "default" } });
    });
    await waitFor(() => expect(screen.getByTestId("access-mode").dataset["mode"]).toBe("yolo"));
    expect(select.value).toBe("default");
    expect(sent).toEqual([
      { method: "PUT", path: "/v1/sessions/se_1/access-mode", body: { mode: "ask" } },
      { method: "PUT", path: "/v1/sessions/se_1/access-mode", body: { mode: null } },
    ]);
  });

  test("a refused change says why and keeps the mode the hub has", async () => {
    hub((method, path) => {
      if (path === "/v1/sessions/se_1/access-mode") {
        return method === "PUT"
          ? fail(403, "session.access_mode.update denied")
          : ok({ sessionId: "se_1", override: "ask", global: "yolo", mode: "ask" });
      }
      return undefined;
    });
    renderApp("#/s/se_1");
    const select = (await screen.findByLabelText("Access")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("ask"));
    await act(async () => {
      fireEvent.change(select, { target: { value: "yolo" } });
    });
    expect(await screen.findByText("session.access_mode.update denied")).toBeTruthy();
    expect(select.value).toBe("ask");
    expect(screen.getByTestId("access-mode").dataset["mode"]).toBe("ask");
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

describe("live tool output after a failed turn", () => {
  test("a call the turn cut off shows as interrupted, without its live block", async () => {
    let seq = 0;
    const ev = (type: string, payload: unknown) => ({ seq: ++seq, ts: 0, type, payload });
    const call = { type: "toolCall", id: "b2", name: "bash", arguments: { command: "x" } };
    const step = { role: "assistant", content: [call], stopReason: "toolUse", timestamp: 1 };
    const chat = applyHubEvents(emptyChat("se_f"), [
      ev("pi.agent_start", {}),
      ev("pi.message_start", { message: step }),
      ev("pi.message_end", { message: step }),
      ev("pi.tool_execution_start", { toolCallId: "b2", toolName: "bash", args: { command: "x" } }),
      ev("tool.output", { toolCallId: "b2", seq: 0, text: "partial\n" }),
      ev("runner.failed", { message: "boom" }),
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
    expect(await screen.findByRole("button", { name: "Tool call bash: interrupted" })).toBeTruthy();
    expect(screen.queryByRole("log", { name: "Live output of bash" })).toBeNull();
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
