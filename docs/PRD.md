# Hearth PRD

> Status: draft v0.3 · 2026-11-15 · Owner: @zerone0x

**What changed in v0.3** (decision 0009, issue #29): the **brain/hands split**.
The pi agent loop now runs in the hub, in one runner per session; the box is the
session's tool executor (shell and files in `/workspace`, the Chrome/CDP desktop,
VNC). The box holds no model credentials, starts only when a tool needs it, and a
box crash no longer loses the turn. §11 adds an **M1 Prototype** milestone that
replaces the old M1 Chat; Bifrost, Telegram, hibernation polish, triggers and
Retro move after it. Sections touched: §2, §5, §6.2–§6.5, §7, §8 (diagram, §8.2,
§8.4, stack), §9, §10, §11, §12.

## 1. One line

**Hearth is a self-hosted personal agent host: every session gets its own isolated cloud desktop, keeps working after you close your laptop, picks up on your phone, and turns finished work into lessons automatically.**

## 2. Background and positioning

What exists today:

- **Running Claude Code / Codex / pi locally**: stops when the laptop sleeps, no desktop isolation, sessions scattered across each tool's JSONL, nothing learned from past work.
- **Hosted agent platforms**: your data and desktops live on someone else's machines, per-seat pricing, built for teams.
- **Self-hosted team platforms** (e.g. nuphos): feature-rich but team-first; sessions on one machine share a Unix user and X server and can reach each other.

Hearth's position: **built for one person, structured so it can grow into an enterprise edition.**

Differentiators:

1. **One box per session**: each session's tools run in its own container (shell, files, Chrome + desktop); sessions cannot see each other. The agent's brain stays in the hub, so the box holds no model credentials (§8).
2. **Hibernate / wake**: idle sessions cost nothing, so dozens can stay around.
3. **pi-native**: uses the pi SDK and extension ecosystem directly, no ACP adapter layer. pi's own tool-routing mechanism sends its tools into the box (§8.2).
4. **Retro loop**: session ends → classify, find failure points → propose lessons → future sessions load them.

## 3. Users and scenarios

**Target user**: a heavy coding-agent user with a VPS, NAS, or always-on machine.

| # | Scenario | Pain today |
|---|---|---|
| S1 | Drop "fix this issue and open a PR" at night, review the result in the morning | Local agents die when the laptop closes |
| S2 | Have the agent drive web pages (log into an admin panel, fill forms, compare screenshots) | Ties up and endangers your own browser |
| S3 | Check progress or approve a risky action from your phone on the train | Have to get back to the computer |
| S4 | Run a check every day at 9:00, or handle a webhook automatically | Hand-rolled cron + scripts |
| S5 | "How did we fix auth last week?" / "Where does the agent keep failing?" | Sessions aren't searchable; nothing is learned |

## 4. Goals and non-goals

### Goals (v1)

- G1: Single user, single host; `docker compose up` to running in under 10 minutes.
- G2: Sessions run in the background, independent of client connections.
- G3: Each session has its own box; its desktop can be watched and taken over live in the browser.
- G4: Idle sessions hibernate automatically and wake on the next message, with no file loss.
- G5: Two entry points: Web (PWA) and Telegram.
- G6: Scheduled and webhook triggers.
- G7: Automatic retro when a session ends; lessons can be injected into later sessions.
- G8: Code structure leaves extension points for multi-tenant and multi-node (see §7) without implementing them.

### Non-goals (explicitly not in v1)

- Multiple users, orgs, teams, RBAC, SSO.
- Multi-node / cluster scheduling, rolling upgrades.
- A home-grown model gateway or billing (Bifrost is used instead).
- Native iOS / Android apps (PWA first).
- 20+ chat channels; Telegram only.
- Controlling the user's own computer (local computer use).

## 5. Core concepts

| Concept | Definition |
|---|---|
| **Workspace** | Root of ownership. v1 has exactly one with a fixed ID; all data hangs off it. |
| **Session** | An ongoing conversation with one runner (brain) and at most one box (hands) at a time. States: `creating → running ⇄ idle → hibernated → (waking) → running`, plus `failed` / `archived`. "Hibernated" means the box is stopped; the conversation itself lives in the hub. |
| **Runner** | The hub-side brain of one session: a pi `AgentSession` (pi SDK, `createAgentSession`) whose file and shell tools are routed to the session's box. Its state is rebuilt from the event log, so the runner is disposable too. |
| **Turn** | One round started by the user (or a trigger), until the agent stops and waits for input. A turn runs in the runner, not in the box. |
| **Box** | A session's hands: a container plus a persistent volume, where the agent's tool calls execute. Started lazily, when the first tool call needs it. The container is disposable; the volume is the source of truth for files. |
| **Tool call** | One call by the agent to a tool. Routed tools (file, shell, later desktop and browser) are dispatched from the runner to the box over the hub↔box connection and answered there. |
| **Event** | An append-only record (messages, tool calls, state changes, approvals). All UI, sync and retro derive from the event stream, and so does the runner's state after a restart. |
| **Trigger** | A cron schedule or webhook that delivers a message to a given session (or a new one). |
| **Approval** | A pending decision created when the agent asks for a risky action; blocks the turn until approved, denied, or timed out. |
| **Lesson** | A piece of experience distilled from a session retro, with its source session, scope (global / per repo) and enabled state. |

## 6. Functional requirements

Priorities: **P0** = MVP; **P1** = before v1 release; **P2** = after v1.

### 6.1 Sessions

- **P0** Create a session: optional initial repo (git URL), model, initial prompt.
- **P0** Send messages; stream replies and tool calls. Client disconnects don't affect the run; reconnecting resumes the event stream from the last cursor.
- **P0** Interrupt the current turn.
- **P0** Session list: title (auto-generated), state, last activity.
- **P1** Archive / delete a session (delete removes the volume).
- **P1** Full-text search across sessions.
- **P2** Fork a session (copy volume + event cut point).

Acceptance: start a 30-minute task from the web, close the browser, open it on a phone 20 minutes later and see the full process and final result.

### 6.2 Box and desktop

The box is the session's **tool executor**. The agent loop does not run in it (§8).

- **P0** Image includes box-agent, Chrome (CDP on loopback only), Xvnc + a lightweight WM, git, common language runtimes. pi is **not** needed in the box any more: box-agent executes tool calls, it does not run an agent. The current image still installs pi (decision 0004); dropping it is part of slimming the image (#15).
- **P0** box-agent executes the routed tools: read, write and edit files, list and search them, and run shell commands, all inside `/workspace` (§8.2). Later, desktop and browser tools (CDP) run here too.
- **P0** One container per session; workspace and home on a persistent volume.
- **P0** **Lazy start.** Creating a session or sending a message does not start a box. The box is started when the first tool call of the session needs it (or the user opens the desktop view), and the tool call waits for it under a named deadline.
- **P0** Watch the desktop via noVNC in the web UI. A **Take over** button: while the user holds it, the agent's desktop input tools return "user is in control"; releasing hands it back.
- **P0** Global resource limits (CPU / memory / disk).
- **P0** Desktop processes (Xvnc, the WM) are supervised in the box; one dying is reported, not left as a silently dead desktop (#15).
- **P0** The hub's box listener is reachable only from box networks, while the UI/API stays on loopback (#27).
- **P0** Box egress only to the internet and the hub: no LAN, host or metadata addresses (#20).
- **P0** The hub supervises box exits: every exit is classified and ends in a relaunch or a visible failure event (#28).
- **P1** No inbound ports on the box; all traffic goes over a connection the box opens to the hub (see §8).
- **P2** User-defined images (extending the base image).

### 6.3 Hibernate and wake

With the brain in the hub, **hibernate means "stop the box"**. The conversation is not in the box, so there is no pi state to save there: the runner's state is the event log (§8, §9).

- **P0** A session idle for N minutes (default 15) → stop and remove the container, keep the volume. The runner may be dropped from memory too; it is rebuilt from the event log on the next message.
- **P0** Messaging a hibernated session → the runner answers at once (rebuilt from the event log if needed); the box starts again only when a tool call needs it (§6.2, lazy start). The user sees "starting the box" only then.
- **P1** Sessions running a scheduled task or waiting on an approval don't hibernate.
- **P2** Process-level snapshots (CRIU) so Chrome page state survives too.
- Rules (see §8.1):
  - **Durable files and process snapshots are separate layers.** The volume is the source of truth and must survive a cold boot on its own; a process snapshot is an optional speed-up layered on top.
  - A snapshot that fails to restore is kept aside for inspection, never deleted, and the session falls back to a cold boot from the volume.
  - A wake waits for any hibernate still in flight; a tool call arriving while a box is going down waits and runs on the next box.
  - A woken box must prove it reconnected to the hub within a deadline, or the wake counts as failed and is retried as a cold boot.
  - box-agent lives in the image's top layer, outside the snapshot, so upgrading box-agent does not invalidate snapshots. pi is no longer in the box, so a pi upgrade never touches a snapshot.
  - **A box dying does not lose the turn.** The runner survives and keeps the turn. The tool call that was in flight ends with a tool error the model sees ("the box restarted; the outcome of this call is unknown"), and is never silently re-run, because a shell command or write may already have taken effect. A read-only call (read, ls, find, grep) may be retried on the fresh box. The next tool call starts a fresh box on the same volume. This replaces v0.2's "re-ask the turn from the start".
  - A hub restart is different: the runner and its model stream die with the hub. The turn in flight is marked interrupted and surfaced (§8.1, principle 7); the user can re-ask it.

Acceptance: with 50 hibernated sessions, host idle memory differs from zero sessions by < 200 MB; first tool result on a hibernated session < 15 s, box cold start included (v0.2 measured this as "wake to first token"; with the split the first token needs no box).

### 6.4 Model access

Model calls are made by the runner, in the hub. **The box holds no model credentials at all**: no provider key, no virtual key, no subscription token. This supersedes v0.2's "the box gets a virtual key" (decision 0009).

- **P0 (prototype)** Model access through the `direct` gateway with an **API key stored as a SecretStore reference** (`env:` / `file:`, E7). The runner resolves it at use and passes it to pi in memory (`ModelRuntime.setRuntimeApiKey`, see pi's `examples/sdk/09-api-keys-and-oauth.ts`); it is never written to the box, the event log or pi's on-disk auth storage.
- **P1** Default gateway: **Bifrost** (self-hosted, on the internal network only), after the prototype. Provider keys live in Bifrost; the hub creates **one virtual key per session** with a budget, rate limit and an explicit model allowlist (empty means none, never "all"), keeps it hub-side for that session's runner, and revokes it when the session is archived or deleted.
- **P1** With Bifrost, the runner's pi uses a custom provider pointing at Bifrost with the session's virtual key.
- **P1** Alternative `direct` gateway: pi's own provider configuration, or an OpenAI- / Anthropic-compatible base URL such as a local magpie gateway (for multiplexing personal subscriptions).
- **P1** Switch model per session (updates the virtual key's allowlist).
- **P1** Per-session spend and tokens come from the gateway's request log, keyed by the session's virtual key, and feed the Retro (§6.8). Until then the runner records pi's own per-call usage as events.
- Subscriptions: a subscription token is a hub-side secret like any other, used by the runner. Since nothing model-related runs in the box, a subscription no longer puts a token in the box.
- A model the provider has retired is refused with a message naming a replacement — never silently rerouted to another model.

### 6.5 Approvals

- **P0** Configurable tools / command patterns that need approval (e.g. `git push`, `rm -rf`, a payment page on the desktop).
- **P0** Approval cards pushed to Web and Telegram, one tap to approve / deny; timeout defaults to deny.
- With the brain in the hub, the gate runs hub-side before a tool call is dispatched to the box: pi's `tool_call` extension event fires before a tool executes and can block it. A denied or timed-out call never reaches the box.

### 6.6 Entry points

- **P0** Web: session list, chat, desktop, settings. Installable PWA, usable on mobile.
- **P1** Telegram bot: one session per topic / reply thread; send messages, receive results, approve, `/new`, `/list`.
- **P1** Web Push notifications (turn finished, approval needed, failure).

### 6.7 Triggers

- **P1** Cron: expression + time zone + prompt + target (fixed session / new session each time).
- **P1** Webhook: a URL with a secret; the request body is attached to the prompt as context.
- **P1** Trigger history: fire time, session, result.
- **P1** Default run mode for a recurring trigger: **persistent workspace, fresh context**. Each run continues in the same session's files but starts a new conversation, opened by a hub-written preamble (run number, previous outcome, what changed). Alternatives (fully fresh session, fully shared context) are per-trigger options; the extremes respectively lose state and grow context without bound.
- **P1** A run whose previous run is still going is skipped and recorded as skipped. A trigger claim is a single conditional update, so one tick fires at most once.
- **P2** Pre-warm the session's box shortly before a scheduled run.

### 6.8 Retro

- **P1** Automatic retro when a session is archived or idle for 24 h:
  - Label each turn: task type (bugfix / feature / research / ops / chat …), outcome (done / partial / abandoned / failed).
  - Detect failure points: repeated tool errors, loops, user corrections, interruptions.
  - Propose 0–3 candidate lessons.
- **P1** Lessons page: review candidates (accept / edit / discard). Accepted lessons are injected into new sessions by scope (as a pi extension or an `AGENTS.md` fragment).
- **P2** Weekly report: tasks by type, success rate, spend, most common failure causes.
- **P2** Import external sessions (local Claude Code / Codex / pi JSONL) into the retro.
- **P2** Stats by task type × model × outcome; export model-routing suggestions (e.g. magpie routing-group rules).

### 6.9 Memory

- **P1** Sessions can call `memory_search` / `memory_save`, stored in the hub's SQLite (FTS5).
- **P2** Vector search (local embeddings).

## 7. Extension points (reserved for an enterprise edition)

Principle: **implement only the personal-edition variant now, but design each interface for multiple implementations.** Each extension point is an explicit TypeScript interface; business code depends only on the interface.

| # | Extension point | v1 (personal) implementation | Can later become |
|---|---|---|---|
| E1 | **Tenancy**: every table has `workspace_id`; every query goes through `WorkspaceScope` | One fixed workspace | Multiple workspaces / orgs |
| E2 | **Identity**: `Principal` (who is acting) | One local user, password / passkey | OIDC / SAML, API keys, service accounts |
| E3 | **Authorization**: single entry point `authorize(principal, action, resource)` | Always allows (login still required) | RBAC / ABAC policies |
| E4 | **BoxProvider**: `create / start / stop / destroy / snapshot / attach` | Local Docker; boxes started lazily by the session manager | Remote Docker, Kubernetes, gVisor, cloud VMs |
| E5 | **Hub↔Box protocol**: box dials out, one multiplexed connection; carries tool calls from the runner to the box | Same host, over a box listener reachable only from box networks (#27) | Cross-host / cross-network (enterprise data plane) |
| E6 | **EventStore**: append-only log + cursor reads | SQLite | Postgres, object-storage archive |
| E7 | **SecretStore**: secrets are stored as *references* (`env:`, `file:`) resolved at use, with a short cache; UI shows fingerprints, never values | `env:` / `file:` resolvers | `vault:` / KMS resolvers |
| E8 | **ModelGateway**: issues and revokes per-session credentials, reports usage. Credentials go to the hub-side runner, never to a box | `direct` with an API key from the SecretStore (prototype); then Bifrost (one virtual key per session); magpie as an alternative | Bifrost Enterprise or another gateway; team / org budget layers |
| E9 | **Channel**: message entry adapters | Web, Telegram | Slack, Teams, Lark, etc. |
| E10 | **Audit**: every `authorize` decision and admin action is written to the event stream | Written, no UI | Audit log UI, compliance export |

Hard rules:

- Business code must not call Docker, read/write SQLite, or read secrets from env directly — only through the interfaces above.
- Every API handler calls `authorize` first, even though v1 always allows.
- The hub never assumes a box is on the same host (no shared addresses or file paths). The runner reaches the box's files only through tool calls on the connection, never through a host path to the volume.

## 8. Architecture

**Brain in the hub, hands in the box** (decision 0009). The pi agent loop runs
hub-side, one runner per session; the box executes the runner's tool calls and
hosts the desktop. Prior art: Anthropic's self-hosted Managed Agents splits "the
brain" (the agent loop) from "the hands" (the sandbox that runs tools), keeps
credentials out of the sandbox, and starts a sandbox only when a tool needs it
(<https://platform.claude.com/docs/en/managed-agents/self-hosted>). pi documents
the same pattern as keeping pi on the host and routing selected tools into an
isolated environment (pi `docs/containerization.md`, the Gondolin method).

```
 Web / PWA        Telegram
     │                │
     ▼                ▼
┌──────────────────── hub ─────────────────────┐
│ API (HTTP + WS)          Channel adapters    │
│ authorize()              Trigger scheduler   │
│ Session manager (state machine, lazy box     │
│   start, hibernate = stop box, supervision)  │
│ Runners: one per session (brain)             │
│   pi SDK AgentSession ── model calls ────────┼──► model provider (`direct`,
│   routed tools ─► tool RPC ─┐                │    key from SecretStore) or
│ EventStore  SecretStore  Retro               │    bifrost (internal only)
│ BoxProvider ──── docker ────┼─────────────┐  │
└─────────────────────────────┼──▲──────────┼──┘
          box listener (#27)  │  │ box dials out (WS, multiplexed:
                              ▼  │ control / tool rpc / VNC / files)
     ┌───────────────────────────┴┐  ┌───────▼────────┐
     │ box: session A (hands)     │  │ box: session B │ …
     │ box-agent (TS)             │  │ (started only  │
     │  └ tool executor: files,   │  │  when a tool   │
     │    shell in /workspace     │  │  needs it)     │
     │ Chrome (CDP), Xvnc + WM    │  │                │
     │ /workspace (vol)           │  │                │
     │ no model credentials       │  │                │
     └────────────────────────────┘  └────────────────┘
```

- **hub**: one process, TypeScript (Bun), SQLite. Owns all state; boxes are disposable. Since v0.3 it also runs pi: one **runner** per active session, an `AgentSession` from the pi SDK (`createAgentSession`). The runner makes the model calls, holds the session's model credential in memory, writes the pi events Hearth needs to the EventStore as Hearth events, and applies approvals before tool calls leave the hub.
- **box-agent**: long-running process inside the box. Executes the tool calls the runner routes to it (files and shell in `/workspace`; later desktop input and CDP), proxies the VNC byte stream, and supervises the desktop processes (#15). It runs no agent loop and holds no model credentials. Its only secrets are the one-time join token and the per-box credential of decision 0008.
- **One connection for everything**: the box starts with a one-time token and connects to the hub's box listener; control, tool calls, VNC and file transfer are multiplexed on it. The box exposes no ports.
- **Single source of state**: the session state machine lives only in the hub. A box dropping off means the hub decides to fail or restart it; the box never decides on its own (#28). The conversation lives in the hub's event log, so a box can be stopped, crash or be replaced without losing it.
- **Costs of the split**, accepted: one extra hub↔box round trip per tool call; the hub now runs pi, so pi-on-Bun compatibility (decision 0004 proved it inside the box) becomes a hub concern; and pi's local discovery (context files such as `AGENTS.md`, skills) looks at the hub's file system, not the box's workspace (§12, question 9).

### 8.1 Reliability principles

These are the foundation; every feature is built on them.

1. **No silent failure.** Every message ends in exactly one of: a turn, a visible retry, or a visible give-up. The hub runs a sweep that finds messages with no turn (re-ask, bounded) and turns with no progress for too long (end visibly, or wake if hibernated).
2. **Classify before recovering.** Every failure is tagged with an owner (`box`, `model-provider`, `gateway`, `hub`, `user`) and a retry disposition. A model-provider failure never destroys a box; a box failure never burns model retries.
3. **Separate clocks.** Tool silence and model silence are timed independently. Tool grace derives from the tool's own budget; model liveness counts any bytes from the provider. A stalled model stream gets a bounded number of resumes per episode (refunded on progress), with a per-turn cap; the last attempt may switch to a fallback model.
4. **Stuck is counted, not timed.** "Stuck" means N identical consecutive failures, not "took longer than T". Every network call has a per-attempt deadline; long operations scale their deadline with the amount of work.
5. **At-least-once with idempotent apply.** The box buffers outbound frames and redelivers after reconnect; each frame carries a delivery id and the box's boot id; the hub acks only after a frame is applied (written to the EventStore), not when received. Applying the same delivery twice is a no-op.
6. **Every state has an explicit answer.** No "unknown" results: e.g. a hibernate request returns one of a fixed set of outcomes, and an intent is logged before it is acted on.
7. **Long-running orchestration is persisted.** After a hub restart, in-flight orchestration (a wake, a hibernate, a trigger run) is marked interrupted and surfaced, not silently resumed.
8. **Name the slow thing.** No global timeout bumps; a slow call gets its own named deadline.

### 8.2 Hub↔box protocol

The wire protocol is defined by `packages/protocol` (see its README); this section
names what the PRD relies on and does not redefine it.

- One outbound WebSocket from box-agent to the hub, authenticated by a one-time token exchanged for a per-box credential.
- Two kinds of traffic share it:
  - **Typed frames**: `session.assign`, `turn.start`, `turn.event`, `turn.end`, `session.hibernate`, `hibernate.done`, `usage.report`, `rpc` / `rpc.result`, `delivery.ack`, `desktop.lock`, …
  - **Byte streams**: `stream.open` / `stream.data` / `stream.close`, ordered per stream, used for VNC (RFB) and file transfer.
- Frames are versioned; the hub rejects a box speaking an incompatible major version with a clear message instead of misbehaving.
- The protocol never carries hub-local paths or addresses, so a box can later run on another host (E5).

#### 8.2.1 Tool routing (v0.3)

How pi's tools reach the box, using only mechanisms pi documents:

- **Pluggable operations.** pi's built-in tools take an `operations` backend: `createReadTool(cwd, { operations })` and the same for write, edit, bash, ls and find, with the `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations` and `FindOperations` interfaces (pi `docs/extensions.md`, "Remote Execution").
- **Override by name.** An extension that registers a tool under a built-in name replaces the built-in (pi `docs/extensions.md`, "Overriding Built-in Tools"). The runner loads one Hearth inline extension, passed through the `extensionFactories` of `DefaultResourceLoader` (pi `docs/sdk.md`), that registers `read`, `write`, `edit`, `bash`, `ls`, `find` and `grep` with operations that send a tool RPC to the session's box. This is the pattern of pi's Gondolin example (`examples/extensions/gondolin`), with the hub↔box connection where Gondolin has a micro-VM. Each `execute` first asks the session manager for a connected box, which starts it lazily (§6.2).
- **grep is the exception.** `GrepOperations` only covers the directory check and grep always runs the local `rg`, so Hearth overrides grep's `execute()` and runs the search in the box, as the Gondolin example does.
- **Nothing else runs tools in the hub.** pi's containerization guide warns that with tool-only isolation, extension tools that do not delegate run on the host. The runner therefore loads no extensions besides Hearth's own, and its active tool set is the routed tools plus Hearth tools that only touch hub state, such as `memory_search` / `memory_save` (§6.9). Nothing that touches files or runs commands executes in the hub. Later desktop and browser tools are Hearth custom tools that also call the box.
- **No hub environment in the box.** pi's bash tool passes an `env` to `BashOperations.exec`, and pi warns that the Gondolin example lets commands inherit the host environment. Hearth's operations never forward the runner's environment: box-agent runs commands with the box's own environment, plus at most an allowlisted set of non-secret variables.
- **Paths.** The runner's `cwd` is `/workspace`, the box path; it is never a hub path. Tool paths are box paths: box-agent resolves a relative path against `/workspace`, and an absolute one names a path in the box (the agent can reach the whole box through `bash` anyway). Bulk transfers over `file` streams keep their stricter rule: relative to the workspace, no `..` (decision 0002).

On the wire, tool calls need **no new frame types**:

- They are hub → box `rpc` requests answered by `rpc.result`, with methods for file reads and writes, directory listing, find, grep, running a command and cancelling one. The method names and params are defined in `packages/protocol` when the tool RPC lands (a minor version bump, with README rows), not here.
- Each tool RPC carries pi's tool call id. box-agent runs a call id at most once per boot, like `isDuplicateCommand` for commands. If the connection drops or the box restarts during a call, the hub never re-sends a mutating call (write, edit, bash); the model gets a tool error saying the outcome is unknown (§6.3).
- Each tool RPC has a named deadline from the tool's own budget: the bash timeout pi passes in, plus a grace (§8.1, principles 3 and 8). pi's abort signal turns into a cancel RPC, and box-agent kills the command's whole process group.
- pi runs sibling tool calls of one assistant message concurrently by default (pi `docs/extensions.md`, `tool_call`), so box-agent handles concurrent tool RPCs.
- File contents travel in the RPC as JSON up to a size cap; larger or binary content (an image the `read` tool returns) goes over a `file` byte stream, which already exists.
- `BashOperations.exec` reports output through `onData`. In the M1 prototype a command answers once, with its exit code and output (pi truncates tool output anyway). Live output while a command runs needs a box → hub channel for it (a stream kind or progress frames) and is a protocol minor bump after the prototype.

Frames whose role changes: `turn.start`, `turn.event`, `turn.end`, `usage.report`, `session.hibernate` and `hibernate.done` were designed for a box that runs the agent loop. In v0.3, turns and usage are hub-internal: the runner writes them to the EventStore directly. These frames stay in protocol v1 unchanged, since removing them would be a major bump. The hub stops sending `turn.start`, and box-agent keeps answering it as failed (decision 0008). Whether `session.hibernate` stays as a "quiesce before stop" request or hibernation just calls `BoxProvider.stop` is decided in the session manager work. `session.assign` still binds a box to its session.

### 8.3 Desktop control

- One lock per box. Holders: `person`, `agent`, `automation`; first come, first served.
- The lock is a lease the holder renews; a dead holder's lease lapses on its own. The box stops trusting its grant slightly before the hub would expire it.
- A person renews by interacting. A person who finds the lock held may interrupt the holding turn, but cannot silently skip the queue.
- While the agent waits for the lock, its turn clocks are paused.
- Every desktop stream is authorized when opened and closed if access is revoked.

### 8.4 pi version policy

- Always build on the **latest pi release**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`. Baseline at time of writing: **1.5.2** (2026-11-10).
- The old `@mariozechner/*` package names are frozen at 0.73.x and must not be used.
- Since v0.3, **pi runs in the hub** (the runners), so `apps/hub` depends on the pi packages. `apps/box-agent` stops depending on them once nothing in the box uses pi, and the box image drops pi with the image slimming (#15).
- All three packages are pinned to one exact version together in the lockfile (`bun run pins`); Renovate opens a PR on every pi release, and CI runs the hub's runner tests against it before merge.
- **pi on Bun is a hub concern.** pi 1.5.2 asks for Node >= 22.19; decision 0004 showed that Bun runs it inside the box. The hub must show the same for the SDK path it uses (`createAgentSession`, the tool overrides, the model runtime) before the runner is built: the "pi on Bun" spike of the M1 prototype (§11).
- Integrate through the public SDK (`createAgentSession`, `SessionManager`, `DefaultResourceLoader`) and pi extensions only. No patches to pi internals; if something is missing, upstream it or wrap it in an extension.
- The runner records the pi version in the session's events when it starts, and the hub shows it per session, so a session continued after an upgrade is traceable. (The box image's `dev.hearth.pi.version` label stays only as long as pi is in the image.)

Stack (can change before implementation):

| Part | Choice | Why |
|---|---|---|
| hub | Bun + Hono + bun:sqlite; runners on the `@earendil-works/pi-coding-agent` SDK (`createAgentSession`) | Same TS ecosystem as pi; pi-native, in-process; see §8.4 |
| box-agent | Bun; tool executor and VNC relay, no agent loop | Small, holds no model credentials; see §8.2.1 |
| Web | React + Vite + Tailwind, PWA; noVNC | Conventional, works on mobile |
| Box image | Debian slim + TigerVNC + Openbox + Chromium | Light and stable |
| Gateway | `direct` with an API key from the SecretStore (prototype); then Bifrost (Go, self-hosted) | Bifrost: virtual keys, budgets, request log; small footprint; has an enterprise path |
| Deploy | docker compose (hub, later bifrost, reverse proxy); hub manages boxes via the Docker socket | One command |

## 9. Data model (sketch)

```
workspace(id, name, created_at)
principal(id, workspace_id, kind, display_name, auth_ref)
session(id, workspace_id, title, state, model, repo_url,
        box_id,            -- null until a tool call first needs a box
        last_activity_at, created_at, archived_at)
box(id, workspace_id, session_id, provider, provider_ref,
    volume_ref, state, image, created_at)
event(workspace_id, session_id, seq, ts, type, turn_id, payload_json)
      -- primary key (workspace_id, session_id, seq), append-only
      -- (decision 0006)
approval(id, workspace_id, session_id, turn_id, tool, summary,
         state, decided_by, decided_at, expires_at)
trigger(id, workspace_id, kind, spec_json, target_json, enabled)
trigger_run(id, trigger_id, session_id, fired_at, result)
lesson(id, workspace_id, scope, text, source_session_id,
       source_seq, state, created_at)
retro(session_id, workspace_id, labels_json, failures_json, created_at)
secret(id, workspace_id, name, ciphertext, created_at)
```

v0.3 changes (decision 0009):

- **The runner's state is the event log.** The runner writes what pi needs to rebuild the conversation (its finalized session entries) as events, next to the Hearth events the UI reads (messages, tool calls and results, usage, box lifecycle). A restarted or rehydrated runner rebuilds its `AgentSession` from them: pi's `SessionManager.inMemory(cwd, options, entries)` accepts existing entries (pi `docs/sdk.md`: "Restore external history by constructing the session with a manager containing those entries"). pi's own session files are not the source of truth, and the box holds no conversation state.
- `session.box_id` stays null until a tool call needs a box (lazy start); a replaced box gets a new `box` row on the same volume.
- Tool calls and their results are events with the pi tool call id, so the UI can show them and a box restart can tell which call was in flight.
- The event types and payloads are defined with the runner (M1 prototype); the 4 MiB event payload cap (decision 0006) applies, so large tool outputs are truncated or stored by reference.

## 10. Security and privacy

- The hub is the only exposed service; it listens on localhost by default. Public access requires the user to set up a reverse proxy with TLS.
- Login: password + optional passkey; session cookie `HttpOnly`, `SameSite=Strict`.
- Boxes are network-isolated from each other (one Docker network per box, egress only to the internet and the hub).
- Boxes hold no model credentials at all and no long-lived secrets: only the one-time join token and the per-box credential (decision 0008). Model keys, virtual keys and subscription tokens stay in the hub (§6.4).
- The runner runs pi in the hub process, so pi extensions are code running with the hub's rights. The runner loads only Hearth's own extension (§8.2.1).
- Desktop takeovers, approvals and settings changes are written to the event stream (E10). **The audit record is written before the action**; if it cannot be written, the action does not happen. The audit table is append-only, enforced in the database (SQLite triggers), not just by convention.
- Secrets are references resolved at use; a preflight at startup checks every reference resolves. Logs and UI show only fingerprints.
- Telegram: only paired chats are served. A stranger gets one pairing prompt and then silence. Display names in chats are labels, not identity.
- Every external poller (Telegram, trigger scheduler) runs under a single lease, so a restart or a second hub instance never sends duplicate replies.
- Retro runs locally or against a model the user configured; no data is sent to third parties by default.

## 11. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 Skeleton** (done) | Repo layout, empty hub, box image, BoxProvider (Docker), hub↔box connection (#1–#7) | Hub creates a box, box connects, hub can send `echo` |
| **M1 Prototype** (about 2–3 days of loop time) | See §11.1. Replaces v0.2's "M1 Chat" | See §11.1 |
| **M2 Hardening & desktop** (1 wk) | Desktop supervision, pinned base image and an image without pi (#15); noVNC takeover and the desktop lock (§8.3); resource limits; hibernate / wake polish up to the §6.3 acceptance; live shell output for tool calls (§8.2.1); low-priority test debt (#25, #26) | S2 works; §6.3 acceptance met |
| **M3 Gateway & anywhere** (1 wk) | Bifrost with one virtual key per session (§6.4), PWA, Web Push, Telegram, approvals | S3 works; per-session spend visible |
| **M4 Automation & retro** (1–2 wk) | Cron / webhook triggers, Retro, Lessons, memory | S4 and S5 work |
| **v1.0** | Docs, one-command install, backup / restore | Fresh VPS to running in 10 minutes |

### 11.1 M1 Prototype

Goal: a usable prototype on the brain/hands split, before any of the polish.

Scope, in order:

1. **Box listener + docker compose install** (#27): a box listener reachable only from box networks, the UI/API on loopback, `DockerBoxProvider` wired into hub startup, and a compose file for the hub. Box egress restricted to the internet and that hub address (#20), done together with #27 as #27 asks.
2. **Session manager + box supervision** (#28): the session state machine of §5, lazy box start (§6.2), hibernate as "stop the box", and every box exit classified and ending in a relaunch or a visible failure event.
3. **pi on Bun spike**, then the **hub-side pi runner + tool RPC to the box**: `createAgentSession` in the hub, the routed tools of §8.2.1, the tool RPC methods in `packages/protocol` and their executor in box-agent, the runner's state in the event log (§9).
4. **Minimal web UI**: session list, a chat stream that shows tool calls, and a noVNC view of the box's desktop.
5. **Model via an API key through the SecretStore** (`direct` gateway, §6.4). No Bifrost yet.

Exit criteria:

- A fresh `docker compose up` on a Docker host brings up a working hub.
- Create a session from the web UI.
- pi edits files and runs commands in the box (`/workspace`), and the chat shows the tool calls.
- The box's desktop is visible in the web UI.
- Closing and reopening the page continues the session.

After the prototype, still in scope and kept in this PRD: Bifrost (§6.4), Telegram (§6.6), hibernation polish (§6.3), triggers (§6.7) and Retro (§6.8), in M2–M4 above.

## 12. Open questions

1. **Subscriptions** — settled by v0.3: model credentials, subscription tokens included, stay in the hub and are used by the runner, so no token ever enters a box. What remains is whether a subscription token is acceptable at all as a hub-side secret, or only through a host-side proxy such as magpie.
2. **Restoring the runner from the event log**: an `AgentSession` built with `SessionManager.inMemory(cwd, options, entries)` from stored entries should continue the conversation exactly, including compaction and the active model. The runner work needs a test that proves it against the current pi release. A turn interrupted by a hub restart is not resumed mid-turn (§6.3).
3. **Telegram session mapping**: one forum topic per session, or reply threads?
4. **Retro model**: cheap hosted model by default, or allow local models? What cost cap?
5. **Image size**: Chromium + desktop is 1 GB+. Offer a slim, desktop-less variant for pure code sessions? Dropping pi from the image (#15) helps a little.
6. **Name**: Hearth is a working name.
7. **Box per session vs. box per person**: v1 is one box per session for isolation. Chromium + desktop per box costs ~0.5 GB RAM while running. If density matters later, `BoxProvider` can offer a shared box with a per-session workspace, Chrome profile and port range — trading isolation for density. Hibernation and lazy start make per-session affordable for one user.
8. **pi on Bun in the hub**: does the SDK path the runner uses work on Bun 1.4.4? The M1 spike answers it. If it does not, a fallback is to run each runner in a Node child process of the hub: still hub-side, still no credentials in the box. That fallback would need its own decision.
9. **Context files and skills**: pi's `DefaultResourceLoader` discovers `AGENTS.md`, skills and prompt templates from the local `cwd`, which on the hub is not the session's repo. Options: a custom `ResourceLoader` (pi `docs/sdk.md`: "Supply a custom ResourceLoader when the host owns resource storage and discovery completely") that reads the repo's context files from the box through the tool RPC, or none in the prototype. Lessons (§6.8) are injected through the same loader.
10. **Runner isolation in the hub**: all runners share the hub process. One runner using much memory or crashing should not take the others or the hub down. In-process for the prototype; whether runners later move to workers or child processes is open.

## 13. Success metrics (dogfooding phase)

- Tasks completed through Hearth per week ≥ tasks done with a local agent directly.
- Unattended background tasks (S1) completion rate ≥ 70%.
- At least 3 lessons accepted per week, with fewer repeats of the same failure after acceptance.

## 14. Constraints

- All code is written from scratch. No proprietary third-party code or internal documents are copied or referenced; only public open-source projects (under their licenses) and public material are used.
