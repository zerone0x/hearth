# Hearth PRD

> Status: draft v0.1 · 2026-11-15 · Owner: @zerone0x

## 1. One line

**Hearth is a self-hosted personal agent host: every session gets its own isolated cloud desktop, keeps working after you close your laptop, picks up on your phone, and turns finished work into lessons automatically.**

## 2. Background and positioning

What exists today:

- **Running Claude Code / Codex / pi locally**: stops when the laptop sleeps, no desktop isolation, sessions scattered across each tool's JSONL, nothing learned from past work.
- **Hosted agent platforms**: your data and desktops live on someone else's machines, per-seat pricing, built for teams.
- **Self-hosted team platforms** (e.g. nuphos): feature-rich but team-first; sessions on one machine share a Unix user and X server and can reach each other.

Hearth's position: **built for one person, structured so it can grow into an enterprise edition.**

Differentiators:

1. **One box per session**: each session runs in its own container (pi + Chrome + desktop); sessions cannot see each other.
2. **Hibernate / wake**: idle sessions cost nothing, so dozens can stay around.
3. **pi-native**: uses the pi kernel and extension ecosystem directly, no ACP adapter layer.
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
- A home-grown model gateway, budgets, or billing (left to pi providers or magpie).
- Native iOS / Android apps (PWA first).
- 20+ chat channels; Telegram only.
- Controlling the user's own computer (local computer use).

## 5. Core concepts

| Concept | Definition |
|---|---|
| **Workspace** | Root of ownership. v1 has exactly one with a fixed ID; all data hangs off it. |
| **Session** | An ongoing conversation bound to one box. States: `creating → running ⇄ idle → hibernated → (waking) → running`, plus `failed` / `archived`. |
| **Turn** | One round started by the user (or a trigger), until the agent stops and waits for input. |
| **Box** | A session's execution environment: a container plus a persistent volume. The container is disposable; the volume is the source of truth. |
| **Event** | An append-only record (messages, tool calls, state changes, approvals). All UI, sync and retro derive from the event stream. |
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

- **P0** Image includes pi, Chrome (CDP on loopback only), Xvnc + a lightweight WM, git, common language runtimes.
- **P0** One container per session; workspace and home on a persistent volume.
- **P0** Watch the desktop via noVNC in the web UI. A **Take over** button: while the user holds it, the agent's desktop input tools return "user is in control"; releasing hands it back.
- **P0** Global resource limits (CPU / memory / disk).
- **P1** No inbound ports on the box; all traffic goes over a connection the box opens to the hub (see §8).
- **P2** User-defined images (extending the base image).

### 6.3 Hibernate and wake

- **P0** A session idle for N minutes (default 15) → stop and remove the container, keep the volume.
- **P0** Messaging a hibernated session → start the container, restore the pi session, continue. The user only sees "waking up".
- **P1** Sessions running a scheduled task or waiting on an approval don't hibernate.
- **P2** Process-level snapshots (CRIU) so Chrome page state survives too.

Acceptance: with 50 hibernated sessions, host idle memory differs from zero sessions by < 200 MB; wake to first token < 15 s.

### 6.4 Model access

- **P0** Use pi's own provider configuration (API key / subscription sign-in), managed centrally in hub settings and delivered to boxes.
- **P0** Support an OpenAI- / Anthropic-compatible base URL (e.g. a local magpie gateway).
- **P1** Switch model per session.
- Secrets live only in the hub; boxes get short-lived credentials issued by the hub, or go through a hub proxy (see §12, open questions).

### 6.5 Approvals

- **P0** Configurable tools / command patterns that need approval (e.g. `git push`, `rm -rf`, a payment page on the desktop).
- **P0** Approval cards pushed to Web and Telegram, one tap to approve / deny; timeout defaults to deny.

### 6.6 Entry points

- **P0** Web: session list, chat, desktop, settings. Installable PWA, usable on mobile.
- **P1** Telegram bot: one session per topic / reply thread; send messages, receive results, approve, `/new`, `/list`.
- **P1** Web Push notifications (turn finished, approval needed, failure).

### 6.7 Triggers

- **P1** Cron: expression + time zone + prompt + target (fixed session / new session each time).
- **P1** Webhook: a URL with a secret; the request body is attached to the prompt as context.
- **P1** Trigger history: fire time, session, result.

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
| E4 | **BoxProvider**: `create / start / stop / destroy / snapshot / attach` | Local Docker | Remote Docker, Kubernetes, gVisor, cloud VMs |
| E5 | **Hub↔Box protocol**: box dials out, one multiplexed connection | Same host, over unix socket or localhost | Cross-host / cross-network (enterprise data plane) |
| E6 | **EventStore**: append-only log + cursor reads | SQLite | Postgres, object-storage archive |
| E7 | **SecretStore**: read / write secrets | Encrypted local file (master key from env) | KMS / Vault |
| E8 | **ModelGateway**: how a box gets model access | Direct to providers or via magpie | Unified gateway + budgets + virtual keys |
| E9 | **Channel**: message entry adapters | Web, Telegram | Slack, Teams, Lark, etc. |
| E10 | **Audit**: every `authorize` decision and admin action is written to the event stream | Written, no UI | Audit log UI, compliance export |

Hard rules:

- Business code must not call Docker, read/write SQLite, or read secrets from env directly — only through the interfaces above.
- Every API handler calls `authorize` first, even though v1 always allows.
- The hub never assumes a box is on the same host (no shared addresses or file paths).

## 8. Architecture

```
 Web / PWA        Telegram
     │                │
     ▼                ▼
┌──────────────── hub ─────────────────┐
│ API (HTTP + WS)     Channel adapters │
│ authorize()         Trigger scheduler│
│ Session manager (state machine,      │
│                  hibernate / wake)   │
│ EventStore    SecretStore    Retro   │
│ BoxProvider ──── docker ──────────┐  │
└──────────────▲────────────────────┼──┘
               │ box dials out (WS, multiplexed:
               │ control / events / VNC / files)
     ┌─────────┴───────┐    ┌──────▼─────────┐
     │ box: session A  │    │ box: session B │ …
     │ box-agent (TS)  │    │                │
     │  └ pi SDK       │    │                │
     │ Chrome (CDP)    │    │                │
     │ Xvnc + WM       │    │                │
     │ /workspace (vol)│    │                │
     └────────┬────────┘    └────────────────┘
              ▼
   Models: provider APIs / subscriptions / magpie gateway
```

- **hub**: one process, TypeScript (Bun), SQLite. Owns all state; boxes are disposable.
- **box-agent**: long-running process inside the box. Runs the session with the pi SDK, translates pi events into Hearth events, accepts control commands from the hub, proxies the VNC byte stream.
- **One connection for everything**: the box starts with a one-time token and connects to the hub; control, events, VNC and file transfer are multiplexed on it. The box exposes no ports.
- **Single source of state**: the session state machine lives only in the hub. A box dropping off means the hub decides to fail or restart it; the box never decides on its own.

### 8.1 pi version policy

- Always build on the **latest pi release**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`. Baseline at time of writing: **1.5.2** (2026-11-10).
- The old `@mariozechner/*` package names are frozen at 0.73.x and must not be used.
- All three packages are pinned to one exact version together in the lockfile and the box image; Renovate opens a PR on every pi release, and CI runs the box-agent integration tests against it before merge.
- Integrate through the public SDK (`createAgentSession`, `SessionManager`) and pi extensions only. No patches to pi internals; if something is missing, upstream it or wrap it in an extension.
- The box image records the pi version in a label, and the hub shows it per session, so a session restored after an upgrade is traceable.

Stack (can change before implementation):

| Part | Choice | Why |
|---|---|---|
| hub | Bun + Hono + bun:sqlite | Same TS ecosystem as pi; single-binary deploy |
| box-agent | Bun + `@earendil-works/pi-coding-agent` SDK (`createAgentSession`) | pi-native, in-process; see §8.1 |
| Web | React + Vite + Tailwind, PWA; noVNC | Conventional, works on mobile |
| Box image | Debian slim + TigerVNC + Openbox + Chromium | Light and stable |
| Deploy | docker compose (hub + reverse proxy); hub manages boxes via the Docker socket | One command |

## 9. Data model (sketch)

```
workspace(id, name, created_at)
principal(id, workspace_id, kind, display_name, auth_ref)
session(id, workspace_id, title, state, model, repo_url,
        box_id, last_activity_at, created_at, archived_at)
box(id, workspace_id, session_id, provider, provider_ref,
    volume_ref, state, image, created_at)
event(workspace_id, session_id, seq, ts, type, turn_id, payload_json)
      -- primary key (session_id, seq), append-only
approval(id, workspace_id, session_id, turn_id, tool, summary,
         state, decided_by, decided_at, expires_at)
trigger(id, workspace_id, kind, spec_json, target_json, enabled)
trigger_run(id, trigger_id, session_id, fired_at, result)
lesson(id, workspace_id, scope, text, source_session_id,
       source_seq, state, created_at)
retro(session_id, workspace_id, labels_json, failures_json, created_at)
secret(id, workspace_id, name, ciphertext, created_at)
```

## 10. Security and privacy

- The hub is the only exposed service; it listens on localhost by default. Public access requires the user to set up a reverse proxy with TLS.
- Login: password + optional passkey; session cookie `HttpOnly`, `SameSite=Strict`.
- Boxes are network-isolated from each other (one Docker network per box, egress only to the internet and the hub).
- Boxes hold no long-lived secrets (see §6.4).
- Desktop takeovers, approvals and settings changes are written to the event stream (E10).
- Retro runs locally or against a model the user configured; no data is sent to third parties by default.

## 11. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 Skeleton** (1 wk) | Repo layout, empty hub, box image, BoxProvider (Docker), hub↔box connection | Hub creates a box, box connects, hub can send `echo` |
| **M1 Chat** (1 wk) | box-agent on pi, event stream, web chat page, resume after disconnect | S1 works (without hibernation) |
| **M2 Desktop & hibernation** (1 wk) | noVNC + takeover, hibernate / wake, resource limits | S2 works; §6.3 acceptance met |
| **M3 Anywhere** (1 wk) | PWA, Web Push, Telegram, approvals | S3 works |
| **M4 Automation & retro** (1–2 wk) | Cron / webhook, Retro, Lessons, memory | S4 and S5 work |
| **v1.0** | Docs, one-command install, backup / restore | Fresh VPS to running in 10 minutes |

## 12. Open questions

1. **Giving boxes subscription access safely**: sign in inside the box (simple, but credentials live in the box) vs. proxy all model calls through the hub (safer, but must handle each vendor's protocol). Leaning: hub proxy in v1, or reuse magpie. pi's own containerization guide (Docker Sandboxes / OpenShell credential substitution) is prior art to evaluate.
2. **Persisting and restoring pi session state**: can pi's session files (via `SessionManager`) on the volume fully restore a session hibernated mid-turn? Needs a spike against the current pi release.
3. **Telegram session mapping**: one forum topic per session, or reply threads?
4. **Retro model**: cheap hosted model by default, or allow local models? What cost cap?
5. **Image size**: Chromium + desktop is 1 GB+. Offer a slim, desktop-less variant for pure code sessions?
6. **Name**: Hearth is a working name.

## 13. Success metrics (dogfooding phase)

- Tasks completed through Hearth per week ≥ tasks done with a local agent directly.
- Unattended background tasks (S1) completion rate ≥ 70%.
- At least 3 lessons accepted per week, with fewer repeats of the same failure after acceptance.

## 14. Constraints

- All code is written from scratch. No proprietary third-party code or internal documents are copied or referenced; only public open-source projects (under their licenses) and public material are used.
