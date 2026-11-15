# Research: what Hearth should adopt from stakpak/agent

> Issue #64 · 2026-11-15 · docs only, no code. Owner: @zerone0x

## Sources and how to read the citations

- **Source:** <https://github.com/stakpak/agent>, Apache-2.0, shallow clone at commit
  `760cd2b5984d29c2d513bb15ca33e995fae45f17` (committed 2026-07-06). Every
  `path:line` below is in that tree. Example:
  `libs/shared/src/secrets/mod.rs:59-169` means
  `https://github.com/stakpak/agent/blob/760cd2b/libs/shared/src/secrets/mod.rs#L59-L169`.
- **Docs:** stakpak.gitbook.io, read as Markdown (`<page>.md`) on 2026-11-15:
  [handling-secrets], [warden-guardrails], [autopilot], [rulebooks],
  [how-to-write-a-rulebook].
- **Not read, so unverified:** the Warden binary itself. The CLI downloads it as a
  plugin (`get_warden_plugin_path`, `cli/src/commands/warden.rs:166-183`); its
  source is not in this repo, so anything about Warden's policy engine comes only
  from its CLI flags and the docs. Also unverified: the stakpak.dev backend that
  stores rulebooks.
- **Clean room.** This doc describes mechanisms in our own words. No stakpak code
  is copied into Hearth. If we build one of these ideas, we build it from this
  description and credit the idea in a DECISIONS entry.

Hearth side: PRD v0.3 and DECISIONS 0009–0014 and 0016 on `main` at `1dbd0e7`,
plus open PR #63 (hub-side runner, which adds decision 0015). The web UI (#46) has
no open PR yet, so nothing of it is assumed here.

## Summary

stakpak/agent is a single Rust binary whose agent loop runs **on the user's
machine**. Its tools are reached through a local MCP proxy, and can optionally run
in a container (Warden). It has a lot in common with Hearth's brain/hands split
(decision 0009). What Hearth should take:

- **Command parsing for approvals** (Adopt). stakpak parses each shell command into
  sub-commands with a bash grammar before it matches approval rules. PR #63
  matches a regex against the raw command string. Parsing closes the `a; rm -rf x`
  and `$(...)` gaps.
- **Placeholder secret substitution at the tool boundary** (Adapt). The model sees
  `[REDACTED_SECRET:rule:id]` tokens, and the proxy swaps the real values back in
  just before a tool runs. Hearth's `tool_call` / `tool_result` hooks (0015) are the
  same choke point. But stakpak stores the token→value map in a plaintext file in
  the workspace, which the sandbox can read. Hearth must keep the map in the hub.
- **Check-script-gated triggers, doctor probes, approval cards over chat**
  (Adapt). These are good, small, operational ideas for §6.5–§6.7 and #47.
- **Warden, remote rulebooks and cloud-credential mounts** (Skip). Warden is a
  downloaded closed binary that duplicates what Hearth's box and egress firewall
  (0007, 0012) already do. Rulebooks live on a SaaS backend. And the sandbox is
  given the user's AWS, GCP and Azure credential files, which goes against PRD §10.

---

## 1. Secret Substitution

**Claim (README.md:51):** "The LLM works with your credentials without ever seeing
them." Docs: "Secrets are substituted at runtime and never exposed in logs or
memory" ([handling-secrets], line 9).

### Mechanism

It works by **detecting and replacing text, and restoring it at the tool
boundary**. There is no vault, and no network proxy is involved.

1. **Detection.** `detect_secrets` runs the gitleaks rule set over a string: regex,
   then an entropy threshold on the captured group, then allowlists, with a keyword
   pre-filter per rule (`libs/shared/src/secrets/gitleaks.rs:350-420`). The rules
   ship inside the binary: 211 gitleaks rules plus 5 of stakpak's own
   (`libs/shared/src/secrets/gitleaks.toml`, `additional_rules.toml`). An opt-in
   "privacy mode" adds rules for public IPv4/IPv6 addresses and AWS account IDs
   (`libs/shared/src/secrets/privacy_rules.toml:1-30`).
2. **Replacement.** Each match becomes a token `[REDACTED_SECRET:<rule-id>:<6 random
   chars>]` (`libs/shared/src/secrets/mod.rs:247-250`). `redact_secrets`
   (`mod.rs:59-169`) also re-redacts every value **already in the session map**
   wherever it appears, even if no rule would match it now (`mod.rs:80-104`). It
   keeps the longest of any overlapping matches (`mod.rs:112-142`) and skips text
   that is already a token (`mod.rs:11-31`, `65-71`). The same value always maps
   to the same token.
3. **Where redaction runs.**
   - On user input before it goes to the model
     (`cli/src/commands/agent/run/mode_async.rs:427`, `:479`;
     `tui/src/services/handlers/input.rs:773`, `:994`).
   - On every **text** content item of every tool result, in the host-side MCP
     proxy (`libs/mcp/proxy/src/server/mod.rs:397-412`, called at `:696`).
4. **Restoration.** Before a tool call is forwarded to the real MCP server, the
   proxy walks the whole JSON argument tree and replaces tokens with the real
   values from the map (`libs/mcp/proxy/src/server/mod.rs:327-345`). It uses a
   single forward pass, so a secret whose value contains another token is not
   expanded twice (`mod.rs:51-60`, `105-125`). So the model can write
   `curl -H "Authorization: [REDACTED_SECRET:github-pat:ab12cd]"` and the command
   runs with the real token.
5. **Generated passwords.** The output of the `generate_password` tool has no
   keyword context, so the whole output is force-redacted as a password
   (`libs/mcp/proxy/src/server/mod.rs:701-717`; `secrets/mod.rs:200-244`). The
   model can then use a password it never saw.

### Where the real values live

The map is **a plaintext JSON file**, `secrets.json`, in `./.stakpak/session/` under
the **current working directory** (`libs/shared/src/local_store.rs:6-11`, `17-40`;
`libs/shared/src/secret_manager.rs:23-57`). Every call to redact or restore reads
the whole file and rewrites it. The code itself says this is not thread-safe
(`secret_manager.rs:85`, `:101`). When Warden is on, the working directory's
`.stakpak` folder is mounted **read-write** into the sandbox
(`libs/shared/src/container.rs:47-48`).

### What the model sees

Tokens in place of matched values, in user turns and tool output. A secret that no
rule matches, and that has not been seen as a match before, reaches the model
unchanged.

### Failure modes (from reading the code; none were exercised)

| Failure | Why it happens |
|---|---|
| **Encoding bypass** | Matching is literal (`content.match_indices`, `mod.rs:91`). `base64 ~/.aws/credentials`, `xxd`, `rev`, or a JSON-escaped value does not match the stored value or the rules. The encoded secret reaches the model. |
| **Undetected formats** | Only gitleaks patterns that pass the entropy check, plus already-known values, are caught. A low-entropy password in a config file is passed through. |
| **Non-text tool output** | `redact_content` only touches text items (`proxy/server/mod.rs:400-408`). Images, such as a screenshot of a terminal, and embedded resources pass through untouched. |
| **The map is in the sandbox** | `secrets.json` sits in `./.stakpak/session`, which is mounted read-write into Warden. A command can read or change it. Reading is partly saved by step 2, because known values are re-redacted in output. But `base64 .stakpak/session/secrets.json` defeats that, and a write can point a token at a value the attacker chose. |
| **Secrets on disk** | Docs say values are never in "logs or memory". The map is unencrypted on disk for the whole session, and nothing in the code we read cleans it up afterwards. |
| **Concurrency** | Read-modify-write of one file with no lock (`secret_manager.rs:85`). Two parallel tool results can lose an entry, and its token then never restores. |
| **Echo-back** | A restored secret written into a file and read back later is re-redacted only because it is in the map. If the map entry was lost (see above), it is not. |
| **Opt-out** | `--disable-secret-redaction` (`cli/src/main.rs:154`, `:578`) turns it all off. |

### What this means for Hearth

Hearth already keeps *model* credentials out of the box (0009, PRD §6.4) and never
forwards the hub environment (0011, §8.2.1). stakpak protects something else:
**user credentials that the agent has to use** (a GitHub token pasted in chat, a
DB password in a `.env` file). That is a real Hearth use case (PRD §3), and nothing
in the PRD covers keeping such values away from the model provider. The
substitution point maps cleanly onto the runner hooks from 0015:
`tool_result` → redact, `tool_call` → restore before the RPC leaves the hub. Hearth
can do this better than stakpak: the map stays **hub-side only** (in memory, or in
the hub's SQLite through the `SecretStore`), never in `/workspace`. See follow-up
F2.

## 2. Warden

**Claim (README.md:52):** "Network-level policies block destructive operations
before they run." Docs: "a deterministic policy enforcer for every agent action. It
inspects, validates, and blocks any destructive or unauthorized operations before
they reach your environment" ([warden-guardrails], line 7).

### What the open-source repo shows

- Warden is a **separate binary**. The CLI downloads it from
  `warden-cli-releases.s3.amazonaws.com` for linux-x86_64, darwin and windows
  (`get_warden_plugin_path`, `cli/src/commands/warden.rs:166-183`). The generic
  plugin loader builds the URL (`cli/src/utils/plugins.rs:462-508`) and, if the download
  fails, falls back to an older copy in the plugins dir or one on `PATH`
  (`plugins.rs:39-151`, `318-361`). Its source is not in `stakpak/agent`.
- `warden wrap <image> -- <cmd>` runs a container image "through Warden's network
  firewall (sidecar pattern)", with Docker or Podman (`warden.rs:17-39`).
  `warden logs --blocked-only --detailed` shows stored requests, including "headers
  and bodies" (`warden.rs:41-53`). So Warden is an **HTTP(S)-level egress proxy in
  front of a container**: it records requests and blocks some of them.
  *Inference:* reading bodies of HTTPS calls means it terminates TLS, probably with
  a CA it injects into the container. Unverified.
- **Enabling it.** When a profile has `warden.enabled = true`, a top-level
  `stakpak` invocation re-executes itself inside `warden wrap ghcr.io/stakpak/agent:v<ver>`
  (`cli/src/main.rs:316-332`; `warden.rs:348-407`; image name at
  `libs/shared/src/container.rs:9-12`). The env var
  `STAKPAK_SKIP_WARDEN=1` is set inside the container to stop recursion
  (`warden.rs:379-380`). Autopilot schedules have a `--sandbox` flag
  (`cli/src/commands/autopilot/mod.rs:192-194`). The server can run a persistent
  or per-session sandbox, reached over mTLS (`libs/server/src/sandbox.rs:1-28`).
- **What the sandbox gets.** By default it mounts the stakpak config and
  `auth.toml` read-only, the local DB and knowledge store read-write, the working
  dir read-only with its `.stakpak` read-write, and the user's
  **`~/.aws`, `~/.config/gcloud` and `~/.azure` credential files**
  (`libs/shared/src/container.rs:37-67`). `STAKPAK_API_KEY` is passed as a
  `--env KEY=value` argument on the warden command line (`warden.rs:388-390`), where
  local users can see it in `ps`.

### Policy language and detection of "destructive operations"

**Unverified.** No policy file, schema or rule set for Warden is in the repo or in
the docs page. The only public details are that it is network-level (README) and
"deterministic" (docs).

The **in-repo** guard against destructive commands is a different thing: the
**tool approval policy**, which has nothing to do with Warden.

- `ToolApprovalPolicy` maps a tool name to `Approve` / `Ask` / `Deny`, ordered from
  least to most restrictive (`libs/agent-core/src/types.rs:263-280`). Defaults:
  read-only tools are approved, mutating tools (`run_command`, `create`,
  `str_replace`, …) ask, and anything unknown asks (`types.rs:90-136`).
  Unattended use takes an allowlist where everything else is denied
  (`types.rs:138-155`).
- For shell tools, the command string is **parsed with tree-sitter-bash** into
  every simple command, recursing into pipelines, `&&`/`||`/`;` lists, subshells,
  `$(...)`, backticks and `bash -c` nesting
  (`libs/shell-tool-approvals/src/parse.rs:63-111`: a stack walk visits every
  `command` node in the syntax tree, and `bash -c` / `env sh -c` / `xargs sh -c`
  scripts are queued and parsed again up to depth 5, `:87-96`, `:217-268`;
  spec in `docs/architecture-enhancements/09-hierarchical-run_command-approvals.md:46-80`).
  Rules are keys like `run_command::rm::-rf`. In one scope the most specific key
  wins, and **across the sub-commands of one script the most restrictive action
  wins** (`libs/shell-tool-approvals/src/resolver.rs:4-42`). A bare `$CMD` has no
  name and falls back to the scope rule (`resolver.rs:49-51`). If parsing fails,
  the result is at least `Ask` (`types.rs:205-217`).

### Can the agent bypass it?

- **Warden:** unverified. Two weaknesses in the host-side wiring: Warden is opt-in
  per profile, and setting `STAKPAK_SKIP_WARDEN` in the host environment skips it
  (`main.rs:317-318`). Inside the container the agent cannot reach the host, but it
  holds the mounted cloud credentials. A network policy can only see which
  endpoints are called, not whether a call is destructive, unless Warden reads
  request bodies.
- **Approvals:** the parser does not resolve variables or aliases. `X=rm; $X -rf /`
  produces a nameless command, which falls back to the generic `run_command` rule
  (normally `Ask`). That is safe only if the generic rule is not `Approve`.
  Interpreters (`python -c`, `node -e`) and scripts written to a file and then run
  are not looked into. Autopilot defaults to `pause_on_approval = false`, which
  means auto-approve (`cli/src/commands/watch/config.rs:166-168`).

### What this means for Hearth

Hearth's isolation is already stronger at the network layer: a box per session, ICC
off, egress only to the internet and the hub (0007, 0012, #58), and no
credentials in the box. Warden adds nothing Hearth lacks, except request logging.
**The approval parser is the part worth adopting**: PR #63's deny-list tests a
regex against the whole command string (`apps/hub/src/runner/policy.ts`, `DenyRule`
on the PR branch), so `ls; rm -rf x` versus a `^rm` rule, or `echo $(rm -rf x)`,
are matched only as well as the regex happens to allow. See F1.

## 3. Autopilot

### Process model and supervision

- `stakpak up` / `down` / `status` / `logs` / `restart` / `schedule` / `channel` /
  `doctor` (`cli/src/commands/autopilot/mod.rs:76-132`; README.md:57-76).
- `up` installs an **OS user service** and lets the OS supervise it. On Linux this
  is a systemd user unit with `Type=simple`, `Restart=on-failure`, `RestartSec=5`,
  stdout and stderr appended to log files, and `WantedBy=default.target`
  (`autopilot/mod.rs:4136-4196`, unit text at `:4172`). On macOS it is a launchd
  agent (`:4230-4316`). `--foreground` skips the service.
- One process runs everything: the embedded HTTP server, the chat gateway
  (`:1416`) and the scheduler task (`:1506`) are tokio tasks in
  `start_foreground_runtime` (`:1125`). If one crashes, the whole service restarts.
- A **PID file** stops a second instance (`cli/src/commands/watch/commands/run.rs:70-82`).
  After a crash, runs left as `running` are marked `failed` with a reason
  (`run.rs:112-118`; `watch/db.rs:507-520`).

### How it watches apps: check scripts

A schedule is cron + prompt + an optional **check script**. The scheduler is
`tokio-cron-scheduler` with 5-field cron (`watch/scheduler.rs:1-20`). When it fires:

1. If the schedule already has a run in progress, the new one is skipped and the
   skip is logged (`run.rs:558-575`). As read, this is a read check
   (`has_running_run`), not a conditional claim.
2. The check script runs with a timeout (default 30 s, `watch/config.rs:162-164`).
   It must be executable. Its stdout, stderr, exit code and a timed-out flag are
   kept (`watch/executor.rs:110-220`). On timeout the child is killed through
   `kill_on_drop` (`executor.rs:82`, `:188`), which kills **only the direct
   child**, not its process group.
3. The agent is woken only if the exit code matches `trigger_on`: `failure`
   (default, non-zero), `success` or `any` (`watch/config.rs:66-86`). So a cheap
   shell check filters out most ticks without any model call.
4. The prompt is put together from the schedule prompt plus the check output
   (`watch/prompt.rs`, `assemble_prompt`; not read line by line).

### State and history

A local SQLite (libsql) DB (`watch/db.rs:3`, `:137`) with:

- `trigger_runs`: name, start and finish times, check exit code, stdout, stderr,
  timed-out flag, whether the agent was woken, session and checkpoint ids, agent
  stdout and stderr, status, error.
- `autopilot_state`: a singleton row with pid and heartbeat.
- `pending_triggers`: manual "run now" requests.

(`watch/db.rs:178-240`.) Schema migrations are `ALTER TABLE … ADD COLUMN` calls
whose errors are ignored (`db.rs:203-215`).

### What `doctor` checks

`run_autopilot_probes` (`cli/src/commands/autopilot/probes.rs:221-274`). Each probe
has an id, a severity (blocking or not), a status (pass, warn, fail or skip), a
summary and a remediation command:

- model or API credentials present (`:276`)
- Docker installed (`:313`), and the daemon reachable by this user (`:358`),
  skipped with a reason if Docker is missing
- Docker usable from the systemd user service (`:564`)
- memory, with 2 GB+ recommended (`:413`; [autopilot] lines 43-46)
- bind port free, or already held by the running server (`:514`)
- **systemd linger**, so user services survive logout, with the remediation
  `sudo loginctl enable-linger <user>` (`:636-703`)
- doctor only: disk headroom in `$HOME` (`:705`) and sandbox mount inputs, meaning
  the host paths that Warden will mount (`:773`)

The same probes run at startup in `Startup` mode (`autopilot/mod.rs:827`) and on
demand in `Doctor` mode (`:3375`).

### What this means for Hearth

Hearth's triggers (§6.7) and reliability principles (§8.1, principle 7) already
cover skip-if-running, persisting interrupted runs and trigger history. **New
ideas:** the check-script gate (F4) and a probe-based `doctor` that also runs as a
startup preflight (F5). PRD §10 already has a startup preflight for secret
references, and F5 extends it. Leave out: stakpak's process model (a host user
service). Hearth is a compose deployment (#47), where Docker's
`restart: unless-stopped` does the supervising.

## 4. Rulebooks

- **Format.** Markdown with YAML front matter: `uri` (for example
  `stakpak://my-org/deployment-guide.md`), `description` and `tags`
  ([how-to-write-a-rulebook], lines 22-39). The client model is
  `{id, uri, description, content, visibility: PUBLIC|PRIVATE, tags, created_at, updated_at}`
  (`libs/api/src/models.rs:398-416`, list form `:460-469`).
- **Storage and curation.** On the stakpak.dev backend: `GET {base}/v1/rules`
  lists them (`libs/api/src/stakpak/client.rs:246-266`), and they are created at
  stakpak.dev ([rulebooks], line 31). "Official" rulebooks are written by the
  stakpak team, and "your" rulebooks by the user's org ([rulebooks], lines 11-26).
  **Versioning:** the client sees only `created_at` / `updated_at`. No version
  field or pinning is visible, so versioning on the backend is unverified.
- **Selection.** Config filters in `~/.stakpak/config.toml`: include and exclude
  URI globs, include and exclude tags (`cli/src/config/rulebook.rs:6-80`), and a
  per-session picker in the TUI ([rulebooks], lines 37-45).
  `--disable-official-rulebooks` turns off the official set ([rulebooks], line 32).
- **Injection.** A rulebook becomes a `Skill` with a remote source
  (`models.rs:355-395`). Local `SKILL.md` folders are found the same way
  (`libs/api/src/local/skills/mod.rs:7-40`). Only **metadata** (the one-line
  description) goes into context, as an `<available_skills>` block added to the
  first user message (`cli/src/utils/agent_context.rs:42-96`). The body is fetched
  on demand by the `load_skill` tool (`libs/mcp/server/src/remote_tools.rs:348-407`),
  which is auto-approved (`libs/agent-core/src/types.rs:95`). The docs
  say tags are what "the agent uses to decide when to pull the rule book"
  ([how-to-write-a-rulebook], line 23).

### What this means for Hearth

The **progressive disclosure** pattern fits Hearth's Lessons (§6.8) and open
question 9 (context files and skills on the hub): inject a short index of accepted
lessons (scope, one-line summary), and let the model load a full lesson with a
hub-only tool. That keeps the context small however many lessons pile up. The SaaS
store and official-rulebook catalogue are out of scope for a self-hosted product.
See F6.

## 5. Architecture

- **Where the agent loop runs.** In the local `stakpak` process (CLI, TUI or the
  autopilot service). `libs/agent-core` holds the loop and the approval policy
  (`libs/agent-core/src/types.rs`). It is not remote. *Unverified:* whether some
  modes route model calls through the stakpak API by default. A `stakpak` provider
  exists next to the direct ones (`libs/ai/src/providers/`: anthropic, bedrock,
  copilot, gemini, openai, openrouter, stakpak).
- **Tools.** Everything goes through an MCP **proxy** that combines several MCP
  servers (stakpak's own local tools plus user-configured ones) and names tools
  `client__tool` (`libs/mcp/proxy/src/server/mod.rs:655-680`). The proxy is the
  choke point for secret substitution (§1 above). Stdio MCP servers get their
  stderr logged under `~/.stakpak/logs/mcp-<name>.log` (`proxy/server/mod.rs:420-440`).
- **Sandboxing.** Off by default. With sandboxing on, the tool server
  (`stakpak mcp start`) runs **inside a Warden container**, and the host-side proxy
  talks to it over **mutual TLS**. Each side generates its own CA and leaf in
  memory and swaps only the public CA certs, the container's over stdout
  (`libs/server/src/sandbox.rs:1-28`). It is persistent (one container for all
  sessions, the default) or ephemeral (one per session, 5-10 s to start)
  (`sandbox.rs:9-16`). So stakpak also keeps the **brain on the host and the hands
  in a container**, the same split as Hearth 0009. The difference is that its
  hands get the user's cloud credentials (§2).
- **Knowledge.** A local "AK" knowledge store with search and a tree-navigation
  engine (`libs/ak/src/lib.rs:1-10`), mounted read-write into the sandbox
  (`container.rs:43-44`). This is comparable to Hearth §6.9 Memory. It was not
  studied further.

## 6. Human-in-the-loop

- **When it pings.** It sends a notification for each scheduled run, according to
  `notify_on`: `all` (default), `completions`, `failures` or `none`, set globally
  or per schedule (`cli/src/commands/watch/config.rs:174-226`). A schedule can be
  `interactive` (default: the run is delegated to a chat session the human can
  reply in) or `silent` (`config.rs:208-212`). It asks for approval only when a
  tool's policy is `Ask` and `pause_on_approval` is on, which is off by default
  (`config.rs:124-125`, `:166-168`). As shipped, then, "only pings when it needs a
  human" means notification filtering, not judgement by the agent.
- **Channels.** Telegram, Discord and Slack (Socket Mode) through `libs/gateway`
  (`libs/gateway/src/channels/`; setup in `docs/autopilot-channel-setup.md:1-60`).
  Each channel maps to a profile (allowed tools, auto-approve, model) ([autopilot],
  lines 84-94).
- **What an approval looks like.** When the agent proposes tool calls, the run
  stream pauses on `tool_calls_proposed`, and the gateway posts one message with
  inline buttons (Telegram inline keyboard,
  `libs/gateway/src/channels/telegram.rs:440-456`). A button press arrives as a
  callback carrying `approval_id` and `allow` or `deny`, and the bot's own presses
  are ignored (`telegram.rs:304-335`; `dispatcher.rs:343-366`). Rules:
  - **At most one pending approval batch per session**
    (`libs/gateway/src/dispatcher.rs:58-60`).
  - A new user message to a session that is waiting **rejects the pending batch**
    and queues the message (`dispatcher.rs:333-337`).
  - Approvals **expire**: a press that arrives after the run stopped waiting only
    edits the prompt to say it expired (`dispatcher.rs:728-745`). After a decision
    that goes through, the run resumes with what is left of its time budget
    (`:778-788`).
  - In a **direct chat only the requester** can resolve. In **group chats anyone**
    can, and only a warning is logged (`dispatcher.rs:699-717`).
  - The gateway-wide mode is `allow_all` (default), `deny_all` or `allowlist`
    (`libs/gateway/src/config.rs:48-53`).

### What this means for Hearth

PRD §6.5 already asks for one-tap cards with timeout-defaults-to-deny, and §10 says
"only paired chats are served". Rules worth taking: one pending batch per session,
auto-reject when the user sends a new message, edit the card when it expires, and
bind the resolver to the requester. **Do not** follow the group-chat leniency: in
Hearth only the paired owner resolves, in any chat type. The stakpak default of
auto-approving autopilot runs goes against §6.5. See F3.

---

## Adopt / Adapt / Skip for Hearth

Cost: **S** about 1 day, **M** 2-4 days, **L** a week or more (agent-days, rough).

| # | stakpak feature | Verdict | Reason | Affects | Cost |
|---|---|---|---|---|---|
| 1 | Shell commands parsed into sub-commands before approval rules match; most restrictive wins; parse failure means Ask | **Adopt** | PR #63's regex deny-list over the raw string misses chained and substituted commands. Parsing is deterministic and runs hub-side before the RPC (§6.5). | §6.5, #43 / PR #63 (0015 deny-list), M3 approvals | M |
| 2 | Placeholder substitution: redact secrets in tool results and user input, restore in tool-call args | **Adapt** | Hearth has the same choke point (`tool_result` / `tool_call`, 0015). Keep the map hub-side only, never in `/workspace`. Also catch base64 and hex forms of known values, and also scrub text that goes to the EventStore and the UI. | §10, §6.4, 0015, #57 | M |
| 3 | Approval cards over chat: one batch per session, new message rejects it, expiry edits the card, resolver bound to requester | **Adapt** | Matches §6.5 and §6.6. Leave out group-chat leniency and the auto-approve default. | §6.5, §6.6, M3, Telegram P1 | S (on top of M3) |
| 4 | Check-script-gated triggers (`trigger_on` failure/success/any) with check output in history | **Adapt** | A cheap box-side check before any model call makes 5-minute health crons affordable. Hearth must kill the check's process group (0011), unlike `kill_on_drop`. | §6.7, trigger history | M |
| 5 | `doctor` probes with severity and remediation, also run at startup | **Adapt** | Fits the #47 install and PRD §10 preflight. Probes: Docker socket, box image present, box-network listener bound (0012), egress firewall marker (0012/#58), disk, SecretStore refs resolve, model key works. | #47, §10 preflight, §8.1 | S |
| 6 | Rulebooks: only an index in context, body loaded on demand by a tool; tag and include/exclude filters | **Adapt** (pattern only) | Fits Lessons injection (§6.8) and open question 9. The SaaS store and official catalogue: Skip. | §6.8, §12 Q9 | S |
| 7 | `notify_on` (all/completions/failures/none) and silent vs interactive per trigger | **Adapt** | A small config surface for §6.6 push and Telegram notices. Fold into F4. | §6.6, §6.7 | S |
| 8 | Warden network sidecar | **Skip** | Closed, downloaded binary. Hearth's box, ICC-off networks and host egress firewall (0007, 0012) already do this. Request logging might come back later as an audit feature. | §10, 0012 | — |
| 9 | Mounting cloud credential files into the sandbox | **Skip** | Goes against PRD §10 ("no long-lived secrets" in the box). User credentials should reach commands through substitution (row 2), not mounts. | §10 | — |
| 10 | Plaintext redaction map in the workspace | **Skip** | The anti-pattern behind row 2's failure modes. | §10 | — |
| 11 | Host user service (systemd/launchd) for supervision | **Skip** | Hearth is compose-deployed (#47). Docker's restart policy plus §8.1 principle 7 cover it. | #47 | — |
| 12 | Privacy mode (IPs, account IDs) | **Skip for v1** | Useful later as an option on row 2's redactor. Not needed for the prototype. | §6.8 (Retro sends data to a model) | — |
| 13 | mTLS between host proxy and sandbox | **Skip** | Hearth's box dials out with a one-time join token and a per-box credential to a listener only the box network can reach (0008, 0012), which covers the same threat. | 0008, 0012 | — |

## Proposed follow-up issues

The orchestrator files the ones it accepts. Each is clean-room work that credits
stakpak/agent for the idea in its DECISIONS entry.

**F1. `security(hub): parse bash commands before applying the approval deny-list`** (row 1)
- Parse a `bash` tool call's `command` into simple commands with a bash grammar
  (pipelines, lists, subshells, `$(...)`, backticks, `bash -c` nesting), and match
  rules per sub-command. The most restrictive result wins.
- If parsing fails, or a command name is a variable, the call needs approval (or is
  denied while there is no approval UI). Rules key on command name plus argument
  pattern, not the raw string.
- Tests with chained, substituted and nested commands against rules like `rm -rf`
  and `git push --force`. Interpreters (`python -c`, `node -e`) are listed as a
  known gap.

**F2. `security(hub): placeholder substitution for user secrets at the runner boundary`** (rows 2, 10)
- In `tool_result` and on user messages, replace detected secrets and every known
  hub-side secret value (including base64 and hex forms) with stable placeholders.
  In `tool_call`, restore them just before the tool RPC leaves the hub.
- The placeholder map lives only in the hub (memory plus encrypted or fingerprinted
  storage through `SecretStore`), never in the box or `/workspace`. EventStore and
  UI text get the redacted form.
- Document the known gaps (an encoding the redactor does not catch, images,
  low-entropy secrets) in the DECISIONS entry. Tests prove that a placeholder
  restores only in the outbound args and never reaches the event log.

**F3. `feat(approvals): approval card lifecycle rules for web and Telegram`** (row 3)
- At most one pending approval batch per session. A new user message rejects the
  pending batch and queues the message. Each decision is audit-logged before it
  takes effect (§10).
- On timeout: deny, edit the card to say it expired, and the run continues with
  the denial as the tool result.
- Only the paired owner can resolve, in any chat type. A press from anyone else is
  refused and logged.

**F4. `feat(triggers): check-script gate and notify policy for cron triggers`** (rows 4, 7)
- A trigger may name a check command that runs in the session's box with a named
  deadline. `trigger_on` = failure (default) / success / any decides whether the
  runner is woken.
- Trigger history records the check's exit code, truncated output, timeout and
  whether the agent was woken. A timed-out check kills its process group (0011).
- Per-trigger `notify_on` (all / completions / failures / none) and silent vs
  interactive delivery.

**F5. `feat(ops): hearth doctor and startup preflight probes`** (row 5)
- One probe list with id, severity (blocking or warning), status, summary and
  remediation. It runs at hub startup (blocking probes stop the start) and via a
  `doctor` command or route.
- Probes: Docker socket reachable, box image present, box listener bound on each
  box network gateway, egress firewall marker present, free disk, every SecretStore
  ref resolves, the model key answers a cheap call.
- Documented in the #47 install guide. Output is also available as JSON.

**F6. `feat(retro): inject lessons as an index and load bodies with a hub-only tool`** (row 6)
- New sessions get a short index of accepted lessons in scope (id, scope, one-line
  summary, tags), not the full text.
- A hub-only tool `lesson_load(id)` returns the body. It touches only hub state, so
  it is allowed under §8.2.1.
- Lessons carry a version, and the session records which version it loaded. That
  closes the gap rulebooks leave open.

[handling-secrets]: https://stakpak.gitbook.io/docs/how-it-works/handling-secrets.md
[warden-guardrails]: https://stakpak.gitbook.io/docs/how-it-works/warden-guardrails.md
[autopilot]: https://stakpak.gitbook.io/docs/how-it-works/autopilot.md
[rulebooks]: https://stakpak.gitbook.io/docs/how-it-works/rulebooks.md
[how-to-write-a-rulebook]: https://stakpak.gitbook.io/docs/how-it-works/rulebooks/how-to-write-a-rulebook.md
