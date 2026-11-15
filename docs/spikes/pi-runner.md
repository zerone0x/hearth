# Spike: pi runner on Bun with routed tools and a faux model

- Issue: #40 (M1 Prototype, PRD §11.1 item 3, first step)
- Answers: PRD §12 questions 8, 9 and 10, with evidence for the runner work (#41)
- Code: `spikes/pi-runner/src/` (`runner.ts`, `fake-box.ts`, `runner.test.ts`, `measure.ts`)
- Versions: pi 1.5.2 (`@earendil-works/pi-*`), Bun 1.4.4, TypeScript 7.0.2
- Model credits spent: none. Every model reply comes from pi-ai's `fauxProvider`.

Citations are relative to `node_modules/@earendil-works/pi-coding-agent/`
(`PCA/`) or `node_modules/@earendil-works/pi-agent-core/` (`PAC/`), as installed
for pi 1.5.2. Line numbers refer to the published `dist/` files.

## Summary

| Question | Answer |
|---|---|
| Q8: does the runner's SDK path work on Bun 1.4.4? | **Yes.** `createAgentSession`, `DefaultResourceLoader` with an inline extension, the seven tool overrides, `ModelRuntime` with a native provider, `SessionManager.inMemory` and `abort()` all work under `bun test`. No Node child process is needed. |
| Q9: how do context files and skills reach the runner? | pi discovers them on the **hub's** disk from the runner's cwd upward, plus `agentDir` and `~/.agents/skills`. The runner turns all discovery off and passes the box's `AGENTS.md` through `agentsFilesOverride`, after reading it from the box. Shown in tests. |
| Q10: runner isolation in the hub | In-process is cheap: about **0.3 MB of JS heap per session** after five tool turns, and 20 sessions add about 22 MB RSS. Memory is not a reason to move runners out of process. Crash isolation and one cross-session coupling (pi's global file mutation queue) are the real issues; see Q10. |

The spike test runs in `bun run check` and in CI. It needs no Docker and no network.

## What the spike builds

`createRunner()` (`spikes/pi-runner/src/runner.ts`) is the runner's shape from PRD §8.2.1:

1. `SettingsManager.inMemory({})`, so no settings file on the hub is read.
2. A `DefaultResourceLoader` with `cwd: "/workspace"` (the box path), an empty temp
   `agentDir`, `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`,
   `noContextFiles`, an `agentsFilesOverride` that returns the box's context files,
   and one named inline extension, `hearth-tools`, in `extensionFactories`
   (`PCA/dist/core/resource-loader.d.ts:72-126`, `PCA/dist/core/resource-loader.js:263`).
3. `hearth-tools` registers `read`, `write`, `edit`, `bash`, `ls`, `find` and `grep`
   under their built-in names. Each spreads `create*ToolDefinition("/workspace")`
   and replaces `execute()`. Inside `execute(id, …)` it builds the `*Operations`
   for that one call and calls the built-in definition's `execute` with them,
   so every box call carries pi's tool call id
   (`PCA/docs/extensions.md:2358-2390`, "Overriding Built-in Tools";
   `PCA/docs/extensions.md:2391-2420`, "Remote Execution").
4. `grep` replaces `execute()` as a whole and asks the box. pi's own grep runs the
   hub's `rg` whatever operations it gets (`PCA/dist/core/tools/grep.js:61`).
5. A `tool_call` handler rewrites a leading `~` in path arguments to the box home
   (see "Pitfalls") and then applies the approval policy.
6. `ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })`, then
   `registerNativeProvider(faux.provider)` and `setRuntimeApiKey("faux", …)`
   (`PCA/dist/core/model-runtime.d.ts:93,115`). The real runner passes the session's
   key from the SecretStore in memory the same way.
7. `SessionManager.inMemory("/workspace", undefined, entries)`
   (`PCA/dist/core/session-manager.d.ts:393`) and `createAgentSession({ cwd,
   agentDir, modelRuntime, model, resourceLoader, sessionManager, settingsManager,
   tools: [the seven] })`.

`FakeBox` (`spikes/pi-runner/src/fake-box.ts`) stands in for box-agent. It keeps an
in-memory file system under `/workspace`, records every call with its tool call id,
method, timing and outcome, and can be told to delay or fail a method. It spawns
nothing and touches no hub file, so a result that came from it was routed.

## Evidence (tests in `spikes/pi-runner/src/runner.test.ts`)

| Behaviour | Test | Result |
|---|---|---|
| The seven routed tools replace the built-ins and run in the box | "all seven tools replace the built-ins and run in the box" | Active tools are exactly the seven. `write`, `read`, `edit`, `ls`, `find`, `grep` and `bash` all succeed against `FakeBox`; the hub's `/workspace` is untouched; every box call carries its pi tool call id. |
| The hub's environment does not reach the box | same test | `BashOperations.exec` gets the hub's environment in `env` (`PCA/dist/core/tools/bash.js:159-160`, built from `getShellEnv()`, plus `PI_SESSION_ID` and friends). The override drops it; the box sees `env: undefined`. |
| Parallel tool calls | "sibling tool calls run concurrently in the box" | Three `bash` calls in one assistant message, 200 ms each, overlap in the box and finish in under 600 ms. pi's default tool execution is `parallel` (`PAC/dist/agent.js:147`; `PCA/docs/extensions.md:979`). Results are stored in the assistant message's order, not completion order. |
| Streamed bash output | "bash output streamed through onData …" | See "What pi expects from `onData`" below. |
| Abort | "abort cancels the box command and leaves the session usable" | `session.abort()` (`PCA/dist/core/agent-session.d.ts:678`) aborts the `signal` passed to `BashOperations.exec`; the box sees it, the call ends as a tool error "Command aborted", the model is not asked again, and the next `prompt()` works. |
| `tool_call` block | "a tool_call handler blocks a call before it reaches the box" | A blocked `rm -rf /` never reaches the box; the model gets an error result with the reason (`PAC/dist/agent-loop.js:514`). |
| Thrown backend error | "a thrown backend error becomes a tool error the model sees" | An error thrown by `readFile` or `exec` becomes a tool result with `isError: true` and the error's message as its text (`PAC/dist/agent-loop.js:590-595`); the model's next request sees both. The message is passed through as is, so "outcome unknown" (PRD §8.2.1) can be worded by the runner. |
| Rebuild from stored entries | "a session rebuilt from stored entries continues …" | `[header, ...entries]` through JSON, a new `ModelRuntime`, a new box: the rebuilt session's `messages` equal the original's, and the next model request gets the whole conversation (system, user, assistant tool call, tool result, assistant, new user). Compaction and model changes in the stored entries are not covered here (PRD §12 Q2 asks for that in the runner work). |
| 20 concurrent sessions | "twenty concurrent sessions each finish a routed turn" | 20 sessions, one shared faux runtime, each runs a turn with a routed `bash` call concurrently and finishes. |
| `~` paths | "a ~ path is rewritten to the box home, not the hub's" | Without the rewrite, `~/x` becomes the hub user's home before the operations see it; with it, the box gets `/home/box/x`. |
| Cross-session coupling | "write and edit to the same box path serialize across sessions …" | Two sessions on two boxes writing `shared.txt`: the second write waits for the first. |
| Context discovery (Q9) | "pi's default discovery reads the hub's disk …" and "the runner feeds the box's AGENTS.md …" | See Q9. |

### What pi expects from `onData`

From `PCA/dist/core/tools/bash.d.ts:35-52` and `PCA/dist/core/tools/bash.js:196-330`:

- `exec(command, cwd, { onData, signal, timeout, env })` resolves to
  `{ exitCode }`. `exitCode: null` means "killed without an exit code" and becomes a
  tool error (`bash.js:311`); a non-zero code becomes a tool error with the output
  and "Command exited with code N" (`bash.js:327`).
- `onData(Buffer)` may be called any number of times, with chunks in any split.
  pi accumulates them, keeps the tail (last 2000 lines or 50 KB) and sends the
  session a `tool_execution_update` with the output so far, throttled, after an
  initial empty update (`bash.js:240`). Calling `onData` once at the end, as the M1
  prototype will (PRD §8.2.1), works: the test with the default `FakeBox` handler does
  exactly that. Live output later needs no change on the hub side beyond calling
  `onData` as chunks arrive.
- Errors are matched by message: `"aborted"` becomes "Command aborted" and
  `"timeout:<seconds>"` becomes "Command timed out after N seconds"
  (`bash.js:294-297`). The tool RPC client should throw exactly these for a cancel and
  for the box-side deadline. Any other error's message goes to the model unchanged.
- pi applies the `timeout` itself only in its local backend. A remote backend gets
  `timeout` in seconds and must enforce it (or pass it to the box).
- When the output is truncated, pi writes the full output to a temp file **on the
  hub** and tells the model its path (`PCA/dist/core/tools/output-accumulator.js:45,198`,
  `bash.js` "Full output: …"). The model's next `read` of that path goes to the box,
  where it does not exist. The runner should replace that hint, for example in a
  `tool_result` handler, or have box-agent keep the full output and return its box path.

## Q8: pi on Bun in the hub

Answered: **yes**, for the whole SDK path the runner uses. Everything above runs under
Bun 1.4.4, in `bun test` and in a plain `bun` script. pi asks for Node >= 22.19 in
`engines`; nothing in this path needed Node. The fallback of a Node child process per
runner is not needed.

Measured startup, from `bun spikes/pi-runner/src/measure.ts 20 5` (three runs on a
4-core Linux host under load average about 7, so times are pessimistic):

| Measure | Runs |
|---|---|
| Import of pi-ai and pi-coding-agent (cold, once per hub process) | 651, 811, 746 ms |
| First session (`createRunner`: loader reload plus `createAgentSession`) | 51, 33, 19 ms |
| 19 more sessions created concurrently, total | 42, 46, 39 ms (about 2 ms each) |
| 20 sessions × 5 turns, each turn one routed `bash` call returning 4 KB plus a reply | 443, 450, 605 ms |

## Q9: context files and skills

How pi discovers them (`PCA/dist/core/resource-loader.js:129-210`, `:481-490`):

- Context files: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` (and upper-case
  variants) in `agentDir`, then in the cwd and **every ancestor up to `/`**, on the
  local disk (`resource-loader.js:129,179`). With `cwd: "/workspace"` on the hub, pi
  looks at the hub's `/workspace` and `/`, never at the box.
- Skills: `agentDir/skills`, project `.pi/skills`, `.agents/skills` in the cwd and its
  ancestors, and the hub user's `~/.agents/skills` (`PCA/dist/core/package-manager.js:298,2172-2218`).
- A system prompt file (`SYSTEM.md`, `APPEND_SYSTEM.md`) is also looked up locally
  (`resource-loader.js:490,959`).

The test "pi's default discovery reads the hub's disk …" shows it: a loader with a hub
directory as cwd picks up that directory's `AGENTS.md` and its `.pi/skills` skill.

How Hearth feeds the box's `AGENTS.md` to the runner (shown in "the runner feeds the box's
AGENTS.md through agentsFilesOverride"):

1. Before `loader.reload()`, the runner reads the context files from the box with the
   tool RPC: `/workspace/AGENTS.md` (and, if wanted, the same candidates as pi:
   `AGENTS.override.md`, `CLAUDE.md`).
2. It builds the loader with `noContextFiles: true` and
   `agentsFilesOverride: () => ({ agentsFiles: [{ path: "/workspace/AGENTS.md", content }] })`.
   pi puts the content and the box path into the system prompt; the test checks
   `session.systemPrompt`.
3. `noSkills`, `noPromptTemplates`, `noExtensions` and an empty temp `agentDir` keep
   the hub's own files out. Repo skills from the box can be added later the same way,
   through `skillsOverride`; Lessons (PRD §6.8) can go through `agentsFilesOverride`
   or `appendSystemPrompt`.
4. A changed `AGENTS.md` in the box is picked up on the next `loader.reload()`. When to
   reload (each turn, or when a tool wrote that file) is the runner's choice.

This needs no custom `ResourceLoader`: `DefaultResourceLoader` with discovery turned off
and the overrides is enough (`PCA/docs/sdk.md:108`). The open part: reading the box's
files means the box must be running, which conflicts with lazy start (§6.2) for the first
prompt. Options for #41 or the session manager: start the box before the first turn when
the session has a repo, or cache the last-read `AGENTS.md` in the hub's state.

## Q10: runner isolation in the hub

Memory, measured with `Bun.gc(true)` before each `process.memoryUsage()`
(`bun spikes/pi-runner/src/measure.ts N turns`):

| Run | RSS after import | RSS after create | RSS after turns | Heap used after turns | Heap per session |
|---|---|---|---|---|---|
| N=20, 5 turns (3 runs) | 86.3 / 87.5 / 86.4 MB | 83.9 / 86.0 / 86.1 MB | 107.5 / 108.8 / 109.4 MB | 18.5 MB | 0.3 MB |
| N=1, 5 turns | 85.7 MB | 81.3 MB | 85.6 MB | 14.0 MB | 2.1 MB (includes one-time warm-up) |
| N=100, 5 turns | 85.5 MB | 94.1 MB | 146.3 MB | 27.6 MB | 0.2 MB |
| N=20, 50 turns | 84.8 MB | 84.8 MB | 153.2 MB | 29.0 MB | 0.9 MB |

- The fixed cost is pi's code, about 85 MB RSS once per process. A session costs
  little until its history grows; heap grows with the conversation.
- Turn time grows with history: 20 × 5 turns took about 0.45 s (about 4.5 ms per
  turn), 20 × 50 turns took 11.6 s (about 11.6 ms per turn), because each request
  rebuilds the context from the whole branch. Compaction bounds this in real sessions.
- So memory does not push runners out of process for a single-user hub.

What remains for isolation:

- **Crash isolation is not given.** An uncaught exception or a hang in one runner's
  code (Hearth's extension, a provider) is in the hub process. Errors thrown inside
  a tool's `execute` are caught by pi and become tool errors (shown above), so the
  routed tools are safe; an exception escaping from an event handler or a timer is
  not. The runner should wrap its own callbacks, and the hub should treat an
  unhandled rejection as a runner failure, not a hub failure, where it can tell.
- **One cross-session coupling found.** pi's file mutation queue is module-global and
  keyed by the resolved path (`PCA/dist/core/tools/file-mutation-queue.js:3,27`). All
  runners use `/workspace`, so `write` or `edit` to the same relative path in two
  sessions wait on each other, although they go to two boxes. It is correct but means
  a slow box delays another session's writes to the same path. Accept it for the
  prototype. A per-runner cwd would avoid it but changes the path pi shows the
  model, so the better fix is upstream: key the queue per operations backend.
- Workers or child processes: not needed for M1. If they are needed later, the
  SessionManager entries are plain JSON and the session rebuilds from them (shown
  above), so a runner can move without losing state.

## Pitfalls for the runner (#41)

- **Hub environment.** `BashOperations.exec` gets the hub's whole environment
  (`bash.js:159-160`), as the Gondolin warning says (`PCA/docs/containerization.md:157`).
  The operations must drop it. Done in the spike, checked by the test.
- **`~` means the hub's home.** pi expands `~` in path arguments with the hub's
  `homedir()` before the operations see them (`PCA/dist/core/tools/path-utils.js:42`,
  `PCA/dist/utils/paths.js:112`). The spike rewrites it in `tool_call`.
- **Hub file system probes.** `read` and `write`/`edit` still look at the hub's disk
  with the model's paths: `read` tries macOS name variants with a local `access`
  (`path-utils.js:72`), and the mutation queue calls `realpath` locally
  (`file-mutation-queue.js`). Harmless for Hearth (`/workspace` should not exist on
  the hub), but the hub image should not have a `/workspace`.
- **Truncated output** points at a hub temp file (see `onData` above).
- **Prompt metadata.** `promptSnippet` and `promptGuidelines` are not inherited by an
  override (`PCA/docs/extensions.md:2377`). Spreading `create*ToolDefinition()` keeps
  them, which is why the spike spreads definitions, not `create*Tool()`.
- **Settings and auth files.** Without `settingsManager` and with the default
  `agentDir`, pi reads `~/.pi/agent`. The runner must pass an in-memory settings
  manager and an `agentDir` it owns (empty), and the model key in memory.

## TypeScript 7.0.2 toolchain check (M1/M2)

Checked in a scratch project (not committed) that extends `tsconfig.base.json`, with
a React component that opens a noVNC `RFB`, a Tailwind import and a `vite.config.ts`:

| Tool | Version | With TS 7.0.2 |
|---|---|---|
| `tsc` type check of React + JSX (`jsx: react-jsx`) | react 19.3.1, @types/react 19.3.0 | Works. |
| Vite config typing and build (`bun x --bun vite build`) | vite 8.3.8, @vitejs/plugin-react 6.3.0 | Works. Vite does not use `tsc` to transpile. |
| Tailwind | tailwindcss 4.3.5, @tailwindcss/vite 4.3.5 | Works. |
| CSS side-effect imports (`import "./index.css"`) | | Error TS2882 unless `vite/client` is in `types`. Add it to the web app's tsconfig. |
| noVNC types | @novnc/novnc 1.7.0, @types/novnc__novnc 1.6.0 | The types declare `@novnc/novnc/lib/rfb`, but 1.7.0 exports `RFB` from the package root. Not a TS 7 issue; needs a 5-line `declare module "@novnc/novnc"` shim that re-exports the typed module. |
| Anything that imports the `typescript` JS API | | **Does not work.** `typescript@7.0.2` exports only `version` from its root (`import("typescript")` has no `createProgram`). Tools built on it (typescript-eslint, ts-morph, `vite-plugin-dts`, `vite-plugin-checker`'s TypeScript mode, TS-API codegen such as ts-json-schema-generator) cannot be used. The repo uses Biome, so nothing current breaks. |
| Codegen | none planned | `packages/protocol` is hand-written; no codegen is needed for M1/M2. |

## What remains unknown

- Real model providers on Bun (streaming over the network, retries, provider-specific
  quirks). The faux provider exercises pi's agent loop, not a provider's HTTP client.
- Restore across compaction and model changes (PRD §12 Q2): for the runner work.
- Behaviour of a real tool RPC: latency, reconnects, the "outcome unknown" rule. The
  fake box only shows what pi expects from it.
- Crash isolation in practice (Q10): not tested beyond tool errors.
