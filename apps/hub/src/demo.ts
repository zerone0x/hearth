/**
 * M0 demo (docs/demo.md): start a hub, launch a box-agent with a one-time join
 * token, and send `echo` over the hub's HTTP endpoint.
 *
 *   bun apps/hub/src/demo.ts
 *
 * The box-agent runs as a local child process here; the Docker variant is the
 * `HEARTH_DOCKER_TESTS=1` test in `box/echo.docker.test.ts`. Everything lives
 * in a temporary directory that is removed at the end.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PRINCIPAL } from "@hearth/core";
import { SESSION_COOKIE } from "./auth";
import { BOX_ENV, startHub } from "./server";

/** How long the demo waits for the box to dial in. */
const CONNECT_DEADLINE_MS = 15_000;

const dir = mkdtempSync(join(tmpdir(), "hearth-demo-"));
const hub = startHub({ port: 0, boxPort: 0, dbPath: join(dir, "hub.db") });
// The box is a local process here, so its listener is on loopback too.
const boxSocketUrl = hub.listenForBoxes("127.0.0.1");
let box: Bun.Subprocess | undefined;
let code = 0;
try {
  console.log(`hub listening on ${hub.url}`);
  const { token, expiresAt } = await hub.issueJoinToken("box_demo", "ses_demo");
  console.log(
    `join token for box_demo issued (single use, expires ${new Date(expiresAt).toISOString()})`,
  );

  box = Bun.spawn([process.execPath, join(import.meta.dir, "../../box-agent/src/main.ts")], {
    env: {
      ...process.env,
      [BOX_ENV.hubUrl]: boxSocketUrl,
      [BOX_ENV.boxId]: "box_demo",
      [BOX_ENV.joinToken]: token,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await hub.boxes.waitForBox("box_demo", CONNECT_DEADLINE_MS);
  console.log("box_demo connected");

  // Signed in as the owner (decision 0014); the demo has no password to type.
  const session = hub.auth.issueSession(LOCAL_PRINCIPAL);
  const res = await fetch(new URL("/v1/boxes/box_demo/echo", hub.url), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session.token}` },
    body: JSON.stringify({ message: "hello from the hub" }),
    signal: AbortSignal.timeout(CONNECT_DEADLINE_MS),
  });
  console.log(`POST /v1/boxes/box_demo/echo -> ${res.status} ${await res.text()}`);
  if (res.status !== 200) code = 1;
} catch (error) {
  console.error(`demo failed: ${String(error)}`);
  code = 1;
} finally {
  box?.kill("SIGTERM");
  await box?.exited;
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
