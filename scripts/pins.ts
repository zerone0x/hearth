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
const OVERRIDE_FIELDS = ["overrides", "resolutions"] as const;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface Manifest {
  /** Path shown in error messages. */
  readonly path: string;
  readonly json: Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>> &
    Partial<Record<(typeof OVERRIDE_FIELDS)[number], OverrideMap>>;
}

/** `overrides` / `resolutions` map: values are specs or (npm-style) nested maps. */
export interface OverrideMap {
  readonly [name: string]: string | OverrideMap;
}

interface Target {
  readonly name: string;
  readonly spec: string;
}

/** Resolves an `npm:<name>@<spec>` alias to the package it really installs. */
function resolveAlias(name: string, spec: string): Target {
  if (!spec.startsWith("npm:")) return { name, spec };
  const target = spec.slice("npm:".length);
  const at = target.lastIndexOf("@");
  if (at <= 0) return { name: target, spec: "" };
  return { name: target.slice(0, at), spec: target.slice(at + 1) };
}

/** Package name from an override key such as `pkg`, `pkg@1`, `**\/pkg` or `a/**\/@scope/pkg@1`. */
function overrideKeyName(key: string): string {
  const last = key.split("**/").pop() ?? key;
  const at = last.lastIndexOf("@");
  return at > 0 ? last.slice(0, at) : last;
}

function* flattenOverrides(
  map: OverrideMap,
  prefix: string,
): Generator<{ label: string; name: string; spec: string }> {
  for (const [key, value] of Object.entries(map)) {
    const name = overrideKeyName(key);
    if (typeof value === "string") {
      yield { label: `${prefix}.${key}`, name, spec: value };
    } else {
      for (const inner of flattenOverrides(value, `${prefix}.${key}`)) {
        yield key === "." ? { ...inner, name } : inner;
      }
    }
  }
}

export interface PinReport {
  /** The single pinned pi version, or undefined when no workspace depends on pi. */
  readonly version: string | undefined;
  readonly errors: readonly string[];
}

export function checkPins(manifests: readonly Manifest[], lockfile: string | undefined): PinReport {
  const errors: string[] = [];
  const versions = new Map<string, string[]>();

  const check = (path: string, label: string, key: string, rawSpec: string) => {
    const { name, spec } = resolveAlias(key, rawSpec);
    const aliased = name !== key || rawSpec.startsWith("npm:");
    for (const candidate of aliased ? [key, name] : [name]) {
      if (candidate.startsWith(FORBIDDEN_SCOPE)) {
        errors.push(`${path}: ${label} uses a frozen package name; use ${PI_SCOPE_PREFIX}*`);
        return;
      }
    }
    if (!name.startsWith(PI_SCOPE_PREFIX)) return;
    if (!EXACT_SEMVER.test(spec)) {
      errors.push(`${path}: ${label} is "${rawSpec}"; pi packages need an exact version`);
      return;
    }
    versions.set(spec, [...(versions.get(spec) ?? []), `${path} (${name})`]);
  };

  for (const { path, json } of manifests) {
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(json[field] ?? {})) {
        check(path, `${field}.${name}`, name, spec);
      }
    }
    for (const field of OVERRIDE_FIELDS) {
      for (const o of flattenOverrides(json[field] ?? {}, field)) {
        if (o.spec.startsWith("$")) continue; // reference to a direct dependency
        check(path, o.label, o.name, o.spec);
      }
    }
  }

  if (versions.size > 1) {
    const detail = [...versions].map(([v, where]) => `${v} in ${where.join(", ")}`).join("; ");
    errors.push(`pi packages are pinned to different versions: ${detail}`);
  }
  const version = versions.size === 1 ? [...versions.keys()][0] : undefined;

  if (lockfile === undefined) {
    errors.push("bun.lock: file is missing; run `bun install` and commit it");
  } else {
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
