/**
 * The hub's version, stamped on every trajectory record and span (decision
 * 0021), so two builds can be told apart:
 *
 * 1. `HEARTH_VERSION`, set at build time (the hub image takes it as a build
 *    argument, `deploy/hub.Dockerfile`);
 * 2. else `apps/hub/package.json`'s version plus the git commit of the
 *    checkout it runs from (`0.0.0+g1a2b3c4d5e6f`);
 * 3. else the package version alone.
 */

import pkg from "../../package.json" with { type: "json" };

export function hubVersion(
  env: Readonly<Record<string, string | undefined>>,
  pkgVersion: string,
  gitSha: () => string | undefined,
): string {
  const fromEnv = env["HEARTH_VERSION"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  const sha = gitSha();
  if (sha !== undefined && sha !== "") return `${pkgVersion}+g${sha}`;
  return pkgVersion;
}

/** The short commit of the git checkout `dir` is in; undefined outside one or without git. */
export function gitShaOf(dir: string): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    const sha = r.stdout.toString().trim();
    return r.success && /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export const HUB_VERSION: string = hubVersion(process.env, pkg.version, () =>
  gitShaOf(import.meta.dir),
);
