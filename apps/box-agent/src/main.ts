import { createDefaultSecretStore, HearthError } from "@hearth/core";
import { describeBoxAgent } from "./agent";
import { BoxAgent } from "./connection";

/** Exit code when the boot environment is incomplete. */
const EXIT_CONFIG = 2;
/** Exit code when the hub refused the box for good (a `reject` retrying cannot fix). */
const EXIT_REJECTED = 3;

/** Boot environment the hub passes through `BoxProvider.start` (see the hub's `BOX_ENV`). */
const HUB_URL_VAR = "HEARTH_HUB_URL";
const BOX_ID_VAR = "HEARTH_BOX_ID";
/** The join token is a secret, so it is read through the SecretStore, not `process.env`. */
const JOIN_TOKEN_REF = "env:HEARTH_JOIN_TOKEN";

const info = describeBoxAgent();
const banner = `hearth box-agent (protocol ${info.protocol}, pi ${info.pi})`;

async function main(): Promise<number> {
  const hubUrl = process.env[HUB_URL_VAR];
  const boxId = process.env[BOX_ID_VAR];
  if (!hubUrl || !boxId) {
    console.error(`${banner}: ${HUB_URL_VAR} and ${BOX_ID_VAR} must be set`);
    return EXIT_CONFIG;
  }
  let joinToken: string;
  try {
    joinToken = (await createDefaultSecretStore().resolve(JOIN_TOKEN_REF)).reveal();
  } catch (error) {
    const reason = error instanceof HearthError ? error.message : String(error);
    console.error(`${banner}: no join token: ${reason}`);
    return EXIT_CONFIG;
  }

  const agent = new BoxAgent({ hubUrl, boxId, joinToken });
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
