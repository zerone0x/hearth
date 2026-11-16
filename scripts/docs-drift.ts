/**
 * Docs drift checks (#36), run by `bun run check` through docs-drift.test.ts:
 *
 * - every `HEARTH_*` and `OTEL_*` variable the shipped code reads or sets is a
 *   row of the README's configuration table, the row names a file that really
 *   mentions it, and no `HEARTH_*` row names a variable the repo no longer has;
 * - every row of the "Invariants and tests" table in docs/ARCHITECTURE.md
 *   names a file that exists, and each test name the row cites after a file is
 *   declared in it: `test(`, `it(` or `describe(` (also with a modifier such as
 *   `test.skipIf(…)(` or `test.each(…)(`) at the start of a line, with the
 *   whole name as its first argument, so a substring, a comment or a string
 *   elsewhere does not count.
 *
 * Both checks read source text, so they cannot evaluate code. A test name
 * built from a template literal matches with each `${…}` standing for any
 * non-empty text: the table cites the name the runner prints, such as
 * "/: every directive …" for `${path}: every directive …`. A template whose
 * literal text is shorter than MIN_TEMPLATE_LITERAL characters (such as
 * `${type} ${json}`) is not citable, since it would match almost any name. A name built any
 * other way (a concatenation, a variable) is not found; rename the test to a
 * literal or a template literal. A name spelled out in a comment is not found
 * either, by design.
 */

/** A `HEARTH_*` or `OTEL_*` variable name; a template prefix such as `OTEL_..._${signal}` is not one. */
const CONFIG_VAR = /\b(?:HEARTH|OTEL)_[A-Z0-9_]*[A-Z0-9]\b/g;

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Whether a tracked file is shipped code whose variables the README must list:
 * the apps, packages, scripts and deploy files and the root `.json` files
 * (`package.json` scripts read variables too), but not lockfiles, tests, test data, the
 * e2e harnesses (their variables are documented in their own headers) or docs.
 */
export function isShippedCode(path: string): boolean {
  if (!/^(apps|packages|scripts|deploy)\/|^[^/]+\.json$/.test(path)) return false;
  if (/\.(md|lock)$/.test(path)) return false;
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
 * cell, each `` `path` `` followed by zero or more `"test name"`s. A path with
 * no name is returned with an empty test, so the check still finds the file.
 * A row with no path is returned with an empty file, so the check reports it.
 */
export function invariantRefs(architecture: string): InvariantRef[] {
  const refs: InvariantRef[] = [];
  for (const line of section(architecture, "Invariants and tests")) {
    const row = cells(line);
    if (row === undefined || row[0] === "Promise") continue;
    const promise = row[0] ?? "";
    const guard = row[row.length - 1] ?? "";
    let file = "";
    let named = false;
    const fileOnly = () => {
      if (file !== "" && !named) refs.push({ promise, file, test: "" });
    };
    for (const m of guard.matchAll(/`([^`]+)`|"([^"]+)"/g)) {
      if (m[1] !== undefined) {
        fileOnly();
        file = m[1];
        named = false;
      } else if (file !== "") {
        refs.push({ promise, file, test: m[2] as string });
        named = true;
      }
    }
    fileOnly();
    if (file === "") refs.push({ promise, file: "", test: "" });
  }
  return refs;
}

/**
 * A test declaration that starts a line: `test`, `it` or `describe`, any
 * modifiers (`.skipIf(…)`, `.each(…)`, `.only`), then `(` and a quoted first
 * argument, which may be on the next line. Group 1 is the quote, group 2 the
 * name as written.
 */
const DECLARATION =
  /^[ \t]*(?:test|it|describe)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\))?)*\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/gm;

/** Fewest literal characters a template test name needs to be citable. */
export const MIN_TEMPLATE_LITERAL = 12;

/** `\'` read as `'`: the name the runner prints, not the source spelling. */
const unescaped = (written: string) => written.replace(/\\([\s\S])/g, "$1");

/** Whether a declared name, as written, is `name`: a template literal's `${…}` matches any non-empty text. */
function namesMatch(quote: string, written: string, name: string): boolean {
  if (quote !== "`" || !written.includes("${")) return unescaped(written) === name;
  const parts = written.split(/\$\{[^}]*\}/);
  // A template that is mostly placeholders (`${a} ${b}`) would match almost any
  // name; it cannot be cited. Its literal text must carry the meaning.
  if (parts.join("").trim().length < MIN_TEMPLATE_LITERAL) return false;
  const pattern = parts
    .map((part) => unescaped(part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  return new RegExp(`^${pattern}$`, "s").test(name);
}

/** Whether the source declares a test or group named `name` (see DECLARATION): a name in a comment or a string does not count. */
export function declaresTest(text: string, name: string): boolean {
  for (const m of text.matchAll(DECLARATION)) {
    if (namesMatch(m[1] as string, m[2] as string, name)) return true;
  }
  return false;
}

/** Each reference whose file is missing or does not declare the test name. */
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
    else if (ref.test !== "" && !declaresTest(text, ref.test)) {
      errors.push(`invariant "${ref.promise}": ${ref.file} has no test "${ref.test}"`);
    }
  }
  return errors;
}
