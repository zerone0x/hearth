/**
 * `HEARTH_MODELS_FILE` (decision 0020): the runner loads providers from a pi
 * `models.json`, resolves the key through the SecretStore (a `file:`
 * reference, as compose mounts it) and sends it to that provider. Driven
 * through the faux model server the compose e2e uses, over real HTTP.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type AppendResult,
  createDefaultSecretStore,
  type EventPage,
  type EventStore,
  LOCAL_PRINCIPAL,
  type NewEvent,
  type StoredEvent,
} from "@hearth/core";
import { startFauxModel } from "../../../../deploy/e2e/faux-model";
import { runnerConfigFromEnv } from "../main";
import type { SessionView } from "../session/manager";
import { SessionRunners } from "./runners";

const dirs: string[] = [];
const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-models-file-"));
  dirs.push(dir);
  return dir;
}

class MemoryEvents implements EventStore {
  readonly list: StoredEvent[] = [];
  async append(_scope: unknown, sessionId: string, event: NewEvent): Promise<AppendResult> {
    const seq = this.list.length + 1;
    this.list.push({
      workspaceId: "ws_local",
      sessionId,
      seq,
      ts: Date.now(),
      type: event.type,
      payload: event.payload,
    });
    return { seq, duplicate: false };
  }
  async read(_scope: unknown, _sessionId: string, afterSeq: number, limit: number) {
    const events = this.list.filter((e) => e.seq > afterSeq).slice(0, limit);
    const page: EventPage = { events, cursor: events.at(-1)?.seq ?? afterSeq, hasMore: false };
    return page;
  }
  async lastSeq() {
    return this.list.length;
  }
}

function modelsFile(dir: string, baseUrl: string): string {
  const path = join(dir, "models.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        "faux-http": {
          baseUrl: `${baseUrl}/v1`,
          api: "openai-completions",
          models: [{ id: "faux-1", name: "Faux" }],
        },
      },
    }),
  );
  return path;
}

describe("runnerConfigFromEnv: HEARTH_MODELS_FILE", () => {
  test("an existing absolute file is passed through; unset means built-in models only", () => {
    const path = modelsFile(tempDir(), "http://127.0.0.1:1");
    const base = { HEARTH_MODEL_PROVIDER: "faux-http", HEARTH_MODEL: "faux-1" };
    expect(runnerConfigFromEnv({ ...base, HEARTH_MODELS_FILE: path })?.modelsFile).toBe(path);
    expect(runnerConfigFromEnv(base)?.modelsFile).toBeUndefined();
    expect(runnerConfigFromEnv({ ...base, HEARTH_MODELS_FILE: "" })?.modelsFile).toBeUndefined();
  });

  test("a relative or missing file, or a directory, is refused at startup", () => {
    const base = { HEARTH_MODEL_PROVIDER: "faux-http", HEARTH_MODEL: "faux-1" };
    // Relative, although it names an existing file from here.
    const existing = relative(process.cwd(), modelsFile(tempDir(), "http://127.0.0.1:1"));
    expect(() => runnerConfigFromEnv({ ...base, HEARTH_MODELS_FILE: existing })).toThrow(
      /HEARTH_MODELS_FILE/,
    );
    expect(() =>
      runnerConfigFromEnv({ ...base, HEARTH_MODELS_FILE: join(tempDir(), "missing.json") }),
    ).toThrow(/HEARTH_MODELS_FILE/);
    // An absolute path that exists but is a directory (a bind mount of the
    // wrong path makes one).
    expect(() => runnerConfigFromEnv({ ...base, HEARTH_MODELS_FILE: tempDir() })).toThrow(
      /HEARTH_MODELS_FILE/,
    );
  });
});

describe("SessionRunners with a models file", () => {
  test("a turn reaches the file's provider with the key from a file: secret", async () => {
    const faux = startFauxModel(0);
    closers.push(() => faux.stop());
    const dir = tempDir();
    const keyPath = join(dir, "model_key");
    writeFileSync(keyPath, "sk-faux-from-secret-file\n");
    const config = runnerConfigFromEnv({
      HEARTH_MODEL_PROVIDER: "faux-http",
      HEARTH_MODEL: "faux-1",
      HEARTH_MODEL_KEY_REF: `file:${keyPath}`,
      HEARTH_MODELS_FILE: modelsFile(dir, faux.url),
    });
    if (config === undefined) throw new Error("expected a runner config");
    faux.script([{ text: "hello from the faux model" }]);
    const events = new MemoryEvents();
    const runners = new SessionRunners({
      authorizer: { authorize: async () => ({ allowed: true, policy: "test" }) },
      events,
      sessions: {
        ensureBox: async () => {
          throw new Error("this turn uses no tools");
        },
        get: async (_p, id) => ({ id, state: "idle" }) as SessionView,
        fail: async () => {},
      },
      tools: {
        operations: () => {
          throw new Error("this turn uses no tools");
        },
      },
      secrets: createDefaultSecretStore({ env: {} }),
      config,
      boxCwd: dir,
      log: () => {},
    });
    closers.push(() => runners.close());

    await runners.send(LOCAL_PRINCIPAL, "se_a", "say hello");
    await (await runners.runner("se_a")).settled();

    expect(faux.requests.length).toBe(1);
    expect(faux.requests[0]?.authorization).toBe("Bearer sk-faux-from-secret-file");
    expect(faux.requests[0]?.model).toBe("faux-1");
    const stored = JSON.stringify(events.list);
    expect(stored).toContain("hello from the faux model");
    expect(stored).not.toContain("sk-faux-from-secret-file");
    expect(events.list.map((e) => e.type)).not.toContain("runner.failed");
  });
});
