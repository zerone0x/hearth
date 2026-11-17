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
 * - Bounded: the input length is capped (`MAX_COMMAND_BYTES`), the parser caps
 *   nesting itself (3,000 nested `$(` is an error, not a hang), the walk counts
 *   nodes, and an exception from the parser is a parse error.
 */

import { forEachChild, type ParsedScript, parse, type SyntaxNode, type Word } from "unbash";

/** Above this many UTF-16 units the command is not parsed; the policy asks. */
export const MAX_COMMAND_BYTES = 64 * 1024;
/** The walk stops after this many syntax nodes and reports an error. */
export const MAX_SYNTAX_NODES = 200_000;

/** One word of a simple command. */
export interface BashWord {
  /** The word as bash sees it after quote removal, or `null` when it is not a literal. */
  readonly value: string | null;
  /** The word as written, for display. */
  readonly text: string;
}

/** A simple command: a name and its arguments, prefix assignments dropped. */
export interface SimpleCommand {
  /** `words[0]` is the command name. Never empty. */
  readonly words: readonly BashWord[];
  /** The earlier stages of the closest pipeline this command reads from (`curl x | sh`). */
  readonly upstream: readonly (readonly BashWord[])[];
}

export interface ParsedBash {
  readonly commands: readonly SimpleCommand[];
  /** Parse errors, of the script and of every nested one. Empty when it parsed cleanly. */
  readonly errors: readonly string[];
}

const LITERAL_PARTS = new Set(["Literal", "SingleQuoted", "AnsiCQuoted"]);

interface WordPartLike {
  readonly type: string;
  readonly parts?: readonly { readonly type: string }[] | undefined;
}

function literalPart(part: WordPartLike): boolean {
  if (LITERAL_PARTS.has(part.type)) return true;
  if (part.type === "DoubleQuoted") {
    return (part.parts ?? []).every((child) => child.type === "Literal");
  }
  return false;
}

/** A word's value when it is a literal, else `null`. */
export function literalWord(word: Word): string | null {
  const parts = word.parts;
  if (parts === undefined) return word.value;
  return parts.every((part) => literalPart(part)) ? word.value : null;
}

function bashWord(node: SyntaxNode): BashWord {
  if (node.type === "Word") return { value: literalWord(node), text: node.text };
  if (node.type === "Assignment") {
    // `env FOO=1 cmd` parses as a word; a declaration builtin's argument can be an assignment.
    const value = node.value.type === "Word" ? literalWord(node.value) : null;
    return { value: value === null ? null : `${node.name}=${value}`, text: node.text };
  }
  return { value: null, text: "" };
}

interface Frame {
  readonly node: SyntaxNode;
  readonly upstream: readonly (readonly BashWord[])[];
}

/** Parses one script; never throws. */
export function parseBash(source: string): ParsedBash {
  if (source.length > MAX_COMMAND_BYTES) {
    return { commands: [], errors: [`command longer than ${MAX_COMMAND_BYTES} characters`] };
  }
  let root: ParsedScript;
  try {
    root = parse(source);
  } catch (error) {
    return { commands: [], errors: [`parser failed: ${String(error)}`] };
  }
  const commands: SimpleCommand[] = [];
  const errors: string[] = [];
  const stack: Frame[] = [{ node: root, upstream: [] }];
  let visited = 0;
  try {
    while (stack.length > 0) {
      const frame = stack.pop() as Frame;
      const node = frame.node;
      if (++visited > MAX_SYNTAX_NODES) {
        errors.push(`more than ${MAX_SYNTAX_NODES} syntax nodes`);
        break;
      }
      // A nested script starts a fresh pipeline context.
      const upstream = node.type === "Script" ? [] : frame.upstream;
      if (node.type === "Script") {
        for (const e of (node as ParsedScript).errors ?? []) errors.push(e.message);
      }
      if (
        (node.type === "CommandExpansion" ||
          node.type === "ProcessSubstitution" ||
          node.type === "ArithmeticCommandExpansion") &&
        node.script === undefined
      ) {
        errors.push(`unparsed substitution: ${node.text}`);
      }
      if (node.type === "Command" && node.name !== undefined) {
        const words = [node.name, ...node.args].map(bashWord);
        commands.push({ words, upstream });
      }
      const children: Frame[] = [];
      if (node.type === "Pipeline") {
        const stages: (readonly BashWord[])[] = [];
        forEachChild(node, (child) => {
          children.push({ node: child, upstream: [...upstream, ...stages] });
          if (child.type === "Command" && child.name !== undefined) {
            stages.push([child.name, ...child.args].map(bashWord));
          }
        });
      } else {
        forEachChild(node, (child) => {
          children.push({ node: child, upstream });
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
