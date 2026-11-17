/**
 * The bash parser adapter for the command rules (#69, decision 0044): turns a
 * `bash` tool call's `command` into simple commands, as word lists, with the
 * `unbash` parser. Everything Hearth decides about those commands is in
 * bash-policy.ts; this file is the only one that knows the parser, so another
 * one (`tree-sitter-bash`) can stand behind the same interface.
 *
 * - The tree is walked with `forEachChild` only. A substitution's nested
 *   script (`$(...)`, backticks, `<(...)`, `>(...)`, `$(( $(...) ))`) is a
 *   lazy field that a plain walk over the object's own fields never sees.
 * - Every script, the nested ones included, carries its own `errors`; each one
 *   is reported.
 * - A word is literal when it has no expansion, glob or brace part: quotes and
 *   escapes are removed (`g"i"t` is `git`), anything else is `null`.
 * - Pipes and stdin: a command records the earlier stages of every pipeline
 *   it is in as index ranges into `commands` (one walk, no copies: a
 *   pipeline of 20,000 stages stays linear), and the commands whose output
 *   is its stdin (`< <(curl x)`, `<<< "$(curl x)"`, a here-doc).
 * - Bounded: the input length is capped (`MAX_COMMAND_BYTES`), which bounds
 *   the tree; the parser caps nesting itself (3,000 nested `$(` is an error,
 *   not a hang); the walk spends a shared step budget and stops when it runs
 *   out; an exception from the parser or the walk is a parse error.
 */

import {
  type Assignment,
  type Command,
  forEachChild,
  type ParsedScript,
  parse,
  type Redirection,
  type SyntaxNode,
  type Word,
} from "unbash";

/** Above this many UTF-16 units the command is not parsed; the policy asks. */
export const MAX_COMMAND_BYTES = 64 * 1024;

/** One word of a simple command. */
export interface BashWord {
  /** The word as bash sees it after quote removal, or `null` when it is not a literal. */
  readonly value: string | null;
  /** The word as written, for display. */
  readonly text: string;
}

/** Commands whose output is a command's stdin: what a stdin redirection runs. */
export interface StdinSource {
  /** Filled while the walk is in the redirection; complete once `parseBash` returns. */
  readonly commands: (readonly BashWord[])[];
}

/** A simple command: a name and its arguments, prefix assignments dropped. */
export interface SimpleCommand {
  /** `words[0]` is the command name. Never empty. */
  readonly words: readonly BashWord[];
  /**
   * The earlier stages of every pipeline this command is in (`curl x | sh`),
   * as `[from, to)` ranges of indexes into `ParsedBash.commands`. Empty when
   * no stage comes before it.
   */
  readonly upstream: readonly (readonly [number, number])[];
  /** The command reads a pipe: it is in a pipeline stage after the first. */
  readonly piped: boolean;
  /** Its stdin is redirected (`<`, `<<`, `<<<`, `0<&`), or its compound's is. */
  readonly stdin?: StdinSource;
}

export interface ParsedBash {
  readonly commands: readonly SimpleCommand[];
  /** Parse errors, of the script and of every nested one. Empty when it parsed cleanly. */
  readonly errors: readonly string[];
  /** The step budget ran out; `commands` is what was seen before that. */
  readonly exhausted?: boolean;
}

/** Work shared by every parse and check of one classification. */
export interface Budget {
  steps: number;
}

/** The earlier stages of every enclosing pipeline, all of them, as command ranges. */
export function upstreamCommands(parsed: ParsedBash, command: SimpleCommand): SimpleCommand[] {
  return command.upstream.flatMap(([from, to]) => parsed.commands.slice(from, to));
}

const LITERAL_PARTS = new Set(["Literal", "SingleQuoted", "AnsiCQuoted"]);

interface WordPartLike {
  readonly type: string;
  readonly parts?: readonly { readonly type: string }[] | undefined;
}

function literalPart(part: WordPartLike): boolean {
  return (
    LITERAL_PARTS.has(part.type) ||
    (part.type === "DoubleQuoted" && (part.parts ?? []).every((c) => c.type === "Literal"))
  );
}

/** A word's value when it is a literal, else `null`. */
export function literalWord(word: Word): string | null {
  const parts = word.parts;
  if (parts === undefined) return word.value;
  return parts.every((part) => literalPart(part)) ? word.value : null;
}

function bashWord(node: Word | Assignment): BashWord {
  if (node.type === "Word") return { value: literalWord(node), text: node.text };
  // `env FOO=1 cmd` parses as a word; a declaration builtin's argument (`export A=1`) is an assignment.
  const value = node.value.type === "Word" ? literalWord(node.value) : null;
  return { value: value === null ? null : `${node.name}=${value}`, text: node.text };
}

/** Operators whose default descriptor is 0 (stdin). */
const INPUT_OPERATORS = new Set(["<", "<>", "<&", "<<", "<<-", "<<<"]);

/** The redirection replaces stdin: `< f`, `<<EOF`, `<<< s`, `0<&3`, `0>&3`. */
function redirectsStdin(redirect: Redirection): boolean {
  const descriptor = redirect.descriptor;
  if (descriptor === undefined) return INPUT_OPERATORS.has(redirect.operator);
  return descriptor.type === "FileDescriptor" && descriptor.value === 0;
}

function isRedirection(node: SyntaxNode): node is Redirection {
  return node.type === "Redirect" || node.type === "HereString" || node.type === "HereDoc";
}

/** One pipeline stage in the walk: its range of earlier commands ends when the stage starts. */
interface Stage {
  readonly from: number;
  to: number;
  readonly outer: Stage | undefined;
}

interface Frame {
  readonly node: SyntaxNode;
  /** The innermost pipeline stage this node is in, after the first stage. */
  readonly stage: Stage | undefined;
  /** Set on a stage's own node: the stage starts here, so its range ends here. */
  readonly starts?: Stage;
  /** The stdin of the commands below, from an enclosing redirection. */
  readonly stdin: StdinSource | undefined;
  /** The redirection this node is in feeds this stdin. */
  readonly feeds: StdinSource | undefined;
}

/** Parses one script; never throws. `parser` is for tests. */
export function parseBash(
  source: string,
  parser: (source: string) => ParsedScript = parse,
  budget: Budget = { steps: Number.POSITIVE_INFINITY },
): ParsedBash {
  if (source.length > MAX_COMMAND_BYTES) {
    return { commands: [], errors: [`command longer than ${MAX_COMMAND_BYTES} characters`] };
  }
  // Parsing costs one step per character; a nested script's lazy parse below too.
  budget.steps -= source.length;
  if (budget.steps < 0) return { commands: [], errors: [], exhausted: true };
  let root: ParsedScript;
  try {
    root = parser(source);
  } catch (error) {
    return { commands: [], errors: [`parser failed: ${String(error)}`] };
  }
  const commands: SimpleCommand[] = [];
  const errors: string[] = [];
  const stack: Frame[] = [{ node: root, stage: undefined, stdin: undefined, feeds: undefined }];
  try {
    while (stack.length > 0) {
      if (--budget.steps < 0) return { commands, errors, exhausted: true };
      const frame = stack.pop() as Frame;
      const node = frame.node;
      if (frame.starts !== undefined) frame.starts.to = commands.length;
      const stage = frame.stage;
      let stdin = frame.stdin;
      if (node.type === "Script") {
        // A nested script has its own errors. It keeps the pipe and stdin around
        // it: `curl x | echo $(sh)` and `{ echo $(sh); } < f` run `sh` on them.
        for (const e of (node as ParsedScript).errors ?? []) errors.push(e.message);
      }
      if (
        node.type === "CommandExpansion" ||
        node.type === "ProcessSubstitution" ||
        node.type === "ArithmeticCommandExpansion"
      ) {
        // Reading `script` parses it; 256 levels of a 64 KiB `$(` re-read it all
        // each time. The next node's check stops the walk once this runs out.
        budget.steps -= node.end - node.pos;
        if (node.script === undefined) errors.push(`unparsed substitution: ${node.text}`);
      }
      // The node's own stdin redirections (a command's, a compound's) feed what runs below it.
      let own: StdinSource | undefined;
      if (node.type === "Command" || node.type === "Redirected") {
        if (
          (node as Command | { redirects: readonly Redirection[] }).redirects.some(redirectsStdin)
        ) {
          own = { commands: [] };
        }
      }
      if (node.type === "Command" && node.name !== undefined) {
        const words = [node.name, ...node.args].map(bashWord);
        const upstream: (readonly [number, number])[] = [];
        // At most one stage per enclosing pipeline: the parser caps nesting at 256.
        for (let s = stage; s !== undefined; s = s.outer) {
          if (s.to > s.from) upstream.push([s.from, s.to]);
        }
        const input = own ?? stdin;
        commands.push({
          words,
          upstream,
          piped: stage !== undefined,
          ...(input === undefined ? {} : { stdin: input }),
        });
        frame.feeds?.commands.push(words);
      } else if (own !== undefined) {
        stdin = own;
      }
      const children: Frame[] = [];
      const base = { stage, stdin, feeds: frame.feeds };
      if (node.type === "Pipeline") {
        const from = commands.length;
        let index = -node.prefixes.length;
        forEachChild(node, (child) => {
          if (index++ <= 0) {
            children.push({ node: child, ...base });
            return;
          }
          const next: Stage = { from, to: from, outer: stage };
          children.push({ node: child, ...base, stage: next, starts: next });
        });
      } else {
        forEachChild(node, (child) => {
          // A stdin redirection's own commands feed it; they do not read it.
          const feeds = own !== undefined && isRedirection(child) && redirectsStdin(child);
          children.push(
            feeds
              ? { node: child, ...base, stdin: frame.stdin, feeds: own }
              : { node: child, ...base },
          );
        });
      }
      // Reverse so the walk (and the command order) follows the source.
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Frame);
    }
  } catch (error) {
    errors.push(`parser failed: ${String(error)}`);
  }
  return { commands, errors };
}
