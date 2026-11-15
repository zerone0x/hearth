/**
 * Spike tests for issue #40: pi 1.5.2 on Bun as the hub-side brain, with routed
 * tools and the faux model. No model credits, no network, no local processes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { FakeBox, sleep } from "./fake-box";
import { createFauxRuntime, createRunner, type RunnerOptions, storedEntries } from "./runner";

let root: string;
let agentDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hearth-pi-runner-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Message = { role: string; [key: string]: unknown };

function toolResults(messages: readonly unknown[]) {
  return (messages as Message[])
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      const content = m["content"] as Array<{ type: string; text?: string }>;
      return {
        id: m["toolCallId"] as string,
        name: m["toolName"] as string,
        isError: m["isError"] as boolean,
        text: content.map((c) => c.text ?? "").join(""),
      };
    });
}

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.at(-1) as Message | undefined;
}

async function setup(overrides: Partial<RunnerOptions> = {}, files: Record<string, string> = {}) {
  const box = overrides.box ?? new FakeBox(files);
  const runtime = overrides.runtime ?? (await createFauxRuntime(agentDir));
  const runner = await createRunner({ box, runtime, agentDir, boxHome: "/home/box", ...overrides });
  return { box, runtime, ...runner };
}

describe("routed tools", () => {
  test("all seven tools replace the built-ins and run in the box", async () => {
    const { box, runtime, session } = await setup({}, { "notes.txt": "alpha\nbeta\n" });
    expect(session.getActiveToolNames().sort()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "read", "write"].sort(),
    );
    runtime.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "write",
            { path: "src/a.ts", content: "export const a = 1;\n" },
            { id: "w" },
          ),
          fauxToolCall("read", { path: "notes.txt" }, { id: "r" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            "edit",
            { path: "src/a.ts", edits: [{ oldText: "= 1", newText: "= 2" }] },
            { id: "e" },
          ),
          fauxToolCall("ls", { path: "." }, { id: "l" }),
          fauxToolCall("find", { pattern: "*.ts" }, { id: "f" }),
          fauxToolCall("grep", { pattern: "beta" }, { id: "g" }),
          fauxToolCall("bash", { command: "uname -a" }, { id: "b" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("touch every tool");

    const results = toolResults(session.messages);
    expect(results.map((r) => [r.id, r.isError])).toEqual([
      ["w", false],
      ["r", false],
      ["e", false],
      ["l", false],
      ["f", false],
      ["g", false],
      ["b", false],
    ]);
    const text = Object.fromEntries(results.map((r) => [r.id, r.text]));
    expect(text["r"]).toContain("beta");
    expect(text["l"]).toContain("src/");
    expect(text["f"]).toContain("a.ts");
    expect(text["g"]).toContain("notes.txt:2: beta");
    expect(text["b"]).toContain("box ran: uname -a");
    expect(box.files.get("/workspace/src/a.ts")).toBe("export const a = 2;\n");
    // Every box call carries pi's tool call id, and the hub's disk saw nothing.
    expect(new Set(box.calls.map((c) => c.toolCallId))).toEqual(
      new Set(["w", "r", "e", "l", "f", "g", "b"]),
    );
    expect(existsSync("/workspace/src/a.ts")).toBe(false);
    // The bash backend never forwards the hub's environment.
    expect(box.execEnvs).toEqual([undefined]);
    session.dispose();
  });

  test("sibling tool calls run concurrently in the box", async () => {
    const { box, runtime, session } = await setup();
    box.delayMs.set("exec", 200);
    runtime.faux.setResponses([
      fauxAssistantMessage(
        [1, 2, 3].map((n) => fauxToolCall("bash", { command: `job ${n}` }, { id: `p${n}` })),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("all three ran"),
    ]);
    const started = performance.now();
    await session.prompt("run three jobs");
    const elapsed = performance.now() - started;

    const execs = box.calls.filter((c) => c.method === "exec");
    expect(execs).toHaveLength(3);
    const lastStart = Math.max(...execs.map((c) => c.startedAt));
    const firstEnd = Math.min(...execs.map((c) => c.endedAt ?? Number.POSITIVE_INFINITY));
    expect(lastStart).toBeLessThan(firstEnd);
    expect(elapsed).toBeLessThan(3 * 200);
    // Results are recorded in the assistant message's order, whatever finished first.
    expect(toolResults(session.messages).map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
    session.dispose();
  });

  test("bash output streamed through onData reaches the session as tool updates", async () => {
    const { box, runtime, session } = await setup();
    box.execHandler = async ({ emit }) => {
      for (let i = 1; i <= 4; i++) {
        emit(`line ${i}\n`);
        await sleep(150);
      }
      return 0;
    };
    const updates: string[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_update") {
        const partial = event.partialResult as { content: Array<{ text?: string }> };
        updates.push(partial.content.map((c) => c.text ?? "").join(""));
      }
    });
    runtime.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "build" }, { id: "s" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("built"),
    ]);
    await session.prompt("build it");

    // pi sends an empty update first, then throttled snapshots of the output so far.
    expect(updates[0]).toBe("");
    const nonEmpty = updates.filter((u) => u.length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(2);
    expect(nonEmpty[0]?.startsWith("line 1")).toBe(true);
    expect(toolResults(session.messages)[0]?.text).toBe("line 1\nline 2\nline 3\nline 4\n");
    session.dispose();
  });

  test("abort cancels the box command and leaves the session usable", async () => {
    const { box, runtime, session } = await setup();
    let sawAbort = false;
    box.execHandler = ({ emit, signal }) =>
      new Promise((_resolve, reject) => {
        emit("working...\n");
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted"));
        });
      });
    runtime.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 600" }, { id: "long" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("never sent"),
    ]);
    const prompt = session.prompt("wait forever");
    for (let i = 0; i < 100 && !box.calls.some((c) => c.method === "exec"); i++) await sleep(10);
    await session.abort();
    await prompt;

    expect(sawAbort).toBe(true);
    expect(box.calls.find((c) => c.method === "exec")?.outcome).toBe("aborted");
    const [result] = toolResults(session.messages);
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Command aborted");
    // The aborted run did not ask the model again.
    expect(runtime.faux.getPendingResponseCount()).toBe(1);

    runtime.faux.setResponses([fauxAssistantMessage("still here")]);
    await session.prompt("are you there?");
    expect(session.getLastAssistantText()).toBe("still here");
    session.dispose();
  });

  test("a tool_call handler blocks a call before it reaches the box", async () => {
    const { box, runtime, session } = await setup({
      policy: (event) =>
        event.toolName === "bash" && String(event.input["command"]).includes("rm -rf")
          ? { block: true, reason: "denied by approval" }
          : undefined,
    });
    runtime.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf /" }, { id: "x" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("ok, denied"),
    ]);
    await session.prompt("delete everything");
    expect(box.calls).toHaveLength(0);
    const [result] = toolResults(session.messages);
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("denied by approval");
    session.dispose();
  });

  test("a thrown backend error becomes a tool error the model sees", async () => {
    const { box, runtime, session } = await setup({}, { "a.txt": "x" });
    box.failNext.set("fs.read", new Error("box disk unreadable"));
    box.failNext.set("exec", new Error("box connection lost; outcome unknown"));
    let seenByModel: Array<{ isError: boolean; text: string }> = [];
    runtime.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("read", { path: "a.txt" }, { id: "r" }),
          fauxToolCall("bash", { command: "make" }, { id: "b" }),
        ],
        { stopReason: "toolUse" },
      ),
      (context): AssistantMessage => {
        seenByModel = toolResults(context.messages);
        return fauxAssistantMessage("I saw the errors");
      },
    ]);
    await session.prompt("read and build");
    expect(seenByModel).toEqual([
      expect.objectContaining({ isError: true, text: expect.stringContaining("unreadable") }),
      expect.objectContaining({ isError: true, text: "box connection lost; outcome unknown" }),
    ]);
    expect(session.getLastAssistantText()).toBe("I saw the errors");
    session.dispose();
  });

  test("a ~ path is rewritten to the box home, not the hub's", async () => {
    const { box, runtime, session } = await setup({}, { "/home/box/todo.md": "- ship" });
    runtime.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "~/todo.md" }, { id: "h" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("read it"),
    ]);
    await session.prompt("read my todo");
    expect(box.calls.find((c) => c.method === "fs.read")?.params["path"]).toBe("/home/box/todo.md");
    expect(toolResults(session.messages)[0]?.text).toContain("- ship");
    session.dispose();
  });

  test("write and edit to the same box path serialize across sessions in one process", async () => {
    // pi's file mutation queue is module-global and keyed by the resolved path, and
    // every runner's cwd is /workspace: two boxes writing /workspace/x wait on each other.
    const runtime = await createFauxRuntime(agentDir);
    const boxA = new FakeBox();
    const boxB = new FakeBox();
    boxA.delayMs.set("fs.write", 200);
    const a = await setup({ box: boxA, runtime });
    const b = await setup({ box: boxB, runtime });
    const writeA = a.session.agent.state.tools.find((t) => t.name === "write");
    const writeB = b.session.agent.state.tools.find((t) => t.name === "write");
    if (!writeA || !writeB) throw new Error("write tool missing");
    const params = { path: "shared.txt", content: "x" };
    await Promise.all([
      writeA.execute("wa", params, undefined, () => {}),
      sleep(20).then(() => writeB.execute("wb", params, undefined, () => {})),
    ]);
    const endA = boxA.calls[0]?.endedAt ?? 0;
    const startB = boxB.calls[0]?.startedAt ?? 0;
    expect(startB).toBeGreaterThanOrEqual(endA);
    a.session.dispose();
    b.session.dispose();
  });
});

describe("state", () => {
  test("a session rebuilt from stored entries continues the conversation", async () => {
    const box = new FakeBox({ "a.txt": "one" });
    const first = await setup({ box });
    first.runtime.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }, { id: "r1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("it says one"),
    ]);
    await first.session.prompt("what is in a.txt?");
    const stored = storedEntries(first.sessionManager);
    const before = JSON.stringify(first.session.messages);
    first.session.dispose();

    // A new runtime and a new box: only the stored entries carry the conversation.
    const second = await setup({ box: new FakeBox({ "a.txt": "two" }), entries: stored });
    expect(JSON.stringify(second.session.messages)).toBe(before);
    let roles: string[] = [];
    second.runtime.faux.setResponses([
      (context): AssistantMessage => {
        roles = (context.messages as Message[]).map((m) => m.role);
        return fauxAssistantMessage("continued");
      },
    ]);
    await second.session.prompt("and now?");
    // The model gets the whole stored conversation plus the new prompt.
    expect(roles).toEqual(["system", "user", "assistant", "toolResult", "assistant", "user"]);
    expect(second.session.getLastAssistantText()).toBe("continued");
    second.session.dispose();
  });

  test(
    "twenty concurrent sessions each finish a routed turn",
    async () => {
      const runtime = await createFauxRuntime(agentDir);
      const reply = (context: TranscriptContext): AssistantMessage =>
        lastMessage(context)?.role === "toolResult"
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), {
              stopReason: "toolUse",
            });
      runtime.faux.setResponses(Array.from({ length: 40 }, () => reply));
      const runners = await Promise.all(
        Array.from({ length: 20 }, () => setup({ box: new FakeBox(), runtime })),
      );
      await Promise.all(runners.map((r) => r.session.prompt("go")));
      for (const r of runners) {
        expect(r.box.calls.map((c) => c.method)).toEqual(["exec"]);
        expect(r.session.getLastAssistantText()).toBe("done");
        r.session.dispose();
      }
    },
    { timeout: 30_000 },
  );
});

describe("context files and skills (PRD §12 Q9)", () => {
  test("pi's default discovery reads the hub's disk from cwd up, not the box", async () => {
    const hubCwd = join(root, "hub-cwd");
    mkdirSync(join(hubCwd, ".pi", "skills", "hub-skill"), { recursive: true });
    writeFileSync(join(hubCwd, "AGENTS.md"), "hub-side rules");
    writeFileSync(
      join(hubCwd, ".pi", "skills", "hub-skill", "SKILL.md"),
      "---\nname: hub-skill\ndescription: A skill on the hub's disk.\n---\nbody\n",
    );
    const settingsManager = SettingsManager.inMemory({});
    settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: hubCwd,
      agentDir,
      settingsManager,
      noExtensions: true,
    });
    await loader.reload();
    expect(loader.getAgentsFiles().agentsFiles.map((f) => f.path)).toContain(
      join(hubCwd, "AGENTS.md"),
    );
    expect(loader.getSkills().skills.map((s) => s.name)).toContain("hub-skill");
  });

  test("the runner feeds the box's AGENTS.md through agentsFilesOverride", async () => {
    const box = new FakeBox({ "AGENTS.md": "Use tabs. Run make test." });
    const content = (await box.readFile("context", "/workspace/AGENTS.md")).toString();
    const { session, loader } = await setup({
      box,
      contextFiles: [{ path: "/workspace/AGENTS.md", content }],
    });
    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      { path: "/workspace/AGENTS.md", content: "Use tabs. Run make test." },
    ]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(session.systemPrompt).toContain("Use tabs. Run make test.");
    expect(session.systemPrompt).toContain("/workspace/AGENTS.md");
    session.dispose();
  });
});
