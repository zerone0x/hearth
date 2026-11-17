/**
 * Structured logs (decision 0021): one JSON object per line, with `ts`, `level`,
 * `component`, `msg` and the ids in scope (`session_id`, `turn_id`, `trace_id`,
 * …). The hub and box-agent both use it.
 *
 * Secrets are redacted **at the sink**: the whole serialized line goes through
 * the logger's redactor just before it is written, so a secret in any field,
 * message or error text is caught, whoever built the line.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field values a log line may carry; anything else is stringified. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface LoggerOptions {
  readonly component: string;
  /** Where finished lines go. Defaults to stderr. */
  readonly sink?: (line: string) => void;
  /** Applied to the whole serialized line before the sink (secret redaction). */
  readonly redact?: (line: string) => string;
  /** Lines below this level are dropped. Defaults to `info`. */
  readonly level?: LogLevel;
  readonly now?: () => number;
}

export const LOG_REDACTED = "[redacted]";

/**
 * Credential shapes redacted from every line even when the hub never saw the
 * value (a key echoed by a provider, a header copied into an error): bearer
 * tokens, `sk-`-style API keys, and `token=`/`password=`/`key=` pairs.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"'&,}]{6,}/gi,
];

/**
 * The text forms in which `secret` is matched: raw, JSON-escaped (inside a
 * JSON string), and URL-encoded three ways: `encodeURIComponent`, the
 * form-urlencoded form a GET form submit puts in a URL (`+` for a space, as
 * `URLSearchParams` writes it), and `encodeURI`. A form that equals one
 * already listed is left out, so a plain `abc123` has one form. A value no
 * encoder takes (a lone surrogate) keeps its other forms.
 */
export function secretForms(secret: string): string[] {
  const forms = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)]);
  let component: string;
  try {
    component = encodeURIComponent(secret);
  } catch {
    // URIError: a lone surrogate has no URL-encoded form.
    return [...forms];
  }
  forms.add(component);
  forms.add(new URLSearchParams({ v: secret }).toString().slice(2));
  forms.add(encodeURI(secret));
  return [...forms];
}

/**
 * A global regex that finds `form`, with each `%XX` escape matched in either
 * case of its hex digits (`%2f` and `%2F`); every other character is literal.
 */
function formPattern(form: string): RegExp {
  let source = "";
  for (const part of form.split(/(%[0-9A-Fa-f]{2})/)) {
    if (/^%[0-9A-Fa-f]{2}$/.test(part)) {
      source += `%${hexClass(part.charAt(1))}${hexClass(part.charAt(2))}`;
    } else {
      source += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(source, "g");
}

function hexClass(digit: string): string {
  const lower = digit.toLowerCase();
  const upper = digit.toUpperCase();
  return lower === upper ? digit : `[${lower}${upper}]`;
}

/**
 * `text` with every occurrence of every value, in each of its forms
 * (`secretForms`: raw, JSON-escaped, URL-encoded), replaced by `mask`. All
 * occurrences of all values are found in the original text first, and each
 * run of overlapping or touching matches becomes one `mask`. Replacing value
 * by value would let one value cut another: with a username `admin` replaced
 * before the password `admin-pw-tail`, the tail `-pw-tail` would stay. The
 * order of `secrets` does not matter.
 */
export function redactValues(
  text: string,
  secrets: Iterable<string>,
  mask: string = LOG_REDACTED,
): string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const form of secretForms(secret)) needles.add(form);
  }
  const spans: Array<readonly [number, number]> = [];
  for (const needle of needles) {
    if (!needle.includes("%")) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        spans.push([at, at + needle.length]);
      }
      continue;
    }
    const pattern = formPattern(needle);
    for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
      spans.push([found.index, found.index + found[0].length]);
      pattern.lastIndex = found.index + 1;
    }
  }
  const first = spans.sort((a, b) => a[0] - b[0])[0];
  if (first === undefined) return text;
  let out = "";
  let written = 0;
  let [start, end] = first;
  for (const [from, to] of spans) {
    if (from > end) {
      out += text.slice(written, start) + mask;
      written = end;
      start = from;
      end = to;
    } else {
      end = Math.max(end, to);
    }
  }
  return out + text.slice(written, start) + mask + text.slice(end);
}

/** Replace every known secret value, in each of its forms (`secretForms`), and every credential shape. */
export function redactLine(line: string, secrets: Iterable<string> = []): string {
  let out = redactValues(line, secrets);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_m, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}${LOG_REDACTED}` : LOG_REDACTED,
    );
  }
  return out;
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      error: error.message,
      ...(typeof code === "string" ? { error_code: code } : {}),
    };
  }
  return { error: String(error) };
}

export class Logger {
  readonly #o: LoggerOptions;
  readonly #fields: LogFields;

  constructor(options: LoggerOptions, fields: LogFields = {}) {
    this.#o = options;
    this.#fields = fields;
  }

  /** A logger for the same sink with more fields (ids) on every line. */
  child(fields: LogFields, component?: string): Logger {
    return new Logger(component === undefined ? this.#o : { ...this.#o, component }, {
      ...this.#fields,
      ...fields,
    });
  }

  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }

  /** `error` may be an `Error` (its message and `code` become fields). */
  error(msg: string, fields?: LogFields, error?: unknown): void {
    this.write("error", msg, error === undefined ? fields : { ...fields, ...errorFields(error) });
  }

  /** A `(line) => void` for code that takes a plain log callback. */
  lines(level: LogLevel = "info"): (line: string) => void {
    return (line) => this.write(level, line);
  }

  write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[this.#o.level ?? "info"]) return;
    const record = {
      ts: new Date((this.#o.now ?? Date.now)()).toISOString(),
      level,
      component: this.#o.component,
      msg,
      ...this.#fields,
      ...fields,
    };
    let line: string;
    try {
      line = JSON.stringify(record, (_k, v: unknown) =>
        typeof v === "bigint" ? String(v) : v instanceof Error ? v.message : v,
      );
    } catch {
      line = JSON.stringify({ ts: record.ts, level, component: this.#o.component, msg });
    }
    const redacted = (this.#o.redact ?? ((l: string) => redactLine(l)))(line);
    (this.#o.sink ?? ((l: string) => process.stderr.write(`${l}\n`)))(redacted);
  }
}

/** Parse `HEARTH_LOG_LEVEL`; undefined or empty means `info`. */
export function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw === "") return "info";
  if (raw in LEVELS) return raw as LogLevel;
  throw new Error(`HEARTH_LOG_LEVEL must be debug, info, warn or error, got "${raw}"`);
}
