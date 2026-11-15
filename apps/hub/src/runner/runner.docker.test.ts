/**
 * The M1 core proof (#43; decisions 0009, 0015): a real hub with the pi runner
 * on pi-ai's faux model (no model credits), a real `DockerBoxProvider` and the
 * real box image. Over the HTTP API, behind the login, one message makes the
 * model write and edit a file in the box's /workspace and run a command there;
 * the results come back as events through the cursor API.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md). CI runs it in the
 * `box-provider` job after `scripts/box-firewall.sh apply`.
 *
 *   HEARTH_BOX_AGENT_IMAGE  defaults to `hearth-box:ci`.
 *   HEARTH_DOCKER_SOCKET    optional, defaults to /var/run/docker.sock.
 *   HEARTH_BOX_PORT         the box listener port the firewall allows (8788).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { LOCAL_PRINCIPAL, type SecretStore, SecretValue } from "@hearth/core";
import { SESSION_COOKIE } from "../auth";
import { DEFAULT_DOCKER_SOCKET } from "../box/docker/config";
import { DockerBoxProvider } from "../box/docker/provider";
import { DEFAULT_BOX_PORT, type Hub, parsePort, startHub } from "../server";

const enabled = process.env["HEARTH_DOCKER_TESTS"] === "1";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const boxPort = parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT);
const instance = `hearthrun${process.pid}${Math.floor(Math.random() * 1e6)}`;

const provider = new DockerBoxProvider({
  config: {
    socketPath,
    instance,
    pullPolicy: "never",
    limits: { cpus: 1, memoryBytes: 1024 ** 3, pids: 512 },
    stopGraceMs: 2_000,
  },
});

/** The faux model needs no key; the runner still goes through the SecretStore. */
const fauxSecrets: SecretStore = {
  resolve: async () => new SecretValue("faux-key-not-a-secret"),
  fingerprint: async () => "fp",
  preflight: async () => ({ ok: true, failures: [] }) as never,
  invalidate: () => {},
};

interface StoredEvent {
  seq: number;
  type: string;
  payload: unknown;
}

describe.skipIf(!enabled)("pi runner with a Docker box (M1 core)", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;

  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("the model edits a file in /workspace and runs a command; results come back as events", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-runner-docker-"));
    const faux = fauxProvider({ provider: "faux" });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    hub = startHub({
      port: 0,
      boxPort,
      provider,
      boxImage: image,
      dbPath: join(dir, "hub.db"),
      log: (line) => console.log(line),
      sessions: { connectDeadlineMs: 120_000, runningGraceMs: 500 },
      runner: {
        config: { provider: "faux", model: faux.getModel().id, apiKeyRef: "env:FAUX_KEY" },
        secrets: fauxSecrets,
        modelRuntime,
      },
    });
    const h = hub;
    const cookie = `${SESSION_COOKIE}=${h.auth.issueSession(LOCAL_PRINCIPAL).token}`;
    const api = async (path: string, body?: unknown) => {
      const res = await fetch(new URL(path, h.url), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    const created = await api("/v1/sessions", { title: "runner e2e" });
    expect(created.status).toBe(201);
    const { id } = created.json["session"] as { id: string };

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "write",
            { path: "hello.txt", content: "hello from pi\n" },
            { id: "c_write" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            "edit",
            { path: "hello.txt", edits: [{ oldText: "hello", newText: "edited" }] },
            { id: "c_edit" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            "bash",
            { command: "cat /workspace/hello.txt && pwd && test -f /.dockerenv && echo in-box" },
            { id: "c_bash" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const sent = await api(`/v1/sessions/${id}/messages`, { text: "edit hello.txt and show it" });
    expect(sent.status).toBe(202);

    // Read events with the cursor until the turn ended.
    const events: StoredEvent[] = [];
    let after = 0;
    const end = Date.now() + 240_000;
    while (!events.some((e) => e.type === "pi.agent_end" || e.type === "runner.failed")) {
      if (Date.now() > end) throw new Error(`turn did not end: ${events.map((e) => e.type)}`);
      const page = await api(`/v1/sessions/${id}/events?after=${after}&limit=100`);
      expect(page.status).toBe(200);
      events.push(...(page.json["events"] as StoredEvent[]));
      after = page.json["cursor"] as number;
      if (page.json["hasMore"] !== true) await Bun.sleep(200);
    }
    const types = events.map((e) => e.type);
    expect(types).not.toContain("runner.failed");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    type ToolEnd = {
      toolCallId: string;
      toolName: string;
      isError: boolean;
      result: { content: Array<{ type: string; text?: string }> };
    };
    const ends = events
      .filter((e) => e.type === "pi.tool_execution_end")
      .map((e) => e.payload as ToolEnd);
    expect(ends.map((e) => [e.toolCallId, e.toolName, e.isError])).toEqual([
      ["c_write", "write", false],
      ["c_edit", "edit", false],
      ["c_bash", "bash", false],
    ]);
    const bash = ends[2]?.result.content.map((c) => c.text ?? "").join("") ?? "";
    // The edit landed in the box's /workspace, and the command ran in the container.
    expect(bash).toContain("edited from pi");
    expect(bash).not.toContain("hello from pi");
    expect(bash).toContain("/workspace");
    expect(bash).toContain("in-box");

    const runner = await api(`/v1/sessions/${id}/runner`);
    expect(runner.json["runner"]).toMatchObject({ status: "idle", failure: null });
    // The tool calls went through the session's box: it was started lazily.
    const session = await api(`/v1/sessions/${id}`);
    expect(["running", "idle"]).toContain((session.json["session"] as { state: string }).state);
    expect(types).toContain("session.state");
    expect(types).toContain("runner.usage");
  }, 600_000);
});
