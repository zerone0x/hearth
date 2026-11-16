/**
 * The browser tools and the desktop lock on the real hub wiring (#126,
 * decision 0035): `startHub` hands its `DesktopLocks` to the runners, so a
 * `browser_*` call made while the owner holds the desktop is refused with
 * `desktop.locked` before any box lease, and the trajectory records it. After
 * the release the same tool goes on to the box again.
 *
 * No box runs here: a refused call never asks for one, and once released the
 * call reaching `ensureBox` (stubbed to fail) is the proof it was dispatched.
 * The browser results themselves are covered by runner.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_WORKSPACE_ID,
  HearthError,
  LOCAL_PRINCIPAL,
  type SecretStore,
  type StoredEvent,
} from "@hearth/core";
import { type Hub, startHub } from "../server";
import { DESKTOP_LOCKED_MESSAGE } from "./browser-tools";

const dirs: string[] = [];
const hubs: Hub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** No key reference is configured, so nothing is resolved. */
const noSecrets = {
  resolve: async () => {
    throw new Error("no secret is resolved in this test");
  },
} as unknown as SecretStore;

const NO_BOX = "no box in this test";

async function fixture(): Promise<{ hub: Hub; faux: FauxProviderHandle; leases: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "hearth-browser-lock-"));
  dirs.push(dir);
  const faux = fauxProvider({ provider: "faux" });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const hub = startHub({
    dbPath: join(dir, "hub.db"),
    port: 0,
    boxPort: 0,
    log: () => undefined,
    runner: {
      config: { provider: "faux", model: faux.getModel().id },
      secrets: noSecrets,
      modelRuntime: runtime,
    },
  });
  hubs.push(hub);
  // Every box lease the runners ask for, refused: there is no box provider.
  const leases: string[] = [];
  hub.sessions.ensureBox = async (sessionId) => {
    leases.push(sessionId);
    throw new HearthError(NO_BOX, { owner: "hub", disposition: "give-up", code: "box.none" });
  };
  return { hub, faux, leases };
}

type Result = { role: string; toolCallId?: string; isError?: boolean; content?: unknown };

function resultText(
  messages: readonly unknown[],
  id: string,
): { isError: boolean | undefined; text: string } {
  const m = (messages as Result[]).find((r) => r.role === "toolResult" && r.toolCallId === id);
  const parts = (m?.content ?? []) as Array<{ text?: string }>;
  return { isError: m?.isError, text: parts.map((p) => p.text ?? "").join("") };
}

async function steps(hub: Hub, sessionId: string): Promise<Record<string, unknown>[]> {
  const page = await hub.events.read({ workspaceId: DEFAULT_WORKSPACE_ID }, sessionId, 0, 1000);
  return page.events
    .filter((e: StoredEvent) => e.type === "runner.step")
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => p["kind"] === "tool_call");
}

async function browse(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, id: string) {
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("browser_tabs", { action: "list" }, { id })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("ok"),
  ]);
  await f.hub.runners?.send(LOCAL_PRINCIPAL, sessionId, "list the tabs");
  const runner = await f.hub.runners?.runner(sessionId);
  await runner?.settled();
  return runner;
}

describe("browser tools and the desktop lock (#126)", () => {
  test("held: refused with desktop.locked, no box lease, recorded; released: dispatched again", async () => {
    const f = await fixture();
    const session = await f.hub.sessions.create(LOCAL_PRINCIPAL, { title: "t" });
    await f.hub.desktopLocks.acquire(LOCAL_PRINCIPAL, session.id);

    const runner = await browse(f, session.id, "c_locked");
    expect(runner?.status).toBe("idle");
    const locked = resultText(runner?.messages ?? [], "c_locked");
    expect(locked.isError).toBe(true);
    expect(locked.text).toBe(DESKTOP_LOCKED_MESSAGE);
    expect(f.leases).toEqual([]);
    const [refused] = await steps(f.hub, session.id);
    expect(refused).toMatchObject({
      name: "browser_tabs",
      tool_call_id: "c_locked",
      is_error: true,
      outcome: "desktop-locked",
      refused_code: "desktop.locked",
      box_id: null,
      rpcs: [],
    });
    expect(String((refused?.["result"] as { text?: unknown })?.["text"])).toContain(
      "user is in control",
    );

    await f.hub.desktopLocks.release(LOCAL_PRINCIPAL, session.id);
    await browse(f, session.id, "c_free");
    const free = resultText(runner?.messages ?? [], "c_free");
    // Past the lock: the call asked for the box (none here), so it was dispatched.
    expect(f.leases).toEqual([session.id]);
    expect(free.text).toContain(NO_BOX);
    const after = (await steps(f.hub, session.id)).find((s) => s["tool_call_id"] === "c_free");
    expect(after?.["outcome"]).toBe("error");
    expect(after).not.toHaveProperty("refused_code");
  });

  test("another session's lock does not refuse this session's browser tools", async () => {
    const f = await fixture();
    const held = await f.hub.sessions.create(LOCAL_PRINCIPAL, { title: "held" });
    const free = await f.hub.sessions.create(LOCAL_PRINCIPAL, { title: "free" });
    await f.hub.desktopLocks.acquire(LOCAL_PRINCIPAL, held.id);
    const runner = await browse(f, free.id, "c_other");
    expect(resultText(runner?.messages ?? [], "c_other").text).toContain(NO_BOX);
    expect(f.leases).toEqual([free.id]);
  });
});
