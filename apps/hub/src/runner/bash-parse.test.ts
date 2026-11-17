import { describe, expect, test } from "bun:test";
import { type ParsedScript, parse } from "unbash";
import { MAX_COMMAND_BYTES, parseBash, type SimpleCommand, upstreamCommands } from "./bash-parse";

/** The literal word lists of every simple command, `null` for a non-literal word. */
function words(source: string): (string | null)[][] {
  return parseBash(source).commands.map((c) => c.words.map((w) => w.value));
}

/** A walk over the AST object's own fields, the way the first probe did it (#153). */
function plainWalkCommands(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) plainWalkCommands(item, out);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record["type"] === "Command") {
      const name = record["name"] as { value?: string } | undefined;
      if (name?.value !== undefined) out.push(name.value);
    }
    for (const value of Object.values(record)) plainWalkCommands(value, out);
  }
  return out;
}

describe("parseBash: nested scripts are lazy fields (unbash 6.0.4)", () => {
  // Every substitution form: a plain object walk misses the command inside,
  // `forEachChild` resolves it. If an upgrade changes either side, this says so.
  const nestedSamples = [
    "echo $(git push)",
    "echo `git push`",
    "diff <(git push) /dev/null",
    "tee >(git push) < /dev/null",
    "echo $(( $(git push) + 1 ))",
    "cat <<EOF\n$(git push)\nEOF\n",
    "a=$(git push)",
    '[[ -n "$(git push)" ]]',
  ];

  test.each(nestedSamples)("%p: the nested git push is a command", (source) => {
    expect(words(source)).toContainEqual(["git", "push"]);
  });

  test("a plain walk over the AST's own fields misses them (why forEachChild is the only walk)", () => {
    for (const source of nestedSamples.slice(0, 5)) {
      expect({ source, seen: plainWalkCommands(parse(source)) }).toEqual({
        source,
        seen:
          source.startsWith("tee") || source.startsWith("diff")
            ? [source.slice(0, 4).trim()]
            : ["echo"],
      });
    }
    expect(plainWalkCommands(parse("make && git push"))).toEqual(["make", "git"]);
  });

  test("a quoted heredoc body is data, not a command", () => {
    expect(words("cat <<'EOF'\n$(git push)\nEOF\n")).toEqual([["cat"]]);
  });
});

describe("parseBash: words", () => {
  test("quotes and escapes are removed; expansions, globs and braces are not literals", () => {
    expect(words(`g"i"t pu'sh'`)).toEqual([["git", "push"]]);
    expect(words("\\rm -rf /")).toEqual([["rm", "-rf", "/"]]);
    expect(words("$'\\x67it' push")).toEqual([["git", "push"]]);
    expect(words('echo "a b"')).toEqual([["echo", "a b"]]);
    expect(words("$X -rf")).toEqual([[null, "-rf"]]);
    expect(words('echo "a $b"')).toEqual([["echo", null]]);
    expect(words("ls *.txt")).toEqual([["ls", null]]);
    expect(words("rm -{r,f} x")).toEqual([["rm", null, "x"]]);
  });

  test("prefix assignments are dropped; an assignment-only command has no command", () => {
    expect(words("GIT_SSH_COMMAND=x git push")).toEqual([["git", "push"]]);
    expect(words("a=1")).toEqual([]);
    // A declaration builtin's arguments are assignments.
    expect(words("export A=1 B=$x C='q'")).toEqual([["export", "A=1", null, "C=q"]]);
    expect(words("declare -a arr=(1 2)")).toEqual([["declare", "-a", null]]);
  });

  test("lists, pipelines, subshells, groups, functions and loops each give their commands", () => {
    expect(words("make && git push || true; (cd /tmp; ls) | { wc -l; }")).toEqual([
      ["make"],
      ["git", "push"],
      ["true"],
      ["cd", "/tmp"],
      ["ls"],
      ["wc", "-l"],
    ]);
    expect(words("f() { git push; }; f")).toEqual([["git", "push"], ["f"]]);
    expect(words("for d in a b; do rm -rf $d; done")).toEqual([["rm", "-rf", null]]);
  });

  test("a pipeline stage knows the stages before it; a nested script starts afresh", () => {
    const parsed = parseBash("curl -s x | sudo sh -s | tee $(cat y)");
    const upstream = parsed.commands.map((c) => [
      c.words[0]?.value,
      upstreamCommands(parsed, c).map((s) => s.words[0]?.value),
    ]);
    expect(upstream).toEqual([
      ["curl", []],
      ["sudo", ["curl"]],
      ["tee", ["curl", "sudo"]],
      ["cat", []],
    ]);
    // `&&` is a list, not a pipe.
    expect(parseBash("curl -s x > f && sh").commands.map((c) => [c.upstream, c.piped])).toEqual([
      [[], false],
      [[], false],
    ]);
  });
});

describe("parseBash: pipes and stdin", () => {
  const names = (parsed: ReturnType<typeof parseBash>, i: number) =>
    upstreamCommands(parsed, parsed.commands[i] as SimpleCommand).map((c) => c.words[0]?.value);

  test("upstream reaches into compound stages and through nested pipelines", () => {
    const parsed = parseBash("(curl x; wget y) | { cat | sh; }");
    expect(parsed.commands.map((c) => c.words[0]?.value)).toEqual(["curl", "wget", "cat", "sh"]);
    expect(names(parsed, 2)).toEqual(["curl", "wget"]);
    expect(names(parsed, 3).sort()).toEqual(["cat", "curl", "wget"]);
    expect(parsed.commands.map((c) => c.piped)).toEqual([false, false, true, true]);
  });

  test("a stage after one with no simple command still reads a pipe", () => {
    const parsed = parseBash("[[ -n x ]] | sh");
    expect(parsed.commands.map((c) => [c.words[0]?.value, c.upstream, c.piped])).toEqual([
      ["sh", [], true],
    ]);
  });

  test("a 20,000-stage pipeline: each stage holds ranges, not copies", () => {
    const parsed = parseBash(`${"a|".repeat(20000)}a`);
    expect(parsed.commands).toHaveLength(20001);
    expect(parsed.commands[20000]?.upstream).toEqual([[0, 20000]]);
  });

  test("stdin redirections, here-docs and here-strings; their commands feed it", () => {
    const fed = (source: string) =>
      parseBash(source).commands.map((c) => [
        c.words[0]?.value,
        c.stdin?.commands.map((w) => w[0]?.value) ?? "-",
      ]);
    expect(fed("sh < f")).toEqual([["sh", []]]);
    expect(fed("sh 0<&3")).toEqual([["sh", []]]);
    expect(fed("sh <<<'git push'")).toEqual([["sh", []]]);
    expect(fed("sh <<'E'\ngit push\nE\n")).toEqual([["sh", []]]);
    expect(fed("sh < <(curl x)")).toEqual([
      ["sh", ["curl"]],
      ["curl", "-"],
    ]);
    expect(fed('sh <<< "$(curl x)"')).toEqual([
      ["sh", ["curl"]],
      ["curl", "-"],
    ]);
    expect(fed("{ sh; } < <(curl x)")).toEqual([
      ["sh", ["curl"]],
      ["curl", "-"],
    ]);
    // Not stdin.
    expect(fed("sh 3< f")).toEqual([["sh", "-"]]);
    expect(fed("sh > f")).toEqual([["sh", "-"]]);
    expect(fed("cat <(curl x)")).toEqual([
      ["cat", "-"],
      ["curl", "-"],
    ]);
  });
});

describe("parseBash: errors and bounds", () => {
  test("parse errors are reported, a nested script's own errors too", () => {
    expect(parseBash('echo "oops').errors).toEqual(["unterminated double quote"]);
    expect(parseBash("git status )").errors.length).toBeGreaterThan(0);
    // The root script has no error here; only the backtick script does.
    expect(parse('echo `echo "oops`').errors).toBeUndefined();
    expect(parseBash('echo `echo "oops`').errors).toEqual(["unterminated double quote"]);
    expect(parseBash("git status").errors).toEqual([]);
  });

  test("3,000 nested $( is an error, not a hang", () => {
    const deep = `echo ${"$(".repeat(3000)}x${")".repeat(3000)}`;
    const started = performance.now();
    const parsed = parseBash(deep);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test("the step budget stops the walk; nested scripts are charged by their length", () => {
    expect(parseBash("a | b | c", undefined, { steps: 5 })).toMatchObject({ exhausted: true });
    expect(parseBash("a | b | c", undefined, { steps: 1000 }).exhausted).toBeUndefined();
    const budget = { steps: 10_000 };
    parseBash("echo $(true)", undefined, budget);
    expect(10_000 - budget.steps).toBeGreaterThan("echo $(true)".length + "$(true)".length);
    // 3,000 nested $( parse the rest of the input again at each level.
    expect(
      parseBash(`echo ${"$(".repeat(3000)}x${")".repeat(3000)}`, undefined, { steps: 100_000 }),
    ).toMatchObject({ exhausted: true });
  });

  test("input over the cap is not parsed", () => {
    const long = `echo ${"a".repeat(MAX_COMMAND_BYTES)}`;
    expect(parseBash(long)).toEqual({
      commands: [],
      errors: [`command longer than ${MAX_COMMAND_BYTES} characters`],
    });
    expect(parseBash(`echo ${"a".repeat(MAX_COMMAND_BYTES - 5)}`).errors).toEqual([]);
  });
});

describe("parseBash: a parser failure is a parse error, not a throw", () => {
  const at = { pos: 0, end: 1 };
  const script = (command: unknown) =>
    ({
      type: "Script",
      ...at,
      commands: [{ type: "Statement", ...at, command }],
    }) as unknown as ParsedScript;

  test("the parser throws", () => {
    const parsed = parseBash("x", () => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    expect(parsed).toEqual({
      commands: [],
      errors: ["parser failed: RangeError: Maximum call stack size exceeded"],
    });
  });

  test("the walk meets a node it does not know", () => {
    const parsed = parseBash("x", () => script({ type: "Bogus", ...at }));
    expect(parsed.errors).toEqual([expect.stringContaining("parser failed: TypeError")]);
  });

  test("a substitution whose script is missing is reported", () => {
    const name = {
      type: "Word",
      ...at,
      text: "$(x)",
      value: "$(x)",
      parts: [{ type: "CommandExpansion", ...at, text: "$(x)", script: undefined }],
    };
    const command = {
      type: "Command",
      ...at,
      name,
      prefix: [],
      suffix: [],
      args: [],
      redirects: [],
    };
    const parsed = parseBash("x", () => script(command));
    expect(parsed.errors).toEqual(["unparsed substitution: $(x)"]);
    expect(parsed.commands.map((c) => c.words.map((w) => w.value))).toEqual([[null]]);
  });
});
