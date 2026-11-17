/**
 * Command rules for `bash` tool calls, matched after parsing (#69, decision
 * 0044). The parser (bash-parse.ts) gives simple commands; this layer:
 *
 * - strips wrappers that run their argument (`sudo`, `env` with its `VAR=x`,
 *   `timeout`, `nice`, `nohup`, `command`, `exec`, `xargs`, ...) with their
 *   options, so `sudo timeout 5 git push` is `git push`;
 * - re-parses the string of `bash -c` / `sh -c` and the words of `eval`, up to
 *   `MAX_SHELL_DEPTH` levels;
 * - asks when it cannot see what runs: a parse error, a command name that is
 *   not a literal (`$X -rf`), `alias`, `source`, a shell reading a script or a
 *   pipe, nesting deeper than the cap;
 * - matches each command against the rules, by command name and argument
 *   pattern, not by the raw string. The most restrictive result wins:
 *   deny > ask > allow (the order of `@pi-kit/permissions`);
 * - tests the config's raw-pattern deny-list (policy.ts) against the raw
 *   command, as before, and against each parsed command as words joined by
 *   one space, so `bash -c "r""m -rf x"` meets an `rm\s+-rf` rule. When
 *   parsing fails, the raw match is what is left.
 *
 * The result is a verdict. Today only `deny` is enforced (the call is blocked);
 * `ask` runs as before, because the approval gate and its UI are not built yet,
 * and it is recorded in the trajectory step of the call. Not a boundary: the
 * box is (decision 0015). Known gaps: interpreters (`python -c`, `node -e`,
 * `perl -e`), `find -exec`, `trap '<string>'`, git aliases, a script written
 * then run, and network calls that do what a rule forbids.
 */

import { type BashWord, parseBash, type SimpleCommand } from "./bash-parse";
import { type CompiledDenyRule, denied } from "./policy";

export type BashAction = "allow" | "ask" | "deny";

/**
 * One command rule from config. It matches a simple command when every part
 * that is set matches; an unset part matches anything.
 */
export interface CommandRule {
  /** Shown in the verdict and the trajectory, e.g. `git-push`. */
  readonly name: string;
  /** Command names (the basename: `/bin/rm` is `rm`). A trailing `*` matches a prefix: `mkfs*`. */
  readonly command: readonly string[];
  /** The first argument that is not an option, e.g. `push` for `git push`. */
  readonly subcommand?: string;
  /** Options before the subcommand that take the next word as their value (`git -C dir`). */
  readonly optionsWithValue?: readonly string[];
  /**
   * Option groups that must all be present; one option of each group is
   * enough. A one-letter short option also matches inside a cluster: `-r`
   * matches `-rf`. A long option also matches `--opt=value`.
   */
  readonly flags?: readonly (readonly string[])[];
  /** Literal arguments that must all be present, e.g. `777` and `/`. */
  readonly args?: readonly string[];
  /** An earlier stage of the same pipeline runs one of these commands (`curl x | sh`). */
  readonly pipedFrom?: readonly string[];
  readonly action: "ask" | "deny";
  /** Shown to the model when the rule denies. */
  readonly reason?: string;
}

/** git's global options that take a value: `git -C /repo push` is a push. */
const GIT_OPTIONS_WITH_VALUE: readonly string[] = [
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
];

/**
 * The seed list for a new install: what PRD §6.5 calls risky. All `ask`, so
 * today (no approval gate yet) they only record; an owner who wants a hard
 * block sets `action: "deny"` in `runner.config.commandRules`.
 */
export const DEFAULT_COMMAND_RULES: readonly CommandRule[] = [
  {
    name: "rm-recursive-force",
    command: ["rm"],
    flags: [
      ["-r", "-R", "--recursive"],
      ["-f", "--force"],
    ],
    action: "ask",
  },
  {
    name: "git-push",
    command: ["git"],
    subcommand: "push",
    optionsWithValue: GIT_OPTIONS_WITH_VALUE,
    action: "ask",
  },
  {
    name: "git-reset-hard",
    command: ["git"],
    subcommand: "reset",
    optionsWithValue: GIT_OPTIONS_WITH_VALUE,
    flags: [["--hard"]],
    action: "ask",
  },
  {
    name: "download-to-shell",
    command: ["sh", "bash", "zsh", "dash", "ksh"],
    pipedFrom: ["curl", "wget"],
    action: "ask",
  },
  { name: "dd", command: ["dd"], action: "ask" },
  { name: "mkfs", command: ["mkfs", "mkfs.*"], action: "ask" },
  {
    name: "chmod-777-root",
    command: ["chmod"],
    flags: [["-R", "--recursive"]],
    args: ["777", "/"],
    action: "ask",
  },
];

/** Re-parses of `bash -c` / `eval` strings allowed below the top-level command. */
export const MAX_SHELL_DEPTH = 3;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "busybox-sh"]);

/** A wrapper runs the command in its arguments after its own options. */
interface Wrapper {
  /** Options that take the next word as their value. */
  readonly withValue?: readonly string[];
  /** Positional words before the command (`timeout DURATION cmd`). */
  readonly positionals?: number;
  /** `NAME=value` words before the command are environment, not the command. */
  readonly assignments?: boolean;
  /** Options that mean the command is not run, or not knowable: `command -v`, `env -S`. */
  readonly stop?: Readonly<Record<string, "none" | "ask">>;
}

const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  sudo: {
    withValue: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"],
    assignments: true,
    stop: { "-l": "none", "-v": "none", "-k": "none", "-K": "none", "-e": "ask", "-s": "ask" },
  },
  doas: { withValue: ["-u", "-C"] },
  env: {
    withValue: ["-u", "--unset", "-C", "--chdir"],
    assignments: true,
    stop: { "-S": "ask", "--split-string": "ask" },
  },
  timeout: { withValue: ["-s", "--signal", "-k", "--kill-after"], positionals: 1 },
  nice: { withValue: ["-n", "--adjustment"] },
  ionice: { withValue: ["-c", "-n", "-p", "-P", "-u"] },
  nohup: {},
  time: { withValue: ["-f", "--format", "-o", "--output"] },
  stdbuf: { withValue: ["-i", "-o", "-e"] },
  builtin: {},
  command: { stop: { "-v": "none", "-V": "none" } },
  exec: { withValue: ["-a"] },
  xargs: {
    withValue: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter"],
  },
};

/** What the policy decided about one `bash` command. */
export interface BashVerdict {
  readonly action: BashAction;
  /**
   * What decided: a command rule's name, `raw:<n>` for the n-th raw deny rule,
   * `unclear:<why>` when the parser could not see what runs, or `none`.
   */
  readonly rule: string;
  readonly reason: string;
  /** The simple command that decided, as written. */
  readonly command?: string;
}

const RANK: Readonly<Record<BashAction, number>> = { allow: 0, ask: 1, deny: 2 };

const ALLOW: BashVerdict = { action: "allow", rule: "none", reason: "no rule matched" };

/** The stricter of two verdicts; on a tie, the first. */
function stricter(a: BashVerdict, b: BashVerdict): BashVerdict {
  return RANK[b.action] > RANK[a.action] ? b : a;
}

/** Checks the rules once at startup, so a bad rule fails there, not mid-turn. */
export function compileCommandRules(rules: readonly CommandRule[]): readonly CommandRule[] {
  return rules.map((rule, index) => {
    const where = `command rule ${index}`;
    if (typeof rule.name !== "string" || rule.name.length === 0) {
      throw new Error(`${where}: name must be a non-empty string`);
    }
    if (
      !Array.isArray(rule.command) ||
      rule.command.length === 0 ||
      !rule.command.every((c) => typeof c === "string" && c.length > 0)
    ) {
      throw new Error(`${where} (${rule.name}): command must be a non-empty list of names`);
    }
    if (rule.action !== "ask" && rule.action !== "deny") {
      throw new Error(`${where} (${rule.name}): action must be "ask" or "deny"`);
    }
    for (const group of rule.flags ?? []) {
      if (!Array.isArray(group) || group.length === 0) {
        throw new Error(`${where} (${rule.name}): each flags group needs at least one option`);
      }
    }
    return rule;
  });
}

function display(words: readonly BashWord[]): string {
  return words.map((w) => w.value ?? w.text).join(" ");
}

function basename(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

function nameMatches(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));
}

type Match = "yes" | "no" | "unknown";

/** The options (before `--`) and whether a non-literal word could hide one. */
function optionWords(args: readonly BashWord[]): { options: string[]; unknown: boolean } {
  const options: string[] = [];
  let unknown = false;
  for (const word of args) {
    if (word.value === null) {
      unknown = true;
      continue;
    }
    if (word.value === "--") break;
    if (word.value.startsWith("-") && word.value.length > 1) options.push(word.value);
  }
  return { options, unknown };
}

function hasOption(options: readonly string[], option: string): boolean {
  const short = /^-[^-]$/.test(option);
  return options.some((o) => {
    if (o === option) return true;
    if (short) return !o.startsWith("--") && o.slice(1).includes(option.slice(1));
    return option.startsWith("--") && o.startsWith(`${option}=`);
  });
}

/** The first argument that is not an option, skipping option values. */
function subcommandOf(args: readonly BashWord[], withValue: ReadonlySet<string>): Match | string {
  for (let i = 0; i < args.length; i++) {
    const value = args[i]?.value;
    if (value === null || value === undefined) return "unknown";
    if (value === "--") {
      const next = args[i + 1];
      if (next === undefined) return "no";
      return next.value ?? "unknown";
    }
    if (value.startsWith("-") && value.length > 1) {
      if (withValue.has(value)) i++;
      continue;
    }
    return value;
  }
  return "no";
}

function ruleMatches(rule: CommandRule, command: SimpleCommand, name: string): Match {
  if (!nameMatches(rule.command, name)) return "no";
  const args = command.words.slice(1);
  const results: Match[] = [];
  if (rule.subcommand !== undefined) {
    const sub = subcommandOf(args, new Set(rule.optionsWithValue ?? []));
    results.push(sub === "unknown" ? "unknown" : sub === rule.subcommand ? "yes" : "no");
  }
  if (rule.flags !== undefined) {
    const { options, unknown } = optionWords(args);
    const all = rule.flags.every((group) => group.some((option) => hasOption(options, option)));
    results.push(all ? "yes" : unknown ? "unknown" : "no");
  }
  if (rule.args !== undefined) {
    const literal = new Set(args.map((w) => w.value).filter((v): v is string => v !== null));
    const all = rule.args.every((a) => literal.has(a));
    results.push(all ? "yes" : args.some((w) => w.value === null) ? "unknown" : "no");
  }
  if (rule.pipedFrom !== undefined) {
    const from = rule.pipedFrom;
    const piped = command.upstream.some((stage) => {
      const inner = unwrap(stage);
      const n = inner.words[0]?.value;
      return n !== null && n !== undefined && nameMatches(from, basename(n));
    });
    results.push(piped ? "yes" : "no");
  }
  if (results.includes("no")) return "no";
  return results.includes("unknown") ? "unknown" : "yes";
}

interface Unwrapped {
  readonly words: readonly BashWord[];
  /** Set when a wrapper option means nothing runs (`command -v`) or it cannot be known. */
  readonly stop?: "none" | "ask";
  readonly reason?: string;
}

/** Strips wrappers until the command that runs; `VAR=x` words of `env`/`sudo` too. */
function unwrap(words: readonly BashWord[]): Unwrapped {
  let rest = words;
  for (;;) {
    const head = rest[0]?.value;
    if (head === null || head === undefined) return { words: rest };
    const wrapper = WRAPPERS[basename(head)];
    if (wrapper === undefined) return { words: rest };
    const withValue = new Set(wrapper.withValue ?? []);
    let i = 1;
    let positionals = wrapper.positionals ?? 0;
    for (; i < rest.length; i++) {
      const value = rest[i]?.value;
      if (value === null || value === undefined) break;
      if (value === "--") {
        i++;
        break;
      }
      if (value.startsWith("-") && value.length > 1) {
        const stop = wrapper.stop?.[value];
        if (stop !== undefined) return { words: rest, stop, reason: `${head} ${value}` };
        if (withValue.has(value)) i++;
        continue;
      }
      if (wrapper.assignments === true && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) continue;
      if (positionals > 0) {
        positionals--;
        continue;
      }
      break;
    }
    if (i >= rest.length) {
      // `xargs` alone runs `echo`; `env` alone prints; `nohup` alone fails.
      return { words: rest, stop: "none" };
    }
    rest = rest.slice(i);
  }
}

/** The index of the `-c` script operand of a shell, or -1. */
function shellScriptIndex(args: readonly BashWord[]): number | "unknown" {
  let sawC = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i]?.value;
    if (value === null || value === undefined) return sawC ? i : "unknown";
    if (value === "--" || value === "-") {
      return sawC ? i + 1 : -1;
    }
    if (value.startsWith("-") && !value.startsWith("--") && value.length > 1) {
      if (value.slice(1).includes("c")) sawC = true;
      // `-o opt` / `-O opt` take a value.
      if (/^-[^-]*[oO]$/.test(value)) i++;
      continue;
    }
    if (value.startsWith("+") || value.startsWith("--")) continue;
    return sawC ? i : -1;
  }
  return sawC ? args.length : -1;
}

interface Context {
  readonly rules: readonly CommandRule[];
  readonly raw: readonly CompiledDenyRule[];
  readonly depth: number;
}

function unclear(why: string, reason: string, command?: string): BashVerdict {
  return {
    action: "ask",
    rule: `unclear:${why}`,
    reason,
    ...(command === undefined ? {} : { command }),
  };
}

function judgeScript(source: string, ctx: Context): BashVerdict {
  const parsed = parseBash(source);
  let verdict = ALLOW;
  if (parsed.errors.length > 0) {
    verdict = unclear("parse-error", `the command did not parse: ${parsed.errors[0]}`);
  }
  for (const command of parsed.commands) {
    verdict = stricter(verdict, judgeCommand(command, ctx));
  }
  return verdict;
}

function rawDeny(words: readonly BashWord[], ctx: Context): BashVerdict | undefined {
  const text = display(words);
  const rule = denied(ctx.raw, "bash", { command: text });
  if (rule === undefined) return undefined;
  return {
    action: "deny",
    rule: `raw:${ctx.raw.indexOf(rule)}`,
    reason: rule.reason,
    command: text,
  };
}

function judgeCommand(command: SimpleCommand, ctx: Context): BashVerdict {
  // The command as written, before unwrapping, also meets the raw patterns.
  let verdict = rawDeny(command.words, ctx) ?? ALLOW;
  const inner = unwrap(command.words);
  const words = inner.words;
  const shown = display(words);
  if (inner.stop === "none") return verdict;
  if (inner.stop === "ask") {
    return stricter(verdict, unclear("wrapper", `cannot see what ${inner.reason} runs`, shown));
  }
  verdict = stricter(verdict, rawDeny(words, ctx) ?? ALLOW);
  const head = words[0]?.value;
  if (head === null || head === undefined) {
    return stricter(verdict, unclear("name", "the command name is not a literal", shown));
  }
  const name = basename(head);
  const unwrapped: SimpleCommand = { words, upstream: command.upstream };
  for (const rule of ctx.rules) {
    const match = ruleMatches(rule, unwrapped, name);
    if (match === "no") continue;
    const action: BashAction = match === "yes" ? rule.action : "ask";
    verdict = stricter(verdict, {
      action,
      rule: rule.name,
      reason:
        match === "yes"
          ? (rule.reason ?? `blocked by the hub's command rule ${rule.name}: ${shown}`)
          : `cannot tell whether ${shown} matches rule ${rule.name}`,
      command: shown,
    });
  }
  const args = words.slice(1);
  if (name === "alias") {
    return stricter(verdict, unclear("alias", "an alias can rename any command", shown));
  }
  if (name === "source" || name === ".") {
    return stricter(verdict, unclear("script", "runs a script the parser cannot see", shown));
  }
  if (name === "eval") {
    if (args.some((w) => w.value === null)) {
      return stricter(verdict, unclear("eval", "eval of a string that is not a literal", shown));
    }
    return stricter(verdict, nested(args.map((w) => w.value as string).join(" "), ctx, shown));
  }
  if (SHELLS.has(name)) {
    const index = shellScriptIndex(args);
    if (index === "unknown") {
      return stricter(verdict, unclear("shell", "a shell option is not a literal", shown));
    }
    if (index === -1) {
      const reads = args.some((w) => w.value !== null && !w.value.startsWith("-"));
      if (reads || command.upstream.length > 0) {
        return stricter(
          verdict,
          unclear("script", "a shell runs a script the parser cannot see", shown),
        );
      }
      return verdict;
    }
    const script = args[index];
    if (script === undefined)
      return stricter(verdict, unclear("shell", "-c without a script", shown));
    if (script.value === null) {
      return stricter(verdict, unclear("shell", "the -c script is not a literal", shown));
    }
    return stricter(verdict, nested(script.value, ctx, shown));
  }
  return verdict;
}

function nested(source: string, ctx: Context, shown: string): BashVerdict {
  if (ctx.depth + 1 > MAX_SHELL_DEPTH) {
    return unclear("depth", `shell nesting deeper than ${MAX_SHELL_DEPTH}`, shown);
  }
  return judgeScript(source, { ...ctx, depth: ctx.depth + 1 });
}

/**
 * The verdict for one `bash` command: `rules` are the compiled command rules,
 * `raw` the config's raw-pattern deny-list (only its `bash` and `*` rules apply).
 */
export function classifyBash(
  command: string,
  rules: readonly CommandRule[],
  raw: readonly CompiledDenyRule[] = [],
): BashVerdict {
  const ctx: Context = { rules, raw, depth: 0 };
  // The raw string first, as before #69: it is the fallback when parsing fails.
  const whole = denied(raw, "bash", { command });
  if (whole !== undefined) {
    return { action: "deny", rule: `raw:${raw.indexOf(whole)}`, reason: whole.reason };
  }
  return judgeScript(command, ctx);
}
