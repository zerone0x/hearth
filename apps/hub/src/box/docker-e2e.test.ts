/**
 * The M0 exit criterion through the real box image (#7): the hub creates a box
 * with `DockerBoxProvider`, the box dials in, and `echo` comes back.
 *
 * Runs only with `HEARTH_DOCKER_TESTS=1` (AGENTS.md, gates). The round trip is
 * written against the `BoxProvider` interface in `connection.test.ts`
 * ("a box launched through a BoxProvider dials in with its boot env"); this file
 * runs the same steps with the Docker provider once it lands (#6, PR #19).
 */

import { describe, test } from "bun:test";

const dockerTests = process.env["HEARTH_DOCKER_TESTS"] === "1";

describe.skipIf(!dockerTests)("echo through DockerBoxProvider and the box image", () => {
  test.todo("hub launches the box, the box dials in, echo round trip (pending PR #19)");
});
