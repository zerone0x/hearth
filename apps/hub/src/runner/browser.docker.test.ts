/**
 * Browser tools end to end (#116; decision 0032): a real hub with the pi
 * runner on pi-ai's faux model, a real `DockerBoxProvider` and the real box
 * image, whose entrypoint runs Chromium with CDP on loopback (decision 0026).
 *
 * The model writes a fixture page into /workspace, serves it inside the box
 * with Python's static server, opens it with `browser_navigate`, reads refs
 * off the snapshot, types and selects by ref, clicks "Save" with an
 * expectation, takes a screenshot, and finally reads the server's access log.
 * The test checks the submitted values on the server side, not the model's
 * word for it.
 *
 * Runs only with HEARTH_DOCKER_TESTS=1 (AGENTS.md); CI runs it in the
 * `box-provider` job under the box firewall.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
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
const instance = `hearthbrowser${process.pid}${Math.floor(Math.random() * 1e6)}`;
const SITE_PORT = 8765;

const provider = new DockerBoxProvider({
  config: {
    socketPath,
    instance,
    pullPolicy: "never",
    limits: { cpus: 1, memoryBytes: 2 * 1024 ** 3, pids: 1024 },
    stopGraceMs: 2_000,
  },
});

const fauxSecrets: SecretStore = {
  resolve: async () => new SecretValue("faux-key-not-a-secret"),
  fingerprint: async () => "fp",
  preflight: async () => ({ ok: true, failures: [] }) as never,
  invalidate: () => {},
};

/** The fixture: a form whose Save sends the values to the box's own server, then says so. */
const FORM = `<!doctype html>
<html><head><title>Fixture form</title></head>
<body>
<h1>Profile</h1>
<label>Name <input id="name"></label>
<label>Color <select id="color"><option value="red">red</option><option value="blue">blue</option></select></label>
<button id="save">Save</button>
<p id="out"></p>
<script>
document.getElementById("save").addEventListener("click", async () => {
  const name = document.getElementById("name").value;
  const color = document.getElementById("color").value;
  await fetch("/submit?name=" + encodeURIComponent(name) + "&color=" + encodeURIComponent(color)).catch(() => {});
  document.getElementById("out").textContent = "Saved: " + name + "/" + color;
});
</script>
</body></html>
`;

/**
 * Starts the static server outside the call's process group and marker (so
 * the executor's cleanup leaves it running), then waits until it answers.
 */
const SERVE = [
  "cd /workspace/site",
  `env -u HEARTH_EXEC setsid nohup python3 -m http.server ${SITE_PORT} --bind 127.0.0.1 > /workspace/site/access.log 2>&1 < /dev/null &`,
  `for i in $(seq 1 50); do python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:${SITE_PORT}/form.html")' 2>/dev/null && echo serving && exit 0; sleep 0.2; done`,
  "echo 'server did not start'; exit 1",
].join("\n");

type ToolArgs = Parameters<typeof fauxToolCall>[1];

interface Part {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

function toolCall(name: string, args: ToolArgs, id: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

/** What a model does: read a ref off the last tool result's snapshot, then call a tool with it. */
function withRef(
  line: RegExp,
  next: (ref: string) => { name: string; args: ToolArgs; id: string },
): FauxResponseStep {
  return (context) => {
    const last = [...context.messages].reverse().find((m) => m.role === "toolResult") as
      | { content?: Part[] }
      | undefined;
    const text = (last?.content ?? []).map((p) => p.text ?? "").join("");
    const found = text.split("\n").find((l) => line.test(l)) ?? "";
    const ref = /\[ref=(s\d+(?:f\d+)?e\d+)\]/.exec(found)?.[1];
    if (ref === undefined) return fauxAssistantMessage(`no ref for ${line} in:\n${text}`);
    const step = next(ref);
    return toolCall(step.name, step.args, step.id);
  };
}

interface StoredEvent {
  seq: number;
  type: string;
  payload: unknown;
}

describe.skipIf(!enabled)("browser tools in a Docker box (M2, #116)", () => {
  let hub: Hub | undefined;
  let dir: string | undefined;

  afterAll(async () => {
    for (const box of await provider.adopt()) await provider.destroy(box.boxId);
    await hub?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("the agent opens a page served in the box, types, selects and clicks by ref, verified", async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-browser-docker-"));
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

    const created = await api("/v1/sessions", { title: "browser e2e" });
    expect(created.status).toBe(201);
    const { id } = created.json["session"] as { id: string };

    faux.setResponses([
      toolCall("write", { path: "site/form.html", content: FORM }, "c_write"),
      toolCall("bash", { command: SERVE, timeout: 60 }, "c_serve"),
      toolCall(
        "browser_navigate",
        {
          url: `http://127.0.0.1:${SITE_PORT}/form.html`,
          expect: { titleIncludes: "Fixture form" },
          expectTimeoutMs: 10_000,
        },
        "c_nav",
      ),
      withRef(/textbox "Name"/, (ref) => ({
        name: "browser_type",
        args: { ref, element: "Name field", text: "alice" },
        id: "c_type",
      })),
      withRef(/combobox "Color"/, (ref) => ({
        name: "browser_select",
        args: { ref, element: "Color select", values: ["blue"] },
        id: "c_select",
      })),
      withRef(/button "Save"/, (ref) => ({
        name: "browser_click",
        args: {
          ref,
          element: "Save button",
          expect: { textVisible: "Saved: alice/blue" },
          expectTimeoutMs: 10_000,
        },
        id: "c_click",
      })),
      toolCall("browser_screenshot", {}, "c_shot"),
      toolCall("bash", { command: "cat /workspace/site/access.log" }, "c_log"),
      fauxAssistantMessage("done"),
    ]);
    const sent = await api(`/v1/sessions/${id}/messages`, { text: "fill in the profile form" });
    expect(sent.status).toBe(202);

    const events: StoredEvent[] = [];
    let after = 0;
    const end = Date.now() + 300_000;
    while (!events.some((e) => e.type === "pi.agent_end" || e.type === "runner.failed")) {
      if (Date.now() > end) throw new Error(`turn did not end: ${events.map((e) => e.type)}`);
      const page = await api(`/v1/sessions/${id}/events?after=${after}&limit=100`);
      expect(page.status).toBe(200);
      events.push(...(page.json["events"] as StoredEvent[]));
      after = page.json["cursor"] as number;
      if (page.json["hasMore"] !== true) await Bun.sleep(200);
    }
    expect(events.map((e) => e.type)).not.toContain("runner.failed");

    type ToolEnd = {
      toolCallId: string;
      toolName: string;
      isError: boolean;
      result: { content: Part[] };
    };
    const ends = events
      .filter((e) => e.type === "pi.tool_execution_end")
      .map((e) => e.payload as ToolEnd);
    const text = (callId: string) =>
      (ends.find((e) => e.toolCallId === callId)?.result.content ?? [])
        .map((p) => p.text ?? "")
        .join("");
    for (const e of ends) {
      if (e.isError) console.log(`${e.toolCallId} failed: ${text(e.toolCallId)}`);
    }
    expect(ends.map((e) => [e.toolCallId, e.toolName, e.isError])).toEqual([
      ["c_write", "write", false],
      ["c_serve", "bash", false],
      ["c_nav", "browser_navigate", false],
      ["c_type", "browser_type", false],
      ["c_select", "browser_select", false],
      ["c_click", "browser_click", false],
      ["c_shot", "browser_screenshot", false],
      ["c_log", "bash", false],
    ]);
    expect(text("c_nav")).toContain('"verified":true');
    expect(text("c_nav")).toContain('"status":200');
    expect(text("c_click")).toContain('"outcome":"done"');
    expect(text("c_click")).toContain('"verified":true');
    expect(text("c_click")).toContain("Saved: alice/blue");
    // The server inside the box received the values: checked without the model's word.
    expect(text("c_log")).toContain("GET /submit?name=alice&color=blue");
    // The screenshot reached the model as an image part, not as text.
    const shot = ends.find((e) => e.toolCallId === "c_shot")?.result.content ?? [];
    const picture = shot.find((p) => p.type === "image");
    expect(picture?.mimeType).toBe("image/jpeg");
    expect(
      Buffer.from(picture?.data ?? "", "base64")
        .subarray(0, 2)
        .toString("hex"),
    ).toBe("ffd8");
    // The trajectory's step of the screenshot counts its image (decision 0021).
    const steps = events
      .filter((e) => e.type === "runner.step")
      .map(
        (e) => e.payload as { kind?: string; tool_call_id?: string; result?: { images?: number } },
      );
    expect(steps.find((s) => s.tool_call_id === "c_shot")?.result?.images).toBe(1);
  }, 600_000);
});
