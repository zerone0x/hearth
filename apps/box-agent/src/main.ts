import { HearthError } from "@hearth/core";
import { BROWSER_CONNECT_TIMEOUT_MS } from "@hearth/protocol";
import { describeBoxAgent } from "./agent";
import { EXIT_CONFIG, hardenOrExit, takeJoinToken } from "./boot";
import { PlaywrightDriver } from "./browser/playwright";
import { BrowserTools } from "./browser/tools";
import { BoxAgent } from "./connection";
import { DEFAULT_EXEC_ENV } from "./tools/executor";
import { DEFAULT_VNC_PORT } from "./vnc";

/** Exit code when the hub refused the box for good (a `reject` retrying cannot fix). */
const EXIT_REJECTED = 3;

/** Boot environment the hub passes through `BoxProvider.start` (see the hub's `BOX_ENV`). */
const HUB_URL_VAR = "HEARTH_HUB_URL";
const BOX_ID_VAR = "HEARTH_BOX_ID";
/** Optional override of the workspace root, for running box-agent outside the image. */
const WORKSPACE_VAR = "HEARTH_WORKSPACE";
const DEFAULT_WORKSPACE = "/workspace";
/** The desktop display commands may draw on; not a secret. */
const DISPLAY_VAR = "HEARTH_DISPLAY";
/** The port Xvnc listens on in the box (loopback only), as the image's entrypoint uses it. */
const VNC_PORT_VAR = "HEARTH_VNC_PORT";
/** The port of the desktop Chromium's CDP endpoint on loopback (decision 0026). */
const CDP_PORT_VAR = "HEARTH_CDP_PORT";
const DEFAULT_CDP_PORT = 9222;

const info = describeBoxAgent();
const banner = `hearth box-agent (protocol ${info.protocol}, pi ${info.pi})`;

async function main(): Promise<number> {
  // First, before the join token is read: no command this process runs may
  // read its environment or memory through /proc or ptrace (decision 0018).
  const hardened = await hardenOrExit({
    log: {
      warn: (message) => console.warn(`${banner}: ${message}`),
      error: (message) => console.error(`${banner}: ${message}`),
    },
  });
  if (hardened !== null) return hardened;
  const hubUrl = process.env[HUB_URL_VAR];
  const boxId = process.env[BOX_ID_VAR];
  if (!hubUrl || !boxId) {
    console.error(`${banner}: ${HUB_URL_VAR} and ${BOX_ID_VAR} must be set`);
    return EXIT_CONFIG;
  }
  let joinToken: string;
  try {
    // From the file the entrypoint wrote (deleted here), or from the environment
    // outside the image; both variables leave `process.env` (decision 0018).
    joinToken = await takeJoinToken({ env: process.env });
  } catch (error) {
    const reason = error instanceof HearthError ? error.message : String(error);
    console.error(`${banner}: no join token: ${reason}`);
    return EXIT_CONFIG;
  }

  const display = process.env[DISPLAY_VAR];
  const vncPort = Number(process.env[VNC_PORT_VAR] || DEFAULT_VNC_PORT);
  if (!Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535) {
    console.error(`${banner}: ${VNC_PORT_VAR} must be a port number`);
    return EXIT_CONFIG;
  }
  const cdpPort = Number(process.env[CDP_PORT_VAR] || DEFAULT_CDP_PORT);
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
    console.error(`${banner}: ${CDP_PORT_VAR} must be a port number`);
    return EXIT_CONFIG;
  }
  const root = process.env[WORKSPACE_VAR] || DEFAULT_WORKSPACE;
  // The browser tools (decision 0032): one lazy CDP connection to the desktop's Chromium.
  const browser = new BrowserTools({
    root,
    driver: new PlaywrightDriver({
      endpoint: `http://127.0.0.1:${cdpPort}`,
      connectTimeoutMs: BROWSER_CONNECT_TIMEOUT_MS,
      log: (line) => console.error(line),
    }),
  });
  const agent = new BoxAgent({
    hubUrl,
    boxId,
    joinToken,
    tools: {
      root,
      // Commands get the box's own minimal environment, never this process's,
      // which holds the join token (PRD §8.2.1).
      env: { ...DEFAULT_EXEC_ENV, ...(display ? { DISPLAY: display } : {}) },
      browser,
    },
    vnc: { port: vncPort },
  });
  console.log(`${banner}: box ${boxId}, boot ${agent.bootId}, dialing ${hubUrl}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => agent.stop());
  }
  agent.start();
  const exit = await agent.done;
  if (exit.kind === "rejected") {
    console.error(`${banner}: the hub refused this box (${exit.reason}): ${exit.message}`);
    return EXIT_REJECTED;
  }
  return 0;
}

process.exit(await main());
