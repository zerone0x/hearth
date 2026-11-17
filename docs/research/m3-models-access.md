# Research: M3 models and access (permission packages, bash parsing, approvals, Bifrost)

> Issue #152 (PRD v0.5 §11.3, decision 0042) · 2026-11-17 · docs only; the probes were throwaway and are not in the tree. Owner: @zerone0x

## Sources and how to read the citations

A citation `path:line` without a repo name is a line in Hearth's `main` at
`976c156` (read on 2026-11-17). `DECISIONS 00NN` is an entry in
`docs/DECISIONS.md`. pi citations are files inside the installed
`@earendil-works/pi-coding-agent@1.5.2` (Hearth's pin), for example
`docs/extensions.md:973`. A package citation such as
`@pi-kit/permissions src/match/command.ts:3-11` is a file in that package's npm
tarball at the version in the table.

All sources are public. The npm data comes from `npm view` and the GitHub data
from the REST API (`GET /repos/{owner}/{repo}`), both read on 2026-11-17.

**pi permission packages** (the list on #148). Each tarball was fetched with
`npm pack --ignore-scripts` and read in full.

| Package | Version, published | License | Size | Runtime deps | Repo, stars, last push |
|---|---|---|---|---|---|
| `@pi-kit/permissions` | 0.4.0, 2026-10-25 | MIT | 58.9 kB, 1,413 lines | `@pi-kit/shared` 0.1.0 (26 lines) | `j7an/pi-kit`, 1, 2026-11-17 |
| `@skibum1869/pi-permission-gate` | 1.0.1, 2026-08-30 | MIT | 35.2 kB, 729 lines | `shell-quote` ^1.10.0 | `skibum1869/pi-extensions`: **404** |
| `pi-permission-suite` | 0.2.3, 2026-07-11 | MIT | 70.6 kB, 1,734 lines | `tree-sitter-bash` ^0.25.1 (native install script), `web-tree-sitter` ^0.26.9 | `Eddie0521/pi-permission-suite`, 3, 2026-07-11 |
| `@rhedbull/pi-permissions` | 1.1.0, 2026-02-27 | MIT | 24.4 kB, 449 lines | none; peer `@mariozechner/pi-coding-agent` >=0.51.0 | `rHedBull/pi-permissions`, 6, 2026-03-29 |
| `pi-ask-permission` | 3.0.0, 2026-09-30 | MIT | 292 kB, 54 files | `shell-quote` ^1.10.0; peers `pi-ai`, `pi-tui` | `felipeadeildo/pi-ask-permission`, 10, 2026-11-17 |

**Bash parsers.** Each was installed into a scratch directory with
`bun add --ignore-scripts` and run from Bun 1.4.4.

| Package | Version, published | License | Size | What it is | Repo, stars, last push |
|---|---|---|---|---|---|
| `web-tree-sitter` + `tree-sitter-bash` | 0.27.2 (2026-11-07) + 0.25.1 (2025-12-02) | MIT | 211 kB + 1.36 MB of wasm (the `tree-sitter-bash` package is 20 MB unpacked, mostly C sources) | tree-sitter runtime and bash grammar, as wasm | `tree-sitter/tree-sitter-bash`, 336, 2026-09-13 |
| `unbash` | 6.0.4, 2026-11-07 | ISC | 488 kB, no deps | a bash 5.3 parser in TypeScript | `webpro-nl/unbash`, 147, 2026-11-07 |
| `sh-syntax` | 0.8.7, 2026-11-15 | MIT (wraps `mvdan/sh`, BSD-3-Clause) | 4.1 MB wasm (Go) | mvdan/sh compiled to wasm | `un-ts/sh-syntax`, 73, 2026-11-15 (`mvdan/sh`: 9,205, 2026-11-17) |
| `bash-parser` | 0.5.0, **2017-06-22** | MIT | 12 deps (`babylon` 6, ...) | an old POSIX parser | `vorpaljs/bash-parser`, 230, 2024-06-23 |
| `shell-quote` | 1.12.0, 2026-10-02 | MIT | 26 kB | a tokenizer, not a parser | `ljharb/shell-quote`, 68, 2026-10-02 |

`mvdan-sh` (npm, the GopherJS build) is deprecated in favour of the wasm builds
(`npm view mvdan-sh deprecated`: "See mvdan/sh#1145"), so it was not run.

**Bifrost.** The repo is `maximhq/bifrost`: Apache-2.0 (`LICENSE`), 9,678
stars, last push 2026-11-17. The gateway release is `transports/v2.5.1` (tag
commit `7cb75fb2`, 2026-11-10), and `https://getbifrost.ai/latest-release`
names v2.5.1 as the latest. The binary run here is
`downloads.getmaxim.ai/bifrost/v2.5.1/linux/amd64/bifrost-http`: 145.6 MB,
static, sha256 `2b629808…4c0734`, which matches the `.sha256` file on the same
host. The Docker image is `maximhq/bifrost:v2.5.1`, digest
`sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8`
(Docker Hub API). The npm launcher `@maximhq/bifrost@1.6.3` is 13 kB and has no
deps. Docs read: `docs/features/governance/virtual-keys.mdx` and
`budget-and-limits.mdx`. Code read: `transports/config.schema.json`,
`transports/bifrost-http/handlers/{governance,logging}.go` (routes only).

**Not verified:**
- Bifrost with a streaming response. The probe's fake provider only answers
  non-streaming calls, so it is not known whether budget accounting under
  streaming matches.
- Bifrost's Anthropic-format endpoints.
- What Bifrost's `telemetry` plugin sends. Its `/metrics` answered 401
  behind admin auth, which suggests local Prometheus, but the code was not
  read.
- How the admin API shows a stored provider key.
- The Docker image itself. Docker is not available here (repo rule 1).

**Clean room.** This doc describes mechanisms in our own words. Nothing from
these packages is copied into Hearth. An idea taken from one is credited in the
DECISIONS entry of the issue that builds it.

## Summary

1. **Access mode: write Hearth's own small `tool_call` gate. Adopt none of the
   five packages, and vendor none of their rule engines.** None can be driven
   from the hub without faking pi's TUI dialog API. Each reads its config from
   `~/.pi` on the host. Two make calls off the hub: one spawns a `pi`
   subprocess as an LLM "approver", the other has an optional hosted judge.
   One targets the frozen `@mariozechner` package name. And their command
   matchers are either a scanner or `shell-quote`, which missed 10 of the 36
   hostile samples. Two ideas are worth crediting: deny, then ask, then allow,
   with the most restrictive result winning (`@pi-kit/permissions`), and
   `@skibum1869/pi-permission-gate`'s written inventory of destructive
   commands as a seed for the default list.
2. **Bash parsing (#69): `unbash` 6.0.4** (ISC, pure TypeScript, no deps,
   sync, 0.08 ms for a typical command). Hearth puts a small policy layer on
   top: unwrap `sudo`/`env`/`timeout`, re-parse `bash -c` and `eval`, and ask
   for any non-literal command name, alias, parse error or nesting deeper than
   3. `unbash`, `tree-sitter-bash` and `sh-syntax` all scored 36 out of 36 on
   the hostile set. `unbash` wins on size and supply chain. Its one trap: nested
   scripts are lazy fields, so a plain object walk misses `$(...)` (7 misses
   in the first run). Only its `forEachChild` visitor sees them.
   `tree-sitter-bash` is the fallback behind the same interface.
   `shell-quote` and `bash-parser` are out.
3. **Approvals: the gate awaits a hub-side approval record.** The pending
   approval is an event. A timeout or an abort denies. A hub restart turns a
   pending approval into a visible "denied: the hub restarted before a
   decision, not run", not "outcome unknown". The card is a branch of the
   existing `ToolFallback` card with two shadcn Buttons, so CSP is unchanged.
   The lifecycle (#71) is a state machine with no web types in it. Every
   `tool_call` trajectory record gains `access_mode` and an `approval` object,
   as added fields under schema `/2`.
4. **Bifrost v2.5.1 does what §6.4 needs, verified from Bun with `fetch`.**
   That covers one virtual key (VK) per session with a budget, rate limit and
   model allowlist; a model switch by `PUT`; rotate (the old value gets 401 at
   once); deactivate; and delete. Spend came from `/api/logs/stats?virtual_key_ids=`,
   and $1.59 equals the sum of the rows. Over budget is HTTP 402
   `budget_exceeded`. Usage survived a Bifrost restart. Two caveats: the call
   that crosses the budget is allowed (it overshoots by one call), and usage
   and logs reach the database in batches (about 5-10 s).
5. **Fits the existing decisions without a PRD change, so no decision entry.**
   The gate is a Hearth built-in on the `tool_call` hook that already exists
   (`apps/hub/src/runner/tools.ts:342`). A VK value is never stored: the hub
   keeps only its id and rotates on every runner build.

---

## What Hearth has today

- `hearth-tools` registers the routed tools and one `tool_call` handler.
  The handler rewrites `~` and applies the config deny-list
  (`apps/hub/src/runner/tools.ts:342-351`). The deny-list is "best-effort, not
  a boundary": a regex over the raw command (`apps/hub/src/runner/policy.ts:7-12`,
  DECISIONS 0015).
- The runner loads no extension that is not on an allowlist (empty by default)
  and reserves its own names (`apps/hub/src/runner/extensions.ts:30-31`, #56).
- A restart rebuilds the runner from the event log and gives an unfinished
  tool call "outcome unknown, not re-run" (DECISIONS 0015, 0027).
- Model settings switch per turn (0038). `bash` may carry `env` vault refs
  (0041), and `browser_fill` may carry vault refs (0039).

## Questions from the issue, answered

### 1. Access mode on pi

**What pi gives us.** `tool_call` fires before a tool executes and can block it:
`{ block: true, reason?, terminate? }` (`docs/extensions.md:973-990`). Related
behaviour from the same file:
- An exception in a `tool_call` handler blocks the call, so the hook fails
  safe (`docs/extensions.md:3253`).
- In parallel mode, sibling calls are *preflighted sequentially* and then run
  concurrently (`docs/extensions.md:979`). A handler that awaits therefore
  holds back the siblings' preflight too.
- Calls nested inside `codemode` also go through `tool_call`
  (`docs/extensions.md:2794`), so the gate covers codemode with no extra work.

The examples `permission-gate.ts`, `confirm-destructive.ts` and
`protected-paths.ts` are 20 to 40 lines each. They match a regex and call
`ctx.ui.select`/`confirm`. Without a UI they block (`permission-gate.ts`:
`if (!ctx.hasUI) return { block: true, ... }`). `timed-confirm.ts` shows
`ctx.ui.confirm(..., { timeout })` and an `AbortSignal`. `ctx.hasUI` is false
in print and JSON mode (`docs/extensions.md:3262-3269`). In the SDK, a host can
pass its own `uiContext` to `session.bindExtensions(...)`
(`dist/core/agent-session.d.ts:168-175`). That is the only way a third-party
package's `ctx.ui.select` could reach the web. It would give us a TUI prompt
string, not structured data for a card.

**The five packages, read in full:**

| Package | Rule engine | Bash matching | Driven from the hub? | Off-hub effects | Verdict |
|---|---|---|---|---|---|
| `@pi-kit/permissions` | deny > ask > allow globs over tools, bash and paths, plus an `outsideCwd` dimension (`src/decide.ts`); clean and small | a scanner: "not a parser … `$(...)`, backticks, braces and heredocs are not tracked" (`src/match/command.ts:3-11`) | no: `ctx.ui.select`; headless means `headlessAsk: "deny"` (`extensions/index.ts:132-137`, `src/config/defaults.ts`) | reads `~/.pi/agent` and project config | the best of the five; credit the ordering idea |
| `@skibum1869/pi-permission-gate` | a fixed severity inventory (high/medium) in code | `shell-quote` tokens split on `&&`, `\|\|`, `;` (`src/analyze.ts:1-13`) | no: `ctx.ui.select`, `ctx.ui.theme` | reads `PI_CODING_AGENT_DIR` or `~/.pi/agent` (`src/index.ts:196`); its source repo is gone (404) | credit the inventory as a seed list only |
| `pi-permission-suite` | wildcard rules plus an "auto approver" | tree-sitter-bash, but "falls back to simple string splitting when tree-sitter is unavailable" (`bash-parser.ts:10`) | no: `ctx.ui.select` | **spawns `pi` as a subprocess LLM approver** (`subprocess-runner.ts:66`, `approver.ts`); writes config into `~/.pi/agent/extensions` (`config-loader.ts:39,68,81`) | no |
| `@rhedbull/pi-permissions` | modes and globs in one file | regex | no: `ctx.ui.select` | imports `@mariozechner/pi-coding-agent` (`extensions/index.ts:29`), the frozen name PRD §8.4 forbids | no |
| `pi-ask-permission` | rich, but TUI-centred (`ctx.ui.custom`, `onTerminalInput`) | `shell-quote` plus a 689-line read-only-command list | partly: a "no UI" mode allows or blocks (`src/pi/events.ts:117-120`) | an optional LLM judge, off by default, whose default provider posts tool calls to `https://api.typesafe.ai/v1` (`src/core/judge/backends/jev.ts:14`, `judge/config.ts:35`); writes an "always yes" file | no |

**Supply chain.** The runner is in the hub, and the hub holds the vault key and
the Docker socket (#56). Any of these packages would run with that power, and
updates come from single maintainers. Each is small enough to read, but none
does the hub-specific parts: a web card, an event-log record, a
restart-safe pending state, a mode from Settings, and an audit entry. Those
are most of the work.

**Recommendation: a small Hearth gate, built in (not a package).** It is
registered by the runner next to `hearth-tools`, under a reserved name, so
#56's allowlist does not apply. It is loaded only when the mode in force is
`ask`. For `yolo`, Hearth's existing `tool_call` handler still records the mode
(question 3). About 200 lines plus the parser:

1. Classify the call: `bash` through the parser (question 2); path tools
   through the existing normalized-path rules (0015); `browser_*` by tool name
   and, for navigation, by URL pattern ("payment page"). A call that uses a
   marked secret is risky in `ask` mode: `bash` with `env` vault refs (0041)
   and `browser_fill` with vault refs (0039).
2. Rules are `{ tool, command?, args?, path?, url?, action: deny | ask }`.
   The most restrictive result wins, as #69 says. `deny` stays a block with no
   card. The default list for a new install comes from PRD §6.5 and #69,
   seeded with `@skibum1869`'s inventory, credited.
3. `ask` awaits the approval record of question 3.

### 2. Bash parsing for the deny-list (#69)

**The probe.** There was one shared policy layer, the part Hearth writes
whichever parser it picks. Each parser got a small adapter that returns simple
commands as word lists, with `null` for a word that is not a literal. The
policy layer:
- strips the wrappers `sudo`, `env`, `nohup`, `timeout`, `command`, `exec`,
  `nice`, `time`, `xargs`, `builtin` and `stdbuf`, with their flags, `VAR=x`
  and durations;
- re-parses `bash|sh|zsh|dash|ksh -c '<literal>'` and `eval`/`source <literal>`
  up to depth 3;
- asks for: a non-literal command name, an `alias`, a shell without `-c`, a
  parse error, or depth over 3;
- then applies two rules, `git push` (after git's global options such as `-C`)
  and `rm` with `-r`/`-f`.

There were 36 samples, each expecting `ask` or `allow`. Run with
`timeout 300 bun harness.ts`:

| Sample group | Examples |
|---|---|
| lists and pipes | `make && git push`, `ls \| xargs rm -rf`, `git push &` |
| nesting | `(cd /tmp; rm -rf build)`, `{ git push; }`, `echo $(git push --force)`, `` echo `rm -rf /` ``, `"${x:-$(git push)}"`, `diff <(git push) /dev/null`, `[[ -n $(rm -rf /) ]]`, `a=$(git push)` |
| heredocs | `cat <<EOF` with `$(rm -rf /)` inside (ask), and the same with `<<'EOF'` (allow: no expansion) |
| indirection | `eval "git push"`, `bash -c 'git push --force'`, `sh -c "bash -c 'rm -rf /'"`, `X=rm; $X -rf /`, `alias g=git; g push`, `$'\x67it' push`, `f() { git push; }; f` |
| spelling | `g"i"t pu'sh'`, `\rm -rf /`, `git -C /repo push`, `GIT_SSH_COMMAND=x git push`, `env -i FOO=1 git push`, `sudo timeout 5 git push` |
| control flow | `if true; then git push; fi`, `for d in a b; do rm -rf $d; done` |
| must stay quiet | `echo "rm -rf / and git push"`, `ls # rm -rf /`, `git status && git log -1`, `grep -r push src/` |
| malformed | `echo "oops`, `git status )`, and 3,000 nested `$(` |

Results (Bun 1.4.4, one core):

| Parser | As expected | Typical command | 3,000-deep `$(` | Notes |
|---|---|---|---|---|
| `tree-sitter-bash` (web-tree-sitter) | **36/36** | 0.10-0.16 ms | ask (error nodes), 33-55 ms | async `Parser.init()` once, then sync. A parse error shows as `ERROR`/`MISSING` nodes, so the check is `rootNode.hasError`. |
| `unbash` | **36/36** | 0.08-0.17 ms | ask ("maximum command substitution nesting depth exceeded"), 1-226 ms | Sync, typed AST. Tolerant: returns a partial tree plus `errors`, and **a nested script has its own `errors`**. The first run, which walked object fields, scored 29/36: every `$(...)`, backtick, process substitution and heredoc command was missed, because a substitution's `script` is a lazy prototype getter. Only `forEachChild` resolves it (README "Visit"). |
| `sh-syntax` (mvdan/sh) | **36/36** | 0.6 ms | ask, 56-65 ms | async API (a sync entry exists), 4.1 MB Go wasm. The most mature grammar of the three. |
| `bash-parser` | 35/36 | 0.8-1.2 ms | ask | Runs a quoted heredoc's body as a command (a false "ask"). Unmaintained since 2017, 12 old deps. |
| `shell-quote` | 26/36 | 0.02 ms | **allow** | Flat tokens. Misses backticks, `${:-$(...)}`, brace groups, `if`/`for`/functions, and `$X` as a name, and accepts unterminated quotes. Not a parser. |

**Recommendation: `unbash` behind a Hearth interface**
(`extractCommands(src): { commands: Word[][] } | { error }`), with:
- `forEachChild` as the only traversal, and an error check on every node that
  has `errors`;
- a cap on input length (for example 64 KiB, above which it asks) next to the
  parser's own depth cap;
- the hostile set above as the #69 test table, with an `unbash` test that
  fails if a nested `$(...)` is not seen, guarding against the lazy-field trap
  after an upgrade.

Why `unbash` and not `tree-sitter-bash`: both are correct here. `unbash` is one
readable TypeScript package with no deps, no wasm and no install script. The
`tree-sitter-bash` npm package declares a `node-gyp-build` install script (Bun
blocks it; only the wasm is needed). Its grammar's last release was 2025-12.
`unbash` is younger, with one main maintainer. If it stalls, `tree-sitter-bash`
drops in behind the same interface, and the same test table proves the swap.
`sh-syntax` is the best grammar, but a 4 MB Go-wasm blob in the hub is harder
to review than either.

**Known gaps, whatever the parser.** These are listed in #69 and the DECISIONS
entry:
- interpreters: `python -c`, `node -e`, `perl -e`;
- `find -exec`, and `trap '<string>'`;
- a git alias set in the box (`git config alias.p push; git p`);
- a script written and then run (`./x.sh`);
- the network: `curl` to a forge API does what `git push` does.

The parser makes the rules match what bash will run. It does not make the
deny-list a boundary. The box stays the boundary (0015).

### 3. Approval flow

**Lifecycle (channel-neutral, #71).** These are hub events, written before they
take effect (§10):

```
approval.requested {approvalId, toolCallId, tool, summary, rule, mode, expiresAt}
   ├─ approval.decided {approvalId, decision: approve|deny, by: owner, channel: "web"}
   ├─ approval.expired {approvalId}          # timeout: deny
   ├─ approval.cancelled {approvalId, why}   # abort, new user message, session stop
   └─ approval.interrupted {approvalId}      # hub restart: deny, call not run
```

- **Wait.** The gate's `tool_call` handler creates the record and awaits a
  promise in the session manager. One of these resolves it: a decision, the
  timeout (default 10 minutes, a setting), `ctx.signal` (stop), or a new user
  message (#71: rejects the pending batch and queues the message). All except
  approve return `{ block: true, reason }`, with reasons such as "denied by the
  owner", "no decision within 10 min" or "cancelled: new message". pi turns
  that into the tool error the model sees, so the turn says so.
- **Batch.** Siblings are preflighted one at a time (question 1). At most one
  card is pending, and the next appears when it resolves, which meets #71's
  "one pending batch per session". To show all risky siblings on one card, the
  gate can read the current assistant message from `ctx.sessionManager`, which
  is synchronized through that message (`docs/extensions.md:977`). That is
  optional.
- **Clocks.** Waiting for the owner is neither tool silence nor model silence.
  Like the lock wait (§8.3), it pauses the turn's clocks and the no-progress
  sweep (§8.1).
- **Hub restart.** The promise dies with the process. On rebuild (0015), a
  call whose last approval event is `requested` gets `approval.interrupted`
  and the tool result "denied: the hub restarted before a decision; the
  command was not run". This is principle 7, and it is more precise than the
  generic "outcome unknown", because nothing reached the box. A new turn asks
  again if the model retries.
- **Runner rebuild between turns** (a model switch, 0038). No approval can be
  pending between turns, so there is nothing to carry.
- **Box rebuild.** The box is not involved until approval. An approved call
  then takes the usual `ensureBox` lease and refuses as usual. The desktop
  lock (0035) is checked at execute, after approval.
- **Authorization.** `POST /v1/sessions/:id/approvals/:approvalId
  {decision}` is authorized as `session.approve` against the session's
  workspace (0022). Only the owner can decide. An unknown id, another
  session's id and an already-decided id get the same 404/409 shape (the
  same-answer rule). The web polls the event log as today (0017).

**Card.** This is a branch of the existing `ToolFallback` card in
`apps/web/src/Thread.tsx`, shown while the tool call has an open
`approval.requested`. It has:
- the summary (for `bash`, the parsed sub-command that matched, highlighted
  in the full command);
- the rule;
- the time left;
- Approve/Deny as shadcn `Button`s.

There is no portal, dialog or inline style, so the CSP stays as 0038 left it.
After a decision the card shows who decided and when, and an expired card says
so (#71).

**Trajectory.** Every `tool_call` record gains `access_mode: "yolo" | "ask"`
(the mode in force when the call was preflighted) and, when gated,
`approval: {id, rule, decision, decided_by, waited_ms}`. These are added
fields, so the schema stays `hearth.trajectory/2`, the precedent of 0037. In
`yolo`, the existing `tool_call` handler records the mode, so both modes leave
the field (S3 checks it). A mode change, global or per session, writes an
audit row and a `session.access_mode` event. The mode is read once per tool
call, so a change mid-turn applies to the next call.

### 4. Models with budgets through Bifrost

**Run here.** Bifrost v2.5.1 ran on loopback with SQLite config and log
stores, `enforce_auth_on_inference: true`, admin basic auth,
`disable_content_logging: true` and `allow_direct_keys: false`. Its `openai`
provider pointed at a 20-line Bun fake that returns fixed usage (100k input
and 50k output tokens). The hub-side calls were made with `fetch` from Bun.

| Step | Result |
|---|---|
| Admin API without credentials | 401 |
| `POST /api/governance/virtual-keys` `{provider_configs:[{provider:"openai", allowed_models:["gpt-4o-mini"], key_ids:["*"]}], budgets:[{max_limit:0.05, reset_duration:"1Y"}], rate_limit:{request_max_limit:50, request_reset_duration:"1m"}}` | 200; value `sk-bf-…`, id a UUID |
| Inference with no key | 401 `virtual_key_required` |
| Allowed model with `Authorization: Bearer sk-bf-…` | 200. The fake provider saw only the provider key, never the VK. |
| Model not on the allowlist | 403 `model_blocked`: "Model 'gpt-4o' is not allowed for virtual key 'session-s1'" |
| Third call after 2 × $0.045 | **402 `budget_exceeded`**: "Budget exceeded: vk_model_config * budget exceeded: 0.0900 >= 0.0500 dollars" |
| `GET /api/governance/virtual-keys/{id}` right after | `current_usage: 0`; 12 s later `0.09` (flushed in batches) |
| Bifrost restarted, same key | usage `0.09`, call refused 402 |
| `PUT …/{id}` `{provider_configs:[… allowed_models:["gpt-4o"]]}` (model switch) | new model 200, old model 403 |
| `PUT …/{id}` `{budgets:[{max_limit:100, …}]}` | 200; spending resumes |
| `POST …/{id}/rotate` | new value; **old value 401 at once** (`vk_rotation_cooldown` defaults to none), new 200 |
| `PUT …/{id}` `{is_active:false}` | 403 `virtual key is inactive` |
| `DELETE …/{id}` | 401 `access_not_found` |
| `GET /api/logs/stats?virtual_key_ids={id}` (after delete) | 8 requests, 600k tokens, **total_cost 1.59** = 2 × 0.045 + 2 × 0.75, the sum of the success rows of `GET /api/logs`; rows survive key deletion |
| `GET /api/governance/virtual-keys/quota` with the VK itself | the key's budgets and limits (a key can read its own quota) |

Prices come from Bifrost's own model catalog, synced from a URL at start and
every 24 h (`pricing_config.pricing_url`, `governance.pricing_overrides`). The
logs carry `x-bf-session-id`, but `/api/logs/sessions/{id}/summary` returned
0 rows in the probe, so Hearth keys spend on the VK id (one per session)
instead.

**Recommendation.**
- **Deploy.** `maximhq/bifrost:v2.5.1`, pinned by digest (the `pins` check),
  on the internal compose network only, with no published port. Use the
  config in the table: admin auth on, auth on inference, direct keys off,
  content logging off. No prompt text is kept in Bifrost; the hub's
  trajectory is the record. Use SQLite volumes. Its outbound traffic is the
  providers plus the pricing sync and an MCP library fetch from
  `getbifrost.ai`. Pin `pricing_url` or accept it, and say so in
  `install.md`. Do not use the npx launcher: it fetches "latest" by default
  and checks no checksum.
- **Keys.** Provider keys stay vault entries (0031, 0038). On a change the
  hub pushes them to Bifrost through `POST/PUT /api/providers/{p}/keys`, so
  they never enter a box or the compose file. The Bifrost admin password is a
  vault entry made at install, written into Bifrost's config secret. Bifrost
  stores provider keys encrypted with its own `encryption_key`, which is also
  generated at install.
- **Per session.** On the session's first model call, `POST` a VK with the
  session's model allowlist (always an explicit list: Bifrost's docs say an
  empty `key_ids` denies all keys, and the probe did not check an empty
  `allowed_models`), its budget and its rate limit. The
  hub stores **only the VK id**. On every runner build (hub restart or model
  switch) it calls `rotate` and keeps the new value in the runner's memory
  (`setRuntimeApiKey` for a custom OpenAI-compatible provider whose base URL
  is Bifrost). The value never reaches the event log, a file or a box. A model
  switch is a `PUT` of the allowlist. Archive deactivates the VK; delete
  deletes it, and the logs stay for Retro.
- **Spend.** The UI reads `GET /api/logs/stats?virtual_key_ids=<id>` (and
  `/api/logs` for rows) through the hub, cached and refreshed after each turn.
  Writes arrive in batches, about 5 s for logs and about 10 s for budgets, so
  the S3 check waits for the batch before it compares.
- **Over budget.** A 402 `budget_exceeded` (or a rate-limit refusal, not probed here) is
  classified `gateway`, not retried and not given a fallback model (§8.1, principle 2).
  The turn ends with a visible message naming the budget and the spend, which
  is the exit criterion. The call that crosses the budget is allowed, so the UI
  says "budget reached" once spend is at or over the budget, and the doc says
  the overshoot is at most one call.

### 5. Fit with existing decisions

| Decision | Fit |
|---|---|
| 0011 tool RPC | The gate decides before the RPC, so a denied or expired call never reaches the box. No protocol change. |
| 0015 runner, deny-list, allowlist | The gate replaces the regex deny-list for `bash` with parsed rules. Path rules stay. It is a built-in under a reserved name (#56). Restart adds `approval.interrupted` next to outcome-unknown. |
| 0021 / 0037 trajectories | `access_mode` and `approval` are added fields under `/2`. |
| 0031 vault | Provider keys and the Bifrost admin password are vault entries. A VK value is not stored at all (rotate per runner build). |
| 0035 desktop lock | Checked after approval, at execute. A browser call waiting for approval does not hold or queue the lock. |
| 0038 settings | Global access mode next to the model card. The provider pick becomes "through Bifrost" when Bifrost is configured. The per-turn switch maps to a VK `PUT`. The CSP is unchanged. |
| 0041 box-env | A `bash` call with `env` vault refs is "uses a marked secret": in `ask` mode it is approved before decrypt, which keeps 0041's "refused before decrypt" order. |
| #56 allowlist | No third-party permission package is loaded. |

## Threat notes

- **The deny-list is still not a boundary.** It is about intent ("do not push
  without me"). It is not about containment, which is the box's job (0015).
  The known gaps in question 2 stay documented.
- **The approval endpoint is a privilege boundary.** An approval moves a call
  from "stopped" to "runs with the box's network". The route is behind the
  login guard, `authorize`, Origin/Host checks (0010) and the same-answer
  rule. Its decision is audited before it applies.
- **Card spoofing.** The summary is built from the parsed command, not from
  model text. The model cannot add a label that makes `git push --force` read
  as harmless. The full raw command is always shown under it.
- **Prompt-injected repetition.** A denied call that the model retries makes a
  new card. #71's "one pending batch" bounds this. The rate is visible in the
  trajectory. Do not add "approve all for this session"; the owner switches
  the session to `yolo` instead.
- **Bifrost in the trust base.** It holds the provider keys and sees every
  prompt in transit. Pinned digest, internal network only, content logging
  off, admin auth from the vault. Its admin API must never be reachable from
  a box: issue 4 checks that the box egress allow list (0012, 0023) does not
  cover Bifrost's address.
- **VK leakage.** A VK only works on the internal network and only within its
  budget and allowlist. It is rotated on every runner build and revoked on
  archive.

## Proposed follow-up issues

The orchestrator opens these. Existing issues are updated rather than
duplicated.

1. **#69 (existing): parse bash commands with `unbash`.** Build the
   `extractCommands` interface, the policy layer above and the 36-sample table
   as tests, plus the lazy-field guard test and the input cap. Rules become
   `{tool, command, args, action}`. Credit stakpak/agent (the idea of #69) and
   `@pi-kit/permissions` (the deny > ask > allow order).
2. **hub+web: access mode setting.** A global default (`ask` on a new
   install) and a per-session override, shown on the session. An audit row
   and a `session.access_mode` event per change. `access_mode` on every
   `tool_call` trajectory record. API and dom tests.
3. **hub+web: the `ask` gate and approval cards (with #71).** The built-in
   gate, the `approval.*` events, the timeout, cancel on a new message or
   stop, `approval.interrupted` on restart, paused turn clocks, the approve
   route, and the `ToolFallback` branch. Includes the S3 e2e (web only,
   `git push` approved, a second one expired, `yolo` runs at once).
4. **deploy+hub: Bifrost service.** Compose service pinned by digest on the
   internal network, a generated admin password and `encryption_key` in the
   vault, provider keys pushed from the vault, `install.md` (egress for the
   pricing sync), and a hub health check. Tests run against the binary with a
   fake provider. The Docker part is gated by `HEARTH_DOCKER_TESTS=1`.
5. **hub+web: per-session virtual keys and spend.** Create on first model
   call, rotate per runner build, `PUT` on model switch, deactivate on
   archive, delete on delete. Spend and tokens from `/api/logs/stats`. A 402
   ends the turn visibly. Exit criteria: UI spend equals the request-log sum
   after the batch flush, and an over-budget session is refused with a
   message.
