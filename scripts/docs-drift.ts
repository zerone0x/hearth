/**
 * Docs drift checks (#36), run by `bun run check` through docs-drift.test.ts:
 *
 * - every `HEARTH_*` and `OTEL_*` variable the shipped code reads or sets is a
 *   row of the README's configuration table, the row names a file that really
 *   mentions it, and no `HEARTH_*` row names a variable the repo no longer has;
 * - every row of the "Invariants and tests" table in docs/ARCHITECTURE.md
 *   names a test file that exists and a test name that is in it.
 */

/** A configuration variable name: `HEARTH_X` or `OTEL_X`, not a `HEARTH_${...}` template prefix. */
const CONFIG_VAR = /\b(?:HEARTH|OTEL)_[A-Z0-9_]*[A-Z0-9]\b/g;

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Whether a tracked file is shipped code whose variables the README must list:
 * the apps, packages, scripts and deploy files, but not tests, test data, the
 * e2e harnesses (their variables are documented in their own headers) or docs.
 */
export function isShippedCode(path: string): boolean {
  if (!/^(apps|packages|scripts|deploy)\//.test(path)) return false;
  if (/\.(md|lock|json)$/.test(path)) return false;
  if (/\.test\.tsx?$/.test(path) || /\.dom\.tsx$/.test(path)) return false;
  if (/(^|\/)(testdata|e2e)\//.test(path)) return false;
  return true;
}

/** Every configuration variable in the files, with the files that mention it. */
export function configVars(files: readonly SourceFile[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    for (const name of new Set(file.text.match(CONFIG_VAR) ?? [])) {
      const paths = found.get(name) ?? [];
      paths.push(file.path);
      found.set(name, paths);
    }
  }
  return found;
}

/** The lines of a `## <heading>` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The cells of a markdown table row, or undefined for a non-row or a separator. */
function cells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || /^\|[\s:|-]+\|$/.test(trimmed)) return undefined;
  return trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

/** Backticked spans of a cell. */
function ticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

export interface ConfigRow {
  /** The variables of the row's first cell. */
  readonly vars: readonly string[];
  /** The backticked paths of the row's "Read by" (third) cell. */
  readonly files: readonly string[];
}

/** The rows of the README's `## Configuration` tables. */
export function readmeConfigRows(readme: string): ConfigRow[] {
  const rows: ConfigRow[] = [];
  for (const line of section(readme, "Configuration")) {
    const row = cells(line);
    if (row === undefined) continue;
    const vars = ticked(row[0] ?? "").filter((v) => /^(HEARTH|OTEL)_[A-Z0-9_]+$/.test(v));
    if (vars.length === 0) continue;
    rows.push({ vars, files: ticked(row[2] ?? "") });
  }
  return rows;
}

/**
 * Drift between the code and the README table, as messages (empty: none).
 * `shipped` is the shipped code; `everywhere` is every tracked file but the
 * README and docs, so a variable only tests or CI use is not stale.
 */
export function configDrift(
  rows: readonly ConfigRow[],
  shipped: readonly SourceFile[],
  everywhere: readonly SourceFile[],
): string[] {
  const errors: string[] = [];
  const documented = new Set(rows.flatMap((row) => row.vars));
  for (const [name, paths] of configVars(shipped)) {
    if (!documented.has(name)) {
      errors.push(`${name} (${paths.join(", ")}) is not in the README configuration table`);
    }
  }
  const anywhere = configVars(everywhere);
  const byPath = new Map(everywhere.map((file) => [file.path, file.text]));
  for (const row of rows) {
    if (row.files.length === 0) {
      errors.push(`README row ${row.vars.join(", ")} names no file that reads it`);
    }
    for (const name of row.vars) {
      if (name.startsWith("HEARTH_") && !anywhere.has(name)) {
        errors.push(`${name} is in the README configuration table but nowhere in the repo`);
      }
      for (const path of row.files) {
        const text = byPath.get(path);
        if (text === undefined) errors.push(`README row ${name}: no file ${path}`);
        else if (!new RegExp(`\\b${name}\\b`).test(text)) {
          errors.push(`README row ${name}: ${path} does not mention it`);
        }
      }
    }
  }
  return errors;
}

export interface InvariantRef {
  readonly promise: string;
  readonly file: string;
  readonly test: string;
}

/**
 * The test references of the `## Invariants and tests` table: in its last
 * cell, each `` `path` `` followed by one or more `"test name"`s. A row with
 * none is returned with an empty file, so the check reports it.
 */
export function invariantRefs(architecture: string): InvariantRef[] {
  const refs: InvariantRef[] = [];
  for (const line of section(architecture, "Invariants and tests")) {
    const row = cells(line);
    if (row === undefined || row[0] === "Promise") continue;
    const promise = row[0] ?? "";
    const guard = row[row.length - 1] ?? "";
    let file = "";
    let found = false;
    for (const m of guard.matchAll(/`([^`]+)`|"([^"]+)"/g)) {
      if (m[1] !== undefined) file = m[1];
      else if (file !== "") {
        refs.push({ promise, file, test: m[2] as string });
        found = true;
      }
    }
    if (!found) refs.push({ promise, file: "", test: "" });
  }
  return refs;
}

/** Each reference whose file is missing or does not contain the test name. */
export function invariantDrift(
  refs: readonly InvariantRef[],
  read: (path: string) => string | undefined,
): string[] {
  const errors: string[] = [];
  if (refs.length === 0) errors.push("docs/ARCHITECTURE.md has no invariants table");
  for (const ref of refs) {
    if (ref.file === "") {
      errors.push(`invariant "${ref.promise}" names no test`);
      continue;
    }
    const text = read(ref.file);
    if (text === undefined) errors.push(`invariant "${ref.promise}": no file ${ref.file}`);
    else if (!text.includes(ref.test)) {
      errors.push(`invariant "${ref.promise}": ${ref.file} has no test "${ref.test}"`);
    }
  }
  return errors;
}
