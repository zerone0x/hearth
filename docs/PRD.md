# Hearth PRD

> Status: draft v0.4 · 2026-11-16 · Owner: @zerone0x

**What changed in v0.4** (decision 0030, issue #106): the **stage plan**. M1
Prototype is done (§11.1). §11 now says, for each milestone, what you can do
after it and how that is tested: M2 Browser & vault, M3 Anywhere, M4
Connections & automation, M5 Retro & router, then v1.0. The old M2 "Hardening
& desktop" is split up: takeover, live shell output and desktop supervision go
to M2; image slimming, hibernate polish and resource limits go to v1.0. A new
**Vault** (§6.10) holds model keys, site logins and API tokens, and replaces
`.env` and the key file for the model key and model choice. Sections touched:
§4, §6.2, §6.4, §6.8, §6.10, §7, §8.5, §9, §10, §11, §12, §13.

Changelog:

- v0.4 · 2026-11-16 · decision 0030, #106: stage plan by user-visible
  features; vault (§6.10); M1 marked done.
- v0.3 · 2026-11-15 · decision 0009, #29: brain/hands split; M1 Prototype.

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
- G9: Credentials (model keys, site logins, API tokens) are managed in a vault from the web UI, and the model never sees a credential's value (§6.10).

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
- **P0** box-agent executes the routed tools: read, write and edit files, list and search them, and run shell commands, all inside `/workspace` (§8.2). From M2, browser tools run here too.
- **P0 (M2)** Browser tools over the box's Chromium (CDP on loopback, decision 0026): navigate, read the page, click, type, screenshot, list tabs (#93). The live desktop shows the same Chromium, so the user watches what the agent does. Decided in [research/browser.md](research/browser.md) (#107) and DECISIONS 0032: box-agent drives Chromium with `playwright-core`, pinned exactly, through `connectOverCDP` on `127.0.0.1:$HEARTH_CDP_PORT`, with no MCP server, Stagehand or browser-use. The agent observes an accessibility snapshot with element refs (`browser_snapshot`, `browser_find`) and gets a fresh snapshot with every action's result; screenshots are capped JPEG image parts. It acts by ref, never by coordinates, and every acting tool takes an `element` description and an optional `expect`; code verifies `expect` and refuses stale, hidden, disabled or covered targets before dispatch. The tools are `browser_navigate`, `browser_snapshot`, `browser_find`, `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_wait`, `browser_screenshot`, `browser_tabs`, `browser_back` and `browser_forward`, routed as `browser.*` tool RPCs (protocol 1.3). `browser_fill` with a vault reference is #118; the fixture-task eval is #119; the blob store for screenshots stored by hash is #117. There is no `browser_evaluate` or coordinate click in M2.
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
- **P0 (M2)** The model key and the model choice move to the web UI: the key is a vault secret (§6.10) and the provider and model are picked in settings, from the models pi knows plus a `models.json`. No editing `.env` or `deploy/secrets/model_key`. The `env:` / `file:` references stay as a fallback for headless installs; decided in [research/vault.md](research/vault.md) (#108, "Migration"): on first start the hub imports the existing key file once as a `model-key-<provider>` vault entry; `HEARTH_MODEL*` in the environment still wins while it is set, and `env:` / `file:` stay accepted as references. The import and the settings page are #115, on top of the vault core (#114).
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
- **P1 (M5)** Model router learned from outcomes: stats by task type × model × outcome (with spend from the gateway, §6.4) give a suggested model per task type, with the numbers behind it. The owner accepts a suggestion before it becomes the default for that task type; nothing switches models silently (§6.4, retired models).
- **P2** Export the routing suggestions to an external gateway (e.g. magpie routing-group rules).

### 6.9 Memory

- **P1** Sessions can call `memory_search` / `memory_save`, stored in the hub's SQLite (FTS5).
- **P2** Vector search (local embeddings).

### 6.10 Vault

The vault is where the owner keeps every credential Hearth uses: model provider
keys, site logins and API tokens for the agent's tools. It is a SecretStore
backend (E7) that stores values itself, next to the `env:` and `file:`
resolvers. Research #108 ([research/vault.md](research/vault.md)) decided the details below; the vault core is #114 and the settings page is #115.

- **P0 (M2)** A settings page in the web UI to add, replace (rotate) and delete a secret: a name, a kind (model key, site login, API token) and an optional note. After saving, the UI and API show only a fingerprint and when it was last used; no route returns a value.
- **P0 (M2)** Model key and model choice in settings (§6.4): pick the provider and model, test the key with a cheap call, and new sessions use it without a hub restart.
- **P0 (M2)** Values are encrypted at rest with a maintained crypto library; no hand-rolled crypto. Decided in [research/vault.md](research/vault.md) (#108, "Encryption at rest"): AES-256-GCM through WebCrypto, which is built into Bun, so there is no new dependency. Each ciphertext is bound to its row by AAD. One data key is wrapped with AES-KW by an HKDF subkey of a 32-byte key file, `deploy/secrets/vault_key`, which the install step generates (mode 0600, never overwritten) and the owner never types or edits. It is not derived from the owner password, because triggers and Telegram must work while nobody is logged in. The data key is rotated by re-encrypting; the master key is rotated through `vault_key.next`, with a rewrap in one transaction. If the key file is missing or wrong the hub starts with the vault disabled. Implementation: #114. Not yet in DECISIONS on main; the text is proposed in the research note.
- **P0 (M2)** The model never sees a value. The agent names a credential by a placeholder; the hub swaps the value in only in the tool call that leaves for the box and swaps it back out of the result (#70). Values are redacted in events, logs, trajectories and OTLP export (decisions 0015, 0021); a value joins the redaction set as soon as it is saved. Decided in [research/vault.md](research/vault.md) (#108, "Use without exposure") and [research/browser.md](research/browser.md) (#107): the model names a `vault:<name>[#field]` reference, and the hub resolves it at the tool RPC boundary, audits the use first, and sends the value only in the one RPC that uses it. A site login is filled by `browser_fill`, which is #118. A site password therefore does enter the box, for that one RPC, because the browser lives there; model keys and hub-side tokens never do. Box-agent masks every filled element in later screenshots of the tab. Residual gaps (a site that echoes the value elsewhere on the page) are named in the research note's threat model.
- **P0 (M2)** Every use is audited before it happens (E10): which secret (name and fingerprint), which session and tool call. If the audit record cannot be written, the value is not used.
- **P0 (M2)** A site login is a username and a password for a stated origin; the agent may use it only on that origin. TOTP codes are computed in the hub from a `#totp` field with `otpauth`; the seed never leaves the hub (decided in [research/vault.md](research/vault.md); implementation is #129, on top of #114).
- **P1** Scope: a secret is global or limited to chosen sessions; a session cannot use a secret outside its scope.
- **P1** Per-secret approval: using a marked secret asks the owner first (§6.5, M3).
- **P1** Backup and restore include the vault (v1.0). A restore without the master key gives an unreadable vault and says so, never a silent empty one.
- **P2** Read from an existing password manager (for example Bitwarden / Vaultwarden or the 1Password CLI) instead of, or next to, the built-in store. Compared in [research/vault.md](research/vault.md) (#108, "Integration option"): it stays P2, not P1, as optional read-only `bw:` / `op:` resolvers, because each needs a long-lived unlock credential in the hub that opens the owner's whole vault. OpenBao is likewise an optional later backend behind the vault's key-provider and entry-backend interfaces, not part of M2.

Threat model, short form. The asset is the credential values.

| Threat | Defence | What is left |
|---|---|---|
| Prompt injection (a web page or file tells the agent to reveal or send a credential) | The model only has placeholders; a placeholder is restored only in tool calls to the box, and a site login only on its origin | A value typed into a page can be read by that page's scripts |
| Compromised box (hostile page or code in `/workspace`) | The box holds no vault values at rest and no model credentials (§10); egress firewall (decision 0012) | A value the box uses is visible in the box while it is used. Decided in [research/vault.md](research/vault.md): site passwords and opt-in `box-env` tokens enter the box only inside the one RPC that uses them; model keys and hub-side tokens never do |
| Leak through events, logs, trajectories or export | Redaction at the sink with every vault value known; trajectories never leave the hub unless an exporter is set (§8.5) | Encodings the redactor misses (#70 lists the gaps) |
| Stolen database file or backup | Values are encrypted; the master key is not stored with them | Decided in [research/vault.md](research/vault.md): the master key is `deploy/secrets/vault_key`, outside the data volume, and the owner backs it up apart from the volume |
| Hub or host compromise | Out of scope: the running hub can decrypt. pi extensions run with the hub's rights, hence the allowlist policy (#56) | Everything the hub can read |
| Someone at the UI or API | Login, Origin and Host checks (§10); values are never returned; changes are audited | A signed-in owner session can use secrets, not read them |

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
| E7 | **SecretStore**: secrets are stored as *references* (`env:`, `file:`) resolved at use, with a short cache; UI shows fingerprints, never values | `env:` / `file:` resolvers; the vault's own encrypted store (§6.10, M2) | External password managers, KMS |
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
- **Paths.** The runner's `cwd` is `/workspace`, the box path; it is never a hub path. Tool paths are box paths confined to `/workspace` (decision 0011): box-agent resolves a relative path against `/workspace`, an absolute one must be inside it, any `..` segment is refused, and a path that leaves it through a symlink is refused. `~` means `/workspace`: the runner rewrites it before the call, since pi expands it to the hub's home. `bash` remains the way to reach the rest of the box. Bulk transfers over `file` streams keep the same rule: relative to the workspace, no `..` (decision 0002).

On the wire, tool calls need **no new frame types**:

- They are hub → box `rpc` requests answered by `rpc.result`, with methods for file reads and writes, directory listing, find, grep, running a command and cancelling one. The method names and params are in `packages/protocol` (protocol 1.1, decision 0011, with README rows), not here.
- The idempotency key is the `rpc` id, which the hub mints per operation; each RPC also carries pi's tool call id as `callId`, for logs and audit, since one pi tool call makes several operations (edit: access, read, write). box-agent runs an `rpc` id at most once per boot, like `isDuplicateCommand` for commands. If the connection drops and the box comes back on the **same boot**, the hub re-sends the call with the same id and gets its one answer. If the box restarted (a **new boot**), the hub never re-sends the call; the model gets a tool error saying the outcome is unknown (§6.3).
- Each tool RPC has a named deadline from the tool's own budget: the bash timeout pi passes in, the search budget, or the file methods' budget, plus a grace (§8.1, principles 3 and 8). pi's abort signal turns into a cancel RPC, and box-agent kills the command's whole process group and every process still carrying the command's run marker (decision 0011).
- pi runs sibling tool calls of one assistant message concurrently by default (pi `docs/extensions.md`, `tool_call`), so box-agent handles concurrent tool RPCs.
- File contents travel in the RPC: reads come back base64-encoded, so binary content such as an image the `read` tool returns is exact, and writes carry UTF-8 text, both up to 1 MiB. A larger file is refused with `tool.too-large`; moving it over a `file` byte stream, which already exists, is a later step.
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

### 8.5 Observability and trajectories

From day one every session produces a complete trajectory (decision 0021).
Sessions are the data for Retro (§6.8) and the M5 model router, and "no silent
failure" (§8.1) needs evidence.

- **Trajectory.** One per session, schema `hearth.trajectory/2`: turns made of
  steps (model calls, tool calls), user inputs, box operations and outcome
  labels, each with session, turn, step, tool call, box, trace and span ids,
  wall and monotonic times, and the pi and hub versions. Enough to replay and
  debug a turn: each model call has its request (model, thinking level, max
  tokens, temperature, tools, system prompt hash and size, message count) and
  its output (text, thinking, tool calls with arguments); every kept text is
  redacted and capped at 16 KiB of UTF-8 with its size and hash. It is a projection of
  the event log, served as JSON Lines by `GET /v1/sessions/:id/trajectory`
  (behind `authorize`) and dumped by a CLI.
- **Correlation.** Each tool RPC carries a W3C `traceparent` (protocol 1.2), so
  box-agent's log lines for a call share the hub's trace id.
- **Logs.** Hub and box-agent write JSON lines with level (warnings and errors
  as such), component and the session, box and turn ids a line names.
  Secrets are redacted at the sink, not only where events are written, and
  are known from startup.
- **Export.** OpenTelemetry spans and metrics (GenAI semantic conventions)
  through the official OTLP exporter, to any OTLP backend, only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Off by default: trajectories never
  leave the hub unless an exporter is configured. Hearth builds no trace
  viewer; it uses existing OTLP backends.
- **Metrics.** Tokens, cost, turns, tool calls and failures by class, and box
  start/wake latency, as OpenTelemetry metrics and in the trajectory summary.
- **Outcome labels.** Task type, outcome and verdict per session or turn, set
  through the API today and by Retro later.
- **Retention.** A configurable retention period is a follow-up (#83): it
  needs a migration of the append-only event log (decision 0006).

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
secret(id, workspace_id, name, kind, scope, ciphertext,
       fingerprint, created_at, rotated_at, last_used_at)
      -- the vault (§6.10); the `vault_key` and `secret` tables, AES-256-GCM envelope encryption, are specified in [research/vault.md](research/vault.md) ("Data model"); migration is #114
```

v0.3 changes (decision 0009):

- **The runner's state is the event log.** The runner writes what pi needs to rebuild the conversation (its finalized session entries) as events, next to the Hearth events the UI reads (messages, tool calls and results, usage, box lifecycle). A restarted or rehydrated runner rebuilds its `AgentSession` from them: pi's `SessionManager.inMemory(cwd, options, entries)` accepts existing entries (pi `docs/sdk.md`: "Restore external history by constructing the session with a manager containing those entries"). pi's own session files are not the source of truth, and the box holds no conversation state.
- `session.box_id` stays null until a tool call needs a box (lazy start); a replaced box gets a new `box` row on the same volume.
- Tool calls and their results are events with the pi tool call id, so the UI can show them and a box restart can tell which call was in flight.
- The event types and payloads are defined with the runner (M1 prototype); the 4 MiB event payload cap (decision 0006) applies, so large tool outputs are truncated or stored by reference.

## 10. Security and privacy

- The hub is the only exposed service; it listens on localhost by default. Public access requires the user to set up a reverse proxy with TLS.
- Login: password + optional passkey; session cookie `HttpOnly`, `SameSite=Strict`. Every route except `GET /healthz` requires it, from the M1 prototype on (§11.1).
- The API accepts only an allow-listed Host, an Origin that is same-origin or the configured `HEARTH_PUBLIC_ORIGIN`, and JSON request bodies (#33).
- Boxes are network-isolated from each other (one Docker network per box, egress only to the internet and the hub).
- Boxes hold no model credentials at all and no long-lived secrets: only the one-time join token and the per-box credential (decision 0008). Model keys, virtual keys and subscription tokens stay in the hub (§6.4).
- The runner runs pi in the hub process, so pi extensions are code running with the hub's rights. The runner loads only Hearth's own extension (§8.2.1).
- Desktop takeovers, approvals and settings changes are written to the event stream (E10). **The audit record is written before the action**; if it cannot be written, the action does not happen. The audit table is append-only, enforced in the database (SQLite triggers), not just by convention.
- Secrets are references resolved at use; a preflight at startup checks every reference resolves. Logs and UI show only fingerprints.
- Vault values (§6.10) are encrypted at rest, never returned by the API or UI, never shown to the model, and every use is audited first. See §6.10 for the threat model.
- Telegram: only paired chats are served. A stranger gets one pairing prompt and then silence. Display names in chats are labels, not identity.
- Every external poller (Telegram, trigger scheduler) runs under a single lease, so a restart or a second hub instance never sends duplicate replies.
- Retro runs locally or against a model the user configured; no data is sent to third parties by default.

## 11. Milestones

Each stage is described by what you can do after it, in user terms, and closed
by exit criteria that a test or a scripted check can prove. Docker-dependent
checks run in CI (repo rules).

**How to use it today (after M1).** Hearth is a web UI for a pi agent whose
tools run in an isolated box with a live desktop, and every session keeps a
trajectory. Install it with Docker Compose by following
[docs/install.md](install.md): copy `deploy/hearth.env.example` to
`deploy/.env`, set `HEARTH_MODEL_PROVIDER` and `HEARTH_MODEL` there (default
`anthropic` / `claude-sonnet-5-5`), and put the model key in
`deploy/secrets/model_key`. Then `docker compose up`, set the owner password
with the one-time setup token from the hub's log, and sign in. You can start a
session, have the agent edit files and run commands in the box's `/workspace`,
watch the box's desktop, close the page and come back to the same session, and
download the session's trajectory (`GET /v1/sessions/:id/trajectory`). Not yet:
the agent cannot drive the browser, you cannot type into the desktop, keys are
not managed in the UI, and there is no phone, Telegram or trigger entry point.

| Milestone | What you can do after it | Exit criteria |
|---|---|---|
| **M0 Skeleton** (done) | Nothing user-facing: repo layout, empty hub, box image, BoxProvider (Docker), hub↔box connection (#1–#7) | Hub creates a box, box connects, hub can send `echo` |
| **M1 Prototype** (done) | Chat with a pi agent in the web UI; its tools run in the session's own box; watch the box's desktop; every session has a trajectory. See §11.1 | Met; §11.1 |
| **M2 Browser & vault** | Have the agent work on websites in the box's Chromium while you watch, take over the desktop, keep keys and logins in a vault the model never reads, see command output live. See §11.2 | S2 works; §11.2 |
| **M3 Anywhere** | Use several models with per-session budgets and spend, follow and approve work from your phone (PWA, Web Push, Telegram). See §11.3 | S3 works; §11.3 |
| **M4 Connections & automation** | Connect external accounts through MCP, run sessions on a schedule or from a webhook, let the agent remember across sessions. See §11.4 | S4 works; §11.4 |
| **M5 Retro & router** | Search past sessions, get lessons from finished work, get a model suggested per task type from past outcomes, keep trajectories for a set period. See §11.5 | S5 works; §11.5 |
| **v1.0** | Install on a fresh VPS in 10 minutes, back up and restore, run many hibernated sessions cheaply on a slim image. See §11.6 | §11.6 |

### 11.1 M1 Prototype (done)

Goal: a usable prototype on the brain/hands split, before any of the polish.
Done on 2026-11-16. All exit criteria are met; the `compose-e2e` CI job installs
by running [docs/install.md](install.md) verbatim and then runs
`deploy/e2e/prototype.ts` against the result, with a faux model.

What shipped:

- **Install**: Docker Compose install with a host-network hub, a box listener reachable only from box networks, the UI/API on loopback (#27, decision 0012, 0020), and the box egress firewall: internet and the hub only (#20, decisions 0023, 0024).
- **Sessions**: the session manager with lazy box start, hibernate as "stop the box", and every box exit classified into a relaunch or a visible failure (#28, #42); a heartbeat on the hub↔box connection (#31, decision 0028).
- **The agent**: the pi runner in the hub on Bun (spike #40), with read, write, edit, bash, ls, find and grep routed to the box over the tool RPC (#41, #43, decision 0011); its state is the event log, and a runner rebuilt after a hub restart continues the conversation (decisions 0015, 0027).
- **Web UI**: session list, a chat that shows tool calls, and a view-only noVNC desktop (#45, #46), on assistant-ui and shadcn/ui (#77, decision 0019). The desktop runs a supervised Chromium (#92, decision 0026).
- **Login and request checks**: local owner login with a one-time setup token (#44, decision 0014), every route behind `authorize` as the signed-in principal (#61), Host, Origin and JSON checks (#33, decision 0010).
- **Model**: the `direct` gateway with the key from the SecretStore (`file:` in the compose install), the model from `.env` (decision 0015).
- **Trajectories and logs**: a complete trajectory per session, structured logs, trace context on tool calls and optional OTLP export (#80, decision 0021).

Exit criteria (all met):

- A fresh `docker compose up` on a Docker host brings up a working hub.
- Create a session from the web UI.
- pi edits files and runs commands in the box (`/workspace`), and the chat shows the tool calls.
- The box's desktop is visible in the web UI.
- Closing and reopening the page continues the session.
- An unauthenticated or cross-origin request cannot create a session or run a command (#33).

The old M2 "Hardening & desktop" items are placed below: takeover, live shell
output and desktop process supervision in M2; base image pinning, slimming
(#15), hibernate polish and resource limits in v1.0. Its test debt (#25, #26)
is done.

### 11.2 M2 Browser & vault

What you can do after M2:

- **The agent drives a browser.** Ask it to work on a website: in the box's Chromium it opens pages, reads them, clicks, types, takes screenshots and switches tabs (#93, §6.2). You watch it on the live desktop. Browser steps and screenshots (stored by hash) are in the trajectory. The agent reads accessibility snapshots with element refs and acts by ref; an action counts as done only when code verifies its `expect`; box-agent uses `playwright-core`. Tool names and details are in §6.2 and [research/browser.md](research/browser.md) (PR #124 (proposed DECISIONS 0032)); `browser_fill` is #118 and the eval is #119.
- **You take over the desktop.** The desktop view accepts your mouse and keyboard while you hold the desktop lock (§8.3); while you hold it, the agent's browser and desktop input tools answer "user is in control", and releasing hands it back.
- **A vault for credentials** (§6.10). A settings page holds model keys, site logins and API tokens, encrypted at rest; the UI shows fingerprints only. The model key and the model are chosen there, not in `.env` or a file (§6.4). The master key is a generated key file, values are AES-256-GCM encrypted, TOTP is computed in the hub, and a site password enters the box only for the one call that uses it (§6.10, [research/vault.md](research/vault.md)). Implementation: #114 (core), #115 (settings).
- **The agent signs in without seeing the password.** It names a vault credential by placeholder; the hub substitutes the value only on the way to the box and redacts it everywhere else (#70).
- **Live command output.** A long `bash` command shows its output in the chat while it runs (§8.2.1; a protocol minor bump).
- **A dead desktop is visible.** If Xvnc or the window manager dies, the box reports a failure instead of showing a black desktop (#15, item 1).

Exit criteria:

- **S2 works** (CI e2e, Docker): on a local test site served inside the box, the agent signs in with a site login from the vault and fills and submits a multi-field form; the test verifies the submitted values on the server side. The session's trajectory has the browser steps and screenshot hashes.
- The login's password, and its base64 and hex forms, appear in no event, trajectory line, log line or model request of that run (the test greps all of them and the faux model's request log).
- While the e2e's person holds the desktop lock, an agent input tool call returns "user is in control"; after release the next one succeeds.
- A fresh install with no `deploy/secrets/model_key` and no `HEARTH_MODEL` gets its model key and model from the settings page, and a new session answers. The API returns no secret value on any route.
- Killing Xvnc in a running box ends in a visible box failure event within a named deadline (box smoke test).
- A `bash` command that prints a line every second for 10 seconds shows its first line in the chat before the command exits.

### 11.3 M3 Anywhere

What you can do after M3:

- **Several models with budgets.** Models go through Bifrost with one virtual key per session, a budget and an explicit model allowlist; you can switch a session's model, and the UI shows per-session spend and tokens (§6.4).
- **Your phone.** Install the web UI as a PWA and get Web Push when a turn finishes, an approval waits or a session fails; or use Telegram: one session per thread, send messages, get results, `/new`, `/list` (§6.6).
- **Approvals.** Risky actions (for example `git push`, `rm -rf`, a payment page) stop and wait for you; approve or deny from the web or Telegram with one tap; a timeout denies (§6.5). Bash commands are parsed before the deny-list applies (#69); approval cards follow one lifecycle on every channel (#71).

Exit criteria:

- **S3 works** (CI e2e): with no web client connected, an agent's `git push` creates an approval; the approval reaches the push and Telegram test doubles; approving on one channel runs the push and updates the card on the other; a second approval left alone is denied at its timeout and the turn says so.
- A session's spend in the UI equals the sum of its rows in Bifrost's request log; a session over its budget is refused with a visible message, not a silent stop.
- The web UI is installable as a PWA (valid manifest and service worker, checked in the e2e's Chromium) and a Web Push arrives when a turn finishes.

### 11.4 M4 Connections & automation

What you can do after M4:

- **Connections.** Add a remote MCP server (URL plus a vault secret) and the agent can use its tools; tokens stay in the hub and write actions go through approvals (#68, a new extension point E11). Composio is an optional provider, off by default because it keeps tokens on a third-party service. Extensions and MCP servers are loaded only from an allowlist (#56).
- **Triggers.** Run a prompt on a cron schedule (with a time zone) or from a webhook with a secret, into a fixed or a new session, and see the trigger history (§6.7). A cron trigger can be gated by a check script and has a notify policy (#72).
- **Memory.** The agent saves and searches notes that outlive a session (`memory_search` / `memory_save`, §6.9).

Exit criteria:

- **S4 works** (CI, with a fake clock): a cron trigger fires once per tick at the set time and time zone; a run whose previous run is still going is recorded as skipped; a webhook with a wrong secret is refused and audited; each run appears in the trigger history with its session and result.
- A tool call through an MCP connection is authorized, audited and approval-gated for writes; the MCP token never appears in a box, an event or a trajectory.
- A note saved with `memory_save` in one session is found by `memory_search` in another.

### 11.5 M5 Retro & router

What you can do after M5:

- **Search.** Full-text search across all sessions (§6.1): "how did we fix auth last week?".
- **Retro and lessons.** A finished session is labelled (task type, outcome), its failure points are found, and 0–3 lessons are proposed; you accept, edit or discard them on a Lessons page, and accepted lessons are given to later sessions as an index the agent can open (#74, §6.8).
- **A model router.** For each task type, Hearth suggests a model from past outcomes and spend, with the numbers; you accept a suggestion before it becomes the default (§6.8).
- **Retention.** Trajectories and events older than a set period are removed (#83; needs a decision on the append-only event log, decision 0006).

Exit criteria:

- **S5 works**: a search for a term from an archived session finds it; a session with three identical tool failures gets a retro that names that failure point and proposes a lesson; after the lesson is accepted, a new session's context contains it.
- With a seeded set of sessions (task type × model × outcome), the router suggests the model with the best outcome per cost for each task type, and nothing changes until it is accepted.
- With a retention period set, data older than it is gone after the next sweep and newer data is untouched (test on a copy of the database).

### 11.6 v1.0

What you can do at v1.0:

- **Install fast**: a fresh VPS to a working session in 10 minutes (G1), with `hearth doctor` and startup preflight probes that name what is wrong (#73).
- **Back up and restore**: the database, session volumes and the vault (with its master key handled as #108 decides).
- **Many idle sessions cost little**: hibernate and wake polished to the §6.3 acceptance.
- **Slim, pinned image**: base image pinned by digest, only box-agent's dependencies, no pi in the box (#15, items 2–4); a desktop-less variant if §12 question 5 says so.
- **Global resource limits**: CPU, memory and disk for all boxes together, on top of the per-box limits that exist (`HEARTH_BOX_CPUS`, `HEARTH_BOX_MEMORY_BYTES`, `HEARTH_BOX_PIDS`, `HEARTH_BOX_DISK_BYTES`).
- **Docs** for install, upgrade, backup and every setting.

Exit criteria:

- Following docs/install.md on a fresh VPS gets to a session that answers in under 10 minutes (timed, once per release).
- A backup taken on one host and restored on another brings back sessions, files and vault secrets that still work.
- The §6.3 acceptance holds: with 50 hibernated sessions, host idle memory differs from zero sessions by < 200 MB; the first tool result on a hibernated session comes in < 15 s.
- The box image has no hub-only dependencies and no pi, its base is pinned by digest, and a box-agent-only change rebuilds only the top layer.
- A box that exceeds its memory limit is stopped and reported; starting a box beyond the global limit is refused with a visible message.

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
11. **Browser automation** (M2): how the agent observes and acts on pages, and which package box-agent uses. Answered by research #107 ([research/browser.md](research/browser.md), PR #124 (proposed DECISIONS 0032)) and recorded in §6.2 and §11.2. Still open: `browser_fill` (#118) and the eval (#119). The lock for user takeover of the desktop is decided in DECISIONS 0033 (wiring: #126).
12. **Vault details** (M2): the master key, the cipher, TOTP, whether a value ever enters the box, and whether to read from an existing password manager. Answered by research #108 ([research/vault.md](research/vault.md)) and recorded in §6.4, §6.10, §9 and §11. Still open: the implementation (#114 core, #115 settings, #129 TOTP, #130 opt-in box-env tokens). Retention of trajectories and events is #83; whether vault audit rows follow the same retention is a proposal, not yet in #83 or the research.

## 13. Success metrics (dogfooding phase)

- Tasks completed through Hearth per week ≥ tasks done with a local agent directly.
- Unattended background tasks (S1) completion rate ≥ 70%.
- At least 3 lessons accepted per week, with fewer repeats of the same failure after acceptance.
- From M2: no credential is kept in `.env` or a file the owner edits, and no credential value shows up in events, trajectories or model requests (checked by searching them for the vault's values).

## 14. Constraints

- All code is written from scratch. No proprietary third-party code or internal documents are copied or referenced; only public open-source projects (under their licenses) and public material are used.
