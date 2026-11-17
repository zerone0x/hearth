/**
 * Command rules for `bash` tool calls, matched after parsing (#69, decision
 * 0044). The parser (bash-parse.ts) gives simple commands; this layer:
 *
 * - strips wrappers that run their argument (`sudo`, `env` with its `VAR=x`,
 *   `timeout`, `nice`, `nohup`, `command`, `exec`, `xargs`, `setsid`, ...)
 *   with their options, read like getopt, so `sudo -u root timeout 5 git
 *   push` is `git push`;
 * - re-parses the string of `bash -c` / `sh -c`, `su -c`, `script -c`, the
 *   words of `eval` and `watch`, up to `MAX_SHELL_DEPTH` levels;
 * - asks when it cannot see what runs: a parse error, a command name that is
 *   not a literal (`$X -rf`), `alias`, `source`, a shell reading a script, a
 *   pipe, a stdin redirect or here-string, nesting deeper than the cap, or
 *   more work than `MAX_POLICY_STEPS`;
 * - matches each command against the rules, by command name and argument
 *   pattern, not by the raw string. The most restrictive result wins:
 *   deny > ask > allow (the order of `@pi-kit/permissions`);
 * - tests the config's raw-pattern deny-list (policy.ts) against the raw
 *   command, as before, and against each parsed command as words joined by
 *   one space, so `bash -c "r""m -rf x"` meets an `rm\s+-rf` rule. When
 *   parsing fails or the budget runs out, the raw match is what is left.
 *
 * The result is a verdict. Today only `deny` is enforced (the call is blocked);
 * `ask` runs as before, because the approval gate and its UI are not built yet,
 * and it is recorded in the trajectory step of the call. Not a boundary: the
 * box is (decision 0015). Known gaps are listed in decision 0044:
 * interpreters (`python -c`), `find -exec`, `trap '<string>'`, env variables
 * that run code, git aliases in the box's config, a script written then run,
 * wrappers not in the table, and network calls that do what a rule forbids.
 */

import {
  type BashWord,
  type Budget,
  type ParsedBash,
  parseBash,
  type SimpleCommand,
  type StdinSource,
} from "./bash-parse";
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

/**
 * The work one classification may do, in steps (a character parsed, a
 * nested script's characters parsed again, a syntax node walked, a word
 * checked, a command looked at for a pipe). Past it the verdict is `ask`
 * (`unclear:budget`): the hub's tool_call handler is synchronous. The worst
 * 64 KiB shapes known take under half of it, and under 300 ms.
 */
export const MAX_POLICY_STEPS = 1_000_000;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "busybox-sh"]);

/**
 * A wrapper runs the command in its arguments after its own options. Options
 * are read the way getopt does: a short cluster (`-iS'x'`: `-i`, then `-S`
 * with `x`), a long option or an unambiguous prefix of one (`--us root` is
 * `--user root`), `--opt=value`, `--` to end them. A long option the table
 * does not know asks.
 */
interface Wrapper {
  /** One-letter options that take a value: the rest of the cluster, or the next word. */
  readonly shortValue?: string;
  /** One-letter options whose value can only be attached (`xargs -e[EOF]`). */
  readonly shortOptional?: string;
  /** Long options with no value, or an optional one after `=`. */
  readonly long?: readonly string[];
  /** Long options that take a value: after `=`, or the next word. */
  readonly longValue?: readonly string[];
  /**
   * Options that mean the command is not run (`none`), not knowable (`ask`),
   * or run by a shell as one string (`shell`: `sudo -s git push` runs
   * `$SHELL -c 'git push'`; with no command, a shell that reads stdin).
   */
  readonly stop?: Readonly<Record<string, "none" | "ask" | "shell">>;
  /** Options whose value is a shell string, parsed again (`su -c`, `flock -c`). */
  readonly script?: readonly string[];
  /** Positional words before the command (`timeout DURATION cmd`). */
  readonly positionals?: number;
  /** `NAME=value` words before the command are environment, not the command. */
  readonly assignments?: boolean;
  /**
   * What the words after the options are: the command (default), files
   * (`script`), or one user name (`su`); with `files` and `user` options
   * still count after them.
   */
  readonly operands?: "command" | "files" | "user";
  /** Without a command it runs a shell, which reads stdin (`su`, `chroot DIR`). */
  readonly shellWhenEmpty?: boolean;
  /** The words after the options are joined and run by `sh -c` (`watch`). */
  readonly joinRest?: boolean;
  /** Appends words read from stdin to the command (`xargs`). */
  readonly stdinArgs?: boolean;
  /** What it runs cannot be read from its words (`parallel`): ask. */
  readonly opaque?: boolean;
  /** A lone `-` is an option (`env -` is `env -i`). */
  readonly dashOption?: boolean;
}

const HELP = { "--help": "none", "--version": "none" } as const;

const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  sudo: {
    shortValue: "CDghpRrtTUu",
    long: [
      "--askpass",
      "--background",
      "--bell",
      "--preserve-env",
      "--set-home",
      "--reset-timestamp",
      "--non-interactive",
      "--preserve-groups",
      "--stdin",
    ],
    longValue: [
      "--close-from",
      "--chdir",
      "--group",
      "--host",
      "--prompt",
      "--chroot",
      "--role",
      "--type",
      "--command-timeout",
      "--other-user",
      "--user",
    ],
    assignments: true,
    stop: {
      ...HELP,
      "-l": "none",
      "--list": "none",
      "-v": "none",
      "--validate": "none",
      "-K": "none",
      "--remove-timestamp": "none",
      "-V": "none",
      "-e": "ask",
      "--edit": "ask",
      "-s": "shell",
      "--shell": "shell",
      "-i": "shell",
      "--login": "shell",
    },
  },
  doas: { shortValue: "uC", stop: { "-s": "shell", "-L": "none" } },
  env: {
    shortValue: "uCa",
    long: [
      "--ignore-environment",
      "--null",
      "--debug",
      "--block-signal",
      "--default-signal",
      "--ignore-signal",
      "--list-signal-handling",
    ],
    longValue: ["--unset", "--chdir", "--argv0"],
    assignments: true,
    stop: { ...HELP, "-S": "ask", "--split-string": "ask" },
    dashOption: true,
  },
  timeout: {
    shortValue: "sk",
    long: ["--foreground", "--preserve-status", "--verbose"],
    longValue: ["--signal", "--kill-after"],
    stop: HELP,
    positionals: 1,
  },
  nice: { shortValue: "n", longValue: ["--adjustment"], stop: HELP },
  ionice: {
    shortValue: "cnpPu",
    long: ["--ignore"],
    longValue: ["--class", "--classdata", "--pid", "--pgid", "--uid"],
    stop: HELP,
  },
  nohup: { stop: HELP },
  time: {
    shortValue: "fo",
    long: ["--append", "--portability", "--verbose", "--quiet"],
    longValue: ["--format", "--output"],
    stop: HELP,
  },
  stdbuf: { shortValue: "ioe", longValue: ["--input", "--output", "--error"], stop: HELP },
  builtin: {},
  command: { stop: { "-v": "none", "-V": "none" } },
  exec: { shortValue: "a" },
  xargs: {
    shortValue: "adEILnPs",
    shortOptional: "eil",
    long: [
      "--null",
      "--interactive",
      "--no-run-if-empty",
      "--open-tty",
      "--exit",
      "--verbose",
      "--show-limits",
      "--eof",
      "--replace",
      "--max-lines",
    ],
    longValue: [
      "--arg-file",
      "--delimiter",
      "--max-args",
      "--max-chars",
      "--max-procs",
      "--process-slot-var",
    ],
    stop: HELP,
    stdinArgs: true,
  },
  setsid: { long: ["--ctty", "--fork", "--wait"], stop: HELP },
  chroot: {
    long: ["--skip-chdir"],
    longValue: ["--userspec", "--groups"],
    stop: HELP,
    positionals: 1,
    shellWhenEmpty: true,
  },
  flock: {
    shortValue: "wE",
    long: [
      "--shared",
      "--exclusive",
      "--unlock",
      "--nonblock",
      "--nb",
      "--close",
      "--no-fork",
      "--verbose",
    ],
    longValue: ["--timeout", "--wait", "--conflict-exit-code"],
    script: ["-c", "--command"],
    stop: HELP,
    positionals: 1,
  },
  taskset: {
    long: ["--all-tasks", "--cpu-list"],
    stop: { ...HELP, "-p": "none", "--pid": "none" },
    positionals: 1,
  },
  strace: {
    shortValue: "abeEIoOpPsSuUX",
    long: [
      "--follow-forks",
      "--output-separately",
      "--summary-only",
      "--summary",
      "--no-abbrev",
      "--verbose",
      "--quiet",
      "--silent",
      "--decode-fds",
      "--decode-pids",
      "--absolute-timestamps",
      "--relative-timestamps",
      "--syscall-times",
      "--instruction-pointer",
      "--stack-trace",
      "--seccomp-bpf",
      "--daemonize",
      "--debug",
      "--timestamps",
    ],
    longValue: [
      "--attach",
      "--output",
      "--expr",
      "--trace",
      "--trace-path",
      "--trace-fds",
      "--signal",
      "--status",
      "--string-limit",
      "--summary-sort-by",
      "--summary-columns",
      "--user",
      "--env",
      "--columns",
      "--const-print-style",
      "--abbrev",
      "--raw",
      "--read",
      "--write",
      "--inject",
      "--fault",
      "--detach-on",
    ],
    stop: HELP,
  },
  watch: {
    shortValue: "nq",
    long: [
      "--beep",
      "--color",
      "--no-color",
      "--differences",
      "--errexit",
      "--chgexit",
      "--precise",
      "--no-title",
      "--no-wrap",
      "--exec",
      "--no-rerun",
    ],
    longValue: ["--interval", "--equexit"],
    stop: HELP,
    joinRest: true,
  },
  unbuffer: {},
  // `busybox rm -rf /x` runs the applet `rm`; `busybox --list` runs nothing.
  busybox: { stop: { ...HELP, "--list": "none", "--list-full": "none", "--install": "none" } },
  su: {
    shortValue: "gGsw",
    long: ["--login", "--preserve-environment", "--pty", "--fast"],
    longValue: ["--group", "--supp-group", "--shell", "--whitelist-environment"],
    script: ["-c", "--command", "--session-command"],
    stop: HELP,
    operands: "user",
    shellWhenEmpty: true,
  },
  // `runuser -u USER cmd` runs a command, `runuser USER args` a shell: ask.
  runuser: { opaque: true },
  script: {
    shortValue: "BEImOoT",
    shortOptional: "t",
    long: ["--append", "--return", "--flush", "--force", "--quiet", "--timing"],
    longValue: [
      "--log-io",
      "--echo",
      "--log-in",
      "--logging-format",
      "--log-out",
      "--output-limit",
      "--log-timing",
    ],
    script: ["-c", "--command"],
    stop: HELP,
    operands: "files",
    shellWhenEmpty: true,
  },
  parallel: { opaque: true },
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

/** `-x`, `-rf`, `--force`; not `-` (stdin) or a plain word. */
function isOption(value: string): boolean {
  return value.length > 1 && value.startsWith("-");
}

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
    if (isOption(word.value)) options.push(word.value);
  }
  return { options, unknown };
}

/**
 * `option` is present: exactly; a one-letter short option inside a cluster
 * (`-r` in `-fr`); a long option with `=value`, or a prefix of it, as GNU
 * getopt reads one (`--rec` is `--recursive`). Every prefix counts, ambiguous
 * ones too: the rule does not know the command's other options, and erring
 * strict is the safe side.
 */
function hasOption(options: readonly string[], option: string): boolean {
  const letter = /^-[^-]$/.test(option) ? option.slice(1) : undefined;
  return options.some((o) => {
    if (o === option) return true;
    if (!o.startsWith("--")) return letter !== undefined && o.includes(letter);
    const name = o.includes("=") ? o.slice(0, o.indexOf("=")) : o;
    return name.length > 2 && option.startsWith(name);
  });
}

/**
 * The first argument that is not an option, skipping option values: a
 * string, `null` when a non-literal word comes first, `undefined` for none.
 */
function subcommandOf(
  args: readonly BashWord[],
  withValue: ReadonlySet<string>,
): string | null | undefined {
  let skip = false;
  return args
    .map((word) => word.value)
    .find((value) => {
      if (skip) {
        skip = false;
        return false;
      }
      if (value === null) return true;
      skip = withValue.has(value);
      return !isOption(value);
    });
}

/** What one parsed script knows about its commands, computed once per script. */
class Scope {
  readonly #prefix = new Map<CommandRule, Int32Array>();
  readonly #sources = new Map<StdinSource, Map<CommandRule, boolean>>();

  constructor(readonly parsed: ParsedBash) {}

  /**
   * An earlier stage of a pipeline the command is in, or a command feeding
   * its stdin, runs one of `rule.pipedFrom`. Linear: a prefix count per rule
   * over the script's commands answers each pipeline range in O(1).
   */
  pipedFrom(rule: CommandRule, from: readonly string[], command: SimpleCommand): boolean {
    let prefix = this.#prefix.get(rule);
    if (prefix === undefined) {
      // Linear in the commands, which the parse already paid for.
      const n = this.parsed.commands.length;
      prefix = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) {
        const name = runName((this.parsed.commands[i] as SimpleCommand).words);
        prefix[i + 1] = (prefix[i] as number) + (name !== null && nameMatches(from, name) ? 1 : 0);
      }
      this.#prefix.set(rule, prefix);
    }
    for (const [start, end] of command.upstream) {
      if ((prefix[end] as number) > (prefix[start] as number)) return true;
    }
    const source = command.stdin;
    if (source === undefined) return false;
    let hits = this.#sources.get(source);
    if (hits === undefined) {
      hits = new Map();
      this.#sources.set(source, hits);
    }
    let hit = hits.get(rule);
    if (hit === undefined) {
      hit = source.commands.some((words) => {
        const name = runName(words);
        return name !== null && nameMatches(from, name);
      });
      hits.set(rule, hit);
    }
    return hit;
  }
}

function runName(words: readonly BashWord[]): string | null {
  const head = unwrap(words).words[0]?.value;
  return typeof head === "string" ? basename(head) : null;
}

function ruleMatches(
  rule: CommandRule,
  words: readonly BashWord[],
  name: string,
  command: SimpleCommand,
  scope: Scope,
  stdinArgs: StdinArgs,
): Match {
  if (!nameMatches(rule.command, name)) return "no";
  const args = words.slice(1);
  const results: Match[] = [];
  // `echo push | xargs git`: words from stdin may hold what an argument test looks for.
  const notSeen: Match = stdinArgs === "none" ? "no" : "unknown";
  if (rule.subcommand !== undefined) {
    const sub = subcommandOf(args, new Set(rule.optionsWithValue ?? []));
    results.push(
      sub === null
        ? "unknown"
        : sub === rule.subcommand
          ? "yes"
          : sub === undefined || stdinArgs === "replace"
            ? notSeen
            : "no",
    );
  }
  if (rule.flags !== undefined) {
    const { options, unknown } = optionWords(args);
    const all = rule.flags.every((group) => group.some((option) => hasOption(options, option)));
    results.push(all ? "yes" : unknown ? "unknown" : notSeen);
  }
  if (rule.args !== undefined) {
    const literal = new Set(args.map((w) => w.value).filter((v): v is string => v !== null));
    const all = rule.args.every((a) => literal.has(a));
    results.push(all ? "yes" : args.some((w) => w.value === null) ? "unknown" : notSeen);
  }
  if (rule.pipedFrom !== undefined) {
    results.push(scope.pipedFrom(rule, rule.pipedFrom, command) ? "yes" : "no");
  }
  if (results.includes("no")) return "no";
  return results.includes("unknown") ? "unknown" : "yes";
}

interface Unwrapped {
  /** The command that runs; empty when nothing does (`command -v git`, `xargs` alone). */
  readonly words: readonly BashWord[];
  /** Set when a wrapper option hides what runs (`env -S`, `sudo -s`, `parallel`). */
  readonly unclear?: string;
  /** Shell strings a wrapper runs (`su -c`, `flock -c`, `watch`'s joined words). */
  readonly scripts: readonly BashWord[];
  /** A wrapper runs a shell that reads stdin (`su` with no `-c`). */
  readonly shell: boolean;
  /**
   * `xargs` adds words from stdin to the command: after its words
   * (`append`), or in place of a word (`replace`, with `-I`).
   */
  readonly stdinArgs: StdinArgs;
}

type StdinArgs = "none" | "append" | "replace";

interface OptionRead {
  readonly stop?: "none" | "ask" | "shell";
  /** The next word is this option's value. */
  readonly takesNext: boolean;
  /** The option's value is a shell string: attached, or the next word when `takesNext`. */
  readonly script?: string | null;
  /** A long option the wrapper does not know. */
  readonly unknown?: boolean;
}

function longOptions(wrapper: Wrapper): string[] {
  return [
    ...(wrapper.long ?? []),
    ...(wrapper.longValue ?? []),
    ...(wrapper.script ?? []).filter((o) => o.startsWith("--")),
    ...Object.keys(wrapper.stop ?? {}).filter((o) => o.startsWith("--")),
  ];
}

/** Reads one option word of a wrapper, getopt style. */
function readOption(wrapper: Wrapper, value: string): OptionRead {
  if (value.startsWith("--")) {
    const eq = value.indexOf("=");
    const given = eq === -1 ? value : value.slice(0, eq);
    const known = longOptions(wrapper);
    let option = known.find((o) => o === given);
    if (option === undefined) {
      const candidates = known.filter((o) => given.length > 2 && o.startsWith(given));
      if (candidates.length !== 1) return { takesNext: false, unknown: true };
      option = candidates[0] as string;
    }
    const stop = wrapper.stop?.[option];
    if (stop !== undefined) return { stop, takesNext: false };
    if (wrapper.script?.includes(option)) {
      return eq === -1
        ? { takesNext: true, script: null }
        : { takesNext: false, script: value.slice(eq + 1) };
    }
    return { takesNext: eq === -1 && (wrapper.longValue ?? []).includes(option) };
  }
  // A cluster: `-iS'x'` is `-i` then `-S` with `x`; `-su root` is `-s`, then `-u root`.
  let shell: { stop?: "shell" } = {};
  for (let j = 1; j < value.length; j++) {
    const letter = value[j] as string;
    const stop = wrapper.stop?.[`-${letter}`];
    if (stop === "shell") {
      shell = { stop: "shell" };
      continue;
    }
    if (stop !== undefined) return { stop, takesNext: false };
    const attached = value.slice(j + 1);
    if (wrapper.script?.includes(`-${letter}`)) {
      return attached === ""
        ? { ...shell, takesNext: true, script: null }
        : { ...shell, takesNext: false, script: attached };
    }
    if ((wrapper.shortValue ?? "").includes(letter))
      return { ...shell, takesNext: attached === "" };
    if ((wrapper.shortOptional ?? "").includes(letter)) break;
  }
  return { ...shell, takesNext: false };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Strips wrappers until the command that runs; `VAR=x` words of `env`/`sudo` too. Linear. */
function unwrap(words: readonly BashWord[]): Unwrapped {
  let start = 0;
  let stdinArgs: StdinArgs = "none";
  const scripts: BashWord[] = [];
  const result = (rest: readonly BashWord[], extra: Partial<Unwrapped> = {}): Unwrapped => ({
    words: rest,
    scripts,
    shell: false,
    stdinArgs,
    ...extra,
  });
  for (;;) {
    const head = words[start]?.value;
    if (typeof head !== "string") return result(words.slice(start));
    const wrapper = WRAPPERS[basename(head)];
    if (wrapper === undefined) return result(words.slice(start));
    const rest = words.slice(start);
    if (wrapper.opaque === true) return result(rest, { unclear: head });
    if (wrapper.stdinArgs === true && stdinArgs === "none") stdinArgs = "append";
    const operands = wrapper.operands ?? "command";
    let positionals = wrapper.positionals ?? 0;
    let user = false;
    let options = true;
    let viaShell = false;
    let i = start + 1;
    for (; i < words.length; i++) {
      const word = words[i] as BashWord;
      const value = word.value;
      if (value === null) {
        if (operands === "command") break;
        return result(rest, { unclear: `${head} ${word.text}` });
      }
      if (options && isOption(value)) {
        if (value === "--") {
          options = false;
          continue;
        }
        const read = readOption(wrapper, value);
        if (read.unknown === true || read.stop === "ask") {
          return result(rest, { unclear: `${head} ${value}` });
        }
        if (read.stop === "none") return result([]);
        // `xargs -I {}`, `-i`, `--replace`: stdin words replace any word.
        if (wrapper.stdinArgs === true && /^(-[^-]*[Ii]|--rep)/.test(value)) stdinArgs = "replace";
        if (read.stop === "shell") viaShell = true;
        if (read.script !== undefined) {
          const script = read.takesNext ? words[i + 1] : { value: read.script, text: value };
          if (script !== undefined) scripts.push(script);
        }
        if (read.takesNext) i++;
        continue;
      }
      if (wrapper.dashOption === true && options && value === "-") continue;
      if (wrapper.assignments === true && options && ASSIGNMENT.test(value)) continue;
      if (positionals > 0) {
        positionals--;
        continue;
      }
      if (operands === "files") continue;
      if (operands === "user") {
        if (value === "-" || !user) {
          user ||= value !== "-";
          continue;
        }
        return result(rest, { unclear: `${head} with arguments for its shell` });
      }
      break;
    }
    if (operands !== "command") {
      return result([], { shell: scripts.length === 0 && wrapper.shellWhenEmpty === true });
    }
    if (wrapper.joinRest === true || viaShell) {
      const joined = words.slice(i);
      if (joined.length > 0) {
        const literal = joined.every((w) => w.value !== null);
        scripts.push({
          value: literal ? joined.map((w) => w.value).join(" ") : null,
          text: joined.map((w) => w.text).join(" "),
        });
      }
      return result([], { shell: viaShell && joined.length === 0 });
    }
    if (i >= words.length && scripts.length === 0 && wrapper.shellWhenEmpty === true) {
      return result([], { shell: true });
    }
    // `xargs` alone runs `echo`; `env` alone prints; `nohup` alone fails.
    start = i;
  }
}

/** The index of the `-c` script operand of a shell, -1 without `-c`, `null` if a non-literal option hides it. */
function shellScriptIndex(args: readonly BashWord[]): number | null {
  let sawC = false;
  for (let i = 0; i < args.length; i++) {
    const value = (args[i] as BashWord).value;
    if (value === null) return sawC ? i : null;
    if (isOption(value) && !value.startsWith("--")) {
      if (value.includes("c")) sawC = true;
      // `-o opt` / `-O opt` take a value.
      if (/^-[^-]*[oO]$/.test(value)) i++;
      continue;
    }
    // `--rcfile FILE` / `--init-file FILE` take a value.
    if (value === "--rcfile" || value === "--init-file") i++;
    if (value.startsWith("+") || value.startsWith("--")) continue;
    return sawC ? i : -1;
  }
  return sawC ? args.length : -1;
}

interface Context {
  readonly rules: readonly CommandRule[];
  readonly raw: readonly CompiledDenyRule[];
  readonly depth: number;
  readonly budget: Budget;
}

function unclear(why: string, reason: string, command?: string): BashVerdict {
  return {
    action: "ask",
    rule: `unclear:${why}`,
    reason,
    ...(command === undefined ? {} : { command }),
  };
}

const OVER_BUDGET = unclear(
  "budget",
  `the command is too large to check (over ${MAX_POLICY_STEPS} steps)`,
);

function judgeScript(source: string, ctx: Context): BashVerdict {
  const parsed = parseBash(source, undefined, ctx.budget);
  let verdict = ALLOW;
  if (parsed.exhausted === true) {
    // Out of budget: still judge the commands already read, so a readable
    // `git push` keeps its deny instead of becoming an `ask`.
    verdict = OVER_BUDGET;
    const partial = new Scope(parsed);
    for (const command of parsed.commands) {
      verdict = stricter(verdict, judgeCommand(command, ctx, partial));
    }
    return verdict;
  }
  if (parsed.errors.length > 0) {
    verdict = unclear("parse-error", `the command did not parse: ${parsed.errors[0]}`);
  }
  const scope = new Scope(parsed);
  for (const command of parsed.commands) {
    verdict = stricter(verdict, judgeCommand(command, ctx, scope));
    if (ctx.budget.steps < 0) return stricter(verdict, OVER_BUDGET);
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

/** `git -c alias.p=push p`, `git --config-env=alias.p=VAR p`: an inline alias. */
function gitInlineAlias(args: readonly BashWord[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const value = (args[i] as BashWord).value;
    if (value === null) return false;
    if (!isOption(value)) return false;
    let config: string | null | undefined;
    if (value === "-c" || value === "--config-env") config = args[++i]?.value;
    else if (value.startsWith("--config-env=")) config = value.slice("--config-env=".length);
    else if (value.startsWith("-c")) config = value.slice(2);
    else if (GIT_OPTIONS_WITH_VALUE.includes(value)) i++;
    if (config === null || (config !== undefined && /^alias\./i.test(config))) return true;
  }
  return false;
}

function judgeCommand(command: SimpleCommand, ctx: Context, scope: Scope): BashVerdict {
  ctx.budget.steps -= command.words.length + ctx.rules.length;
  // The command as written, before unwrapping, also meets the raw patterns.
  let verdict = rawDeny(command.words, ctx) ?? ALLOW;
  const inner = unwrap(command.words);
  const words = inner.words;
  if (inner.unclear !== undefined) {
    return stricter(
      verdict,
      unclear("wrapper", `cannot see what ${inner.unclear} runs`, display(inner.words)),
    );
  }
  if (inner.stdinArgs === "replace" && inner.scripts.length > 0) {
    // `xargs -I{} su -c {}`: the string is xargs' input, not what is written.
    return stricter(
      verdict,
      unclear("script", "xargs puts its input into a command string", display(command.words)),
    );
  }
  for (const script of inner.scripts) {
    const shown = display(command.words);
    verdict = stricter(
      verdict,
      script.value === null
        ? unclear("shell", "a wrapper's shell string is not a literal", shown)
        : nested(script.value, ctx, shown),
    );
  }
  const readsStdin = command.piped || command.stdin !== undefined || inner.stdinArgs !== "none";
  if (inner.shell && readsStdin) {
    return stricter(
      verdict,
      unclear("script", "a shell runs a script the parser cannot see", display(command.words)),
    );
  }
  if (words.length === 0) return verdict;
  const shown = display(words);
  verdict = stricter(verdict, rawDeny(words, ctx) ?? ALLOW);
  const head = words[0]?.value;
  if (head === null || head === undefined) {
    return stricter(verdict, unclear("name", "the command name is not a literal", shown));
  }
  const name = basename(head);
  for (const rule of ctx.rules) {
    const match = ruleMatches(rule, words, name, command, scope, inner.stdinArgs);
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
  if (name === "alias" || (name === "git" && gitInlineAlias(args))) {
    return stricter(verdict, unclear("alias", "an alias can rename any command", shown));
  }
  if (name === "source" || name === ".") {
    return stricter(verdict, unclear("script", "runs a script the parser cannot see", shown));
  }
  if (inner.stdinArgs === "replace" && (name === "eval" || SHELLS.has(name))) {
    // `xargs -I{} sh -c '{}'`, `xargs -i eval {}`: the script is xargs' input.
    return stricter(verdict, unclear("script", "xargs puts its input into a script", shown));
  }
  if (name === "eval") {
    if (args.some((w) => w.value === null)) {
      return stricter(verdict, unclear("eval", "eval of a string that is not a literal", shown));
    }
    return stricter(verdict, nested(args.map((w) => w.value as string).join(" "), ctx, shown));
  }
  if (SHELLS.has(name)) {
    const index = shellScriptIndex(args);
    if (index === null) {
      return stricter(verdict, unclear("shell", "a shell option is not a literal", shown));
    }
    if (index === -1) {
      // A script file, a pipe, a redirect, a here-doc or here-string, xargs' words: unseen.
      const reads = args.some((w) => w.value !== null && !w.value.startsWith("-"));
      if (reads || readsStdin) {
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
 * `steps` is the work budget (tests).
 */
export function classifyBash(
  command: string,
  rules: readonly CommandRule[],
  raw: readonly CompiledDenyRule[] = [],
  steps: number = MAX_POLICY_STEPS,
): BashVerdict {
  const ctx: Context = { rules, raw, depth: 0, budget: { steps } };
  // The raw string first, as before #69: it is the fallback when parsing fails or runs out.
  const whole = denied(raw, "bash", { command });
  if (whole !== undefined) {
    return { action: "deny", rule: `raw:${raw.indexOf(whole)}`, reason: whole.reason };
  }
  return judgeScript(command, ctx);
}
