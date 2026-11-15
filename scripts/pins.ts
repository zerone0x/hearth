/**
 * pi version policy (PRD §8.4, AGENTS.md):
 * - only `@earendil-works/pi-*` packages, never the frozen `@mariozechner/*` names;
 * - every `@earendil-works/pi-*` dependency pinned to one exact version, the same
 *   across all workspaces and in the lockfile.
 */

export const PI_SCOPE_PREFIX = "@earendil-works/pi-";
export const FORBIDDEN_SCOPE = "@mariozechner/";
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface Manifest {
  /** Path shown in error messages. */
  readonly path: string;
  readonly json: Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>;
}

export interface PinReport {
  /** The single pinned pi version, or undefined when no workspace depends on pi. */
  readonly version: string | undefined;
  readonly errors: readonly string[];
}

export function checkPins(manifests: readonly Manifest[], lockfile: string | undefined): PinReport {
  const errors: string[] = [];
  const versions = new Map<string, string[]>();

  for (const { path, json } of manifests) {
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(json[field] ?? {})) {
        if (name.startsWith(FORBIDDEN_SCOPE)) {
          errors.push(
            `${path}: ${field}.${name} uses a frozen package name; use ${PI_SCOPE_PREFIX}*`,
          );
          continue;
        }
        if (!name.startsWith(PI_SCOPE_PREFIX)) continue;
        if (!EXACT_SEMVER.test(spec)) {
          errors.push(`${path}: ${field}.${name} is "${spec}"; pi packages need an exact version`);
          continue;
        }
        const where = `${path} (${name})`;
        versions.set(spec, [...(versions.get(spec) ?? []), where]);
      }
    }
  }

  if (versions.size > 1) {
    const detail = [...versions].map(([v, where]) => `${v} in ${where.join(", ")}`).join("; ");
    errors.push(`pi packages are pinned to different versions: ${detail}`);
  }
  const version = versions.size === 1 ? [...versions.keys()][0] : undefined;

  if (lockfile !== undefined) {
    if (lockfile.includes(`"${FORBIDDEN_SCOPE}`)) {
      errors.push(`bun.lock: contains a ${FORBIDDEN_SCOPE}* package`);
    }
    if (version !== undefined) {
      const resolved = new RegExp(`"(${escapeRegExp(PI_SCOPE_PREFIX)}[a-z0-9-]+)@([^"]+)"`, "g");
      for (const [, name, locked] of lockfile.matchAll(resolved)) {
        if (locked !== version) {
          errors.push(`bun.lock: ${name} resolves to ${locked}, expected ${version}`);
        }
      }
    }
  }

  return { version, errors };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
