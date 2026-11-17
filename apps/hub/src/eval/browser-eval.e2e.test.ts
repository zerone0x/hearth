/**
 * The browser eval B1-B6 end to end (#119, decision 0040; the M2 exit check
 * for S2). A real hub with the vault and the pi runner on pi-ai's faux model
 * scripted per task (`browser-tasks.ts`); the box serves the fixture site
 * (`fixtures/browser-fixtures.py`) to its own Chromium. After the run the
 * trajectory is dumped with `trajectory-cli.ts` (blobs exported) and scored
 * by `browser-score.ts`, both as the owner would run them, so the verdict
 * comes from the trajectory alone. The scorer also searches the dump, the
 * blobs, the hub's log, every stored event and every model request for the
 * vault values (PRD §11.2 exit criteria).
 *
 * Two modes:
 * - `HEARTH_DOCKER_TESTS=1`: the real box image under `DockerBoxProvider`
 *   (CI's `box-provider` job, under the box firewall);
 * - `HEARTH_CHROMIUM=<binary>` without Docker: box-agent as a local process
 *   (as the web e2e runs it) driving that Chromium over CDP.
 * Skipped otherwise. `HEARTH_EVAL_DIR` keeps the JSONL, blobs and report.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createDefaultSecretStore,
  DEFAULT_WORKSPACE_ID,
  LOCAL_PRINCIPAL,
  type SecretStore,
  SecretValue,
} from "@hearth/core";
import { TestChromium } from "../../../box-agent/src/browser/chromium.testkit";
import { LocalBoxProvider } from "../../../web/e2e/harness";
import { SESSION_COOKIE } from "../auth";
import { DEFAULT_DOCKER_SOCKET } from "../box/docker/config";
import { DockerBoxProvider } from "../box/docker/provider";
import { readAllEvents } from "../obs/routes";
import { DEFAULT_BOX_PORT, type Hub, parsePort, startHub } from "../server";
import { openDatabase, SqliteEventStore } from "../store";
import { browserTasks, FIXTURE_SECRET_NAME, type FixtureLogin } from "./browser-tasks";

const docker = process.env["HEARTH_DOCKER_TESTS"] === "1";
const chromiumPath = process.env["HEARTH_CHROMIUM"] ?? "";
const enabled = docker || chromiumPath !== "";
const image = process.env["HEARTH_BOX_AGENT_IMAGE"] || "hearth-box:ci";
const socketPath = process.env["HEARTH_DOCKER_SOCKET"] || DEFAULT_DOCKER_SOCKET;
const boxPort = parsePort(process.env["HEARTH_BOX_PORT"], DEFAULT_BOX_PORT);
const ROOT = join(import.meta.dir, "../../../..");

/** Values with characters every encoding changes, so each encoded form differs from the raw one. */
const LOGIN: FixtureLogin = {
  username: `fx-user-${crypto.randomUUID().slice(0, 8)}`,
  password: `Fx pw/7+Q&z=41%"${crypto.randomUUID().slice(0, 8)}`,
};

const fauxSecrets: SecretStore = {
  resolve: async () => new SecretValue("faux-key-not-a-secret"),
  fingerprint: async () => "fp",
  preflight: async () => ({ ok: true, failures: [] }) as never,
  invalidate: () => {},
};

interface StoredEvent {
  type: string;
}

describe.skipIf(!enabled)(
  `browser eval B1-B6 (${docker ? "Docker box" : "local box-agent"})`,
  () => {
    let hub: Hub | undefined;
    let provider: DockerBoxProvider | LocalBoxProvider | undefined;
    let chromium: TestChromium | undefined;
    let dir: string | undefined;

    afterAll(async () => {
      for (const box of (await provider?.adopt()) ?? [])
        await provider?.destroy(box.boxId as never);
      await hub?.stop();
      await chromium?.stop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    });

    test("every task passes on the trajectory alone, and no vault value leaks", async () => {
      dir = mkdtempSync(join(tmpdir(), "hearth-browser-eval-"));
      const out = process.env["HEARTH_EVAL_DIR"] || join(dir, "eval");
      mkdirSync(out, { recursive: true });
      let sitePort = 8765;
      let workspace: string | undefined;
      if (docker) {
        provider = new DockerBoxProvider({
          config: {
            socketPath,
            instance: `heartheval${process.pid}${Math.floor(Math.random() * 1e6)}`,
            pullPolicy: "never",
            limits: { cpus: 1, memoryBytes: 2 * 1024 ** 3, pids: 1024 },
            stopGraceMs: 2_000,
          },
        });
      } else {
        chromium = new TestChromium(chromiumPath);
        await chromium.start();
        workspace = join(dir, "workspace");
        mkdirSync(workspace);
        provider = new LocalBoxProvider(workspace, 5999, {
          HEARTH_CDP_PORT: String(chromium.port),
        });
        sitePort = 20_000 + Math.floor(Math.random() * 10_000);
      }

      const faux = fauxProvider({ provider: "faux" });
      const modelRuntime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      const logs: string[] = [];
      const dbPath = join(dir, "hub.db");
      hub = startHub({
        port: 0,
        boxPort: docker ? boxPort : 0,
        provider,
        boxImage: image,
        dbPath,
        ...(workspace === undefined
          ? {}
          : { boxEgress: () => ({ state: "unrestricted", detail: "eval: local processes" }) }),
        log: (line) => {
          logs.push(line);
          console.log(line);
        },
        sessions: { connectDeadlineMs: 120_000, runningGraceMs: 500 },
        runner: {
          config: { provider: "faux", model: faux.getModel().id, apiKeyRef: "env:FAUX_KEY" },
          secrets: fauxSecrets,
          modelRuntime,
          ...(workspace === undefined ? {} : { boxCwd: workspace }),
        },
        vault: {
          keyRef: "env:HEARTH_EVAL_VAULT_KEY",
          keySecrets: createDefaultSecretStore({
            env: {
              HEARTH_EVAL_VAULT_KEY: Buffer.from(
                crypto.getRandomValues(new Uint8Array(32)),
              ).toString("base64"),
            },
          }),
        },
      });
      // These runs test tools, not the gate: `ask` would hold a risky call (decision 0048).
      await hub.accessModes.putGlobal(LOCAL_PRINCIPAL, { mode: "yolo" });
      const h = hub;
      expect((await h.vaultReady).state).toBe("enabled");
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

      const secret = await api("/v1/secrets", {
        name: FIXTURE_SECRET_NAME,
        kind: "login",
        policy: { origins: [`http://127.0.0.1:${sitePort}`] },
        fields: LOGIN,
      });
      expect(secret.status).toBe(201);
      const created = await api("/v1/sessions", { title: "browser eval" });
      expect(created.status).toBe(201);
      const { id } = created.json["session"] as { id: string };

      // One turn per task, in order; each waits for the previous to end.
      let after = 0;
      let ended = 0;
      // Every request the model got, for the leak check (PRD §11.2: "model request").
      const requests: string[] = [];
      for (const task of browserTasks(sitePort, LOGIN)) {
        faux.setResponses(
          task.steps.map(
            (step): FauxResponseStep =>
              (context, ...rest) => {
                requests.push(JSON.stringify(context));
                return typeof step === "function" ? step(context, ...rest) : step;
              },
          ),
        );
        const sent = await api(`/v1/sessions/${id}/messages`, { text: task.prompt });
        expect(sent.status).toBe(202);
        const end = Date.now() + 300_000;
        for (;;) {
          if (Date.now() > end) throw new Error(`${task.id} did not end`);
          const page = await api(`/v1/sessions/${id}/events?after=${after}&limit=100`);
          expect(page.status).toBe(200);
          const events = page.json["events"] as StoredEvent[];
          after = page.json["cursor"] as number;
          expect(events.map((e) => e.type)).not.toContain("runner.failed");
          ended += events.filter((e) => e.type === "pi.agent_end").length;
          if (ended > 0) break;
          if (page.json["hasMore"] !== true) await Bun.sleep(200);
        }
        ended = 0;
        console.log(`${task.id} ended`);
      }

      // The dump as the owner makes it, in its own process: without the vault key,
      // so nothing but the model key and credential shapes is redacted at dump time
      // and the leak check sees what the database holds.
      const blobs = join(out, "blobs");
      const dump = Bun.spawnSync(
        [
          process.execPath,
          join(ROOT, "apps/hub/src/trajectory-cli.ts"),
          "--db",
          dbPath,
          "--unredacted-ok",
          "--export-blobs",
          blobs,
          id,
        ],
        { stdout: "pipe", stderr: "pipe", env: { PATH: process.env["PATH"] ?? "" } },
      );
      console.log(dump.stderr.toString());
      expect(dump.exitCode).toBe(0);
      const trajectory = join(out, "trajectory.jsonl");
      writeFileSync(trajectory, dump.stdout);
      const secretsFile = join(dir, "secrets.json");
      writeFileSync(secretsFile, JSON.stringify([LOGIN.username, LOGIN.password]), { mode: 0o600 });
      const hubLog = join(out, "hub.log");
      writeFileSync(hubLog, `${logs.join("\n")}\n`);
      const modelLog = join(out, "model-requests.jsonl");
      writeFileSync(modelLog, `${requests.join("\n")}\n`);
      // Every stored event as it is, not only what the trajectory projects.
      const db = openDatabase(dbPath);
      const stored = await readAllEvents(
        new SqliteEventStore(db),
        { workspaceId: DEFAULT_WORKSPACE_ID },
        id,
      );
      db.close();
      const eventLog = join(out, "events.jsonl");
      writeFileSync(eventLog, `${stored.map((e) => JSON.stringify(e)).join("\n")}\n`);
      // The vault values did reach the box: the fills are in the events, as masks.
      expect(stored.some((e) => JSON.stringify(e.payload).includes("browser_fill"))).toBe(true);
      const score = Bun.spawnSync(
        [
          process.execPath,
          join(ROOT, "apps/hub/src/eval/browser-score.ts"),
          trajectory,
          "--blobs",
          blobs,
          "--secrets",
          secretsFile,
          "--log",
          hubLog,
          "--log",
          modelLog,
          "--log",
          eventLog,
          "--json",
          join(out, "report.json"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const report = score.stdout.toString();
      writeFileSync(join(out, "report.txt"), report);
      console.log(`browser eval report:\n${report}${score.stderr.toString()}`);
      expect(report).toContain("secret leaks: 0");
      expect(score.exitCode).toBe(0);
    }, 900_000);
  },
);
