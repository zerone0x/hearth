# Research: chat UI options for Hearth (can we reuse eve's chat UI?)

> Issue #67 · 2026-11-15 · docs only, no code in the main tree. Owner: @zerone0x

## Sources and how to read the citations

Every repo below was shallow-cloned on 2026-11-15. A citation `repo:path:line` is a
line in the tree at the commit listed here. Repo metadata (license field, archived
flag, last push, latest release) is from the GitHub REST API, and package versions,
licenses and sizes are from `npm view`, both read on 2026-11-15.

| Repo | Commit | License | State on 2026-11-15 |
|---|---|---|---|
| `vercel-labs/eve-chat-template` | `d9989e032fc9ea02ef9dcfcaf4bc3b2ae69cb744` | none (no LICENSE file, API license `null`) | **archived**, last push 2026-08-20 |
| `vercel/eve` (framework; the template now lives in `apps/templates/`) | `2e99dc3564dd243224e74b970a3c990b625cc8c0` | Apache-2.0 | active, release `eve@1.0.0-rc.18` on 2026-11-14 |
| `vercel/eve-examples` | `ec923da32e807e8d34e005ef3d76a5f03fb60164` | none | a one-line README: "This repository has moved" to `vercel/eve/apps/templates` |
| `vercel/ai-elements` | `ca8be600bfd01b3131f9bf6134b51602a71f4374` | Apache-2.0 (LICENSE file; API says NOASSERTION) | active, `ai-elements@1.9.1` on 2026-10-14, **deprecated end of Nov 2026** |
| `assistant-ui/assistant-ui` | `6029493d7b20f29f5f10f877de1d6e14c5b595c7` | MIT | active, pushed 2026-11-15; `@assistant-ui/react@0.15.36` (npm, 2026-11-12), `@assistant-ui/react-pi@0.0.33` (2026-11-08) |
| `badlogic/pi-mono` (redirects to `earendil-works/pi`) | `463e17f8dc08a76a1e24e55db37f88de81b4b118` | MIT | active, `v1.5.2` on 2026-11-10 |

Hearth side, branch heads read on 2026-11-15: `main` at `1dbd0e7`; PR #66
(`feat/issue-46-web-ui`) at `9315289`; PR #63 (`feat/issue-43-pi-runner`) at
`444e9cd`.

**Read only as metadata, so unverified beyond that:** `ship-studio/eve-agent-starter`
(no license, 0 stars, pushed 2026-10-22) and `clerk/eve-agents` (no license, pushed
2026-07-28); CopilotKit (MIT, `v1.88.0` on 2026-11-13). I did not read their code.
Also unverified: assistant-ui's eve runtime (`apps/docs/content/docs/runtimes/eve/`
exists in the tree; I did not read it), and whether Streamdown, Shiki, KaTeX or
Mermaid (used by eve's template and AI Elements for markdown) inject inline styles.

**Clean room and licenses.** Nothing is copied into Hearth by this PR. The spike
branch (below) depends on MIT packages from npm and contains only code written for
it.

## Summary

**Stack constraint (owner ruling, 2026-11-15):** Hearth's web UI is React +
Tailwind. Lit and other web-components UI libraries are ruled out, whatever their
other merits. Every candidate below is judged against that.

- **eve's chat UI cannot be reused "directly".** It is not a package. It is app code
  inside a Next.js template (`components/chat/*.tsx` plus `app/_components/*.tsx`),
  typed against eve's own message model (`EveMessage` from `eve/react`) and fed by
  eve's `useEveAgent` hook, which talks to eve's `/eve/v1/*` session API. The
  original repo is archived and has no license; the maintained copy is in
  `vercel/eve` under Apache-2.0. Its layout shell uses inline `<script>` tags that
  Hearth's CSP (0017) forbids. What is worth taking is its **tool-call grouping
  pattern** (one compact row per run of tool calls, summarised as "Read 2 items, Ran
  1 action"), which we can rebuild in a few dozen lines.
- **assistant-ui is the best fit, and it already speaks pi.** Its
  `@assistant-ui/react-pi` package has a browser-safe entry with a **pure reducer**
  over pi AgentSession events and a **projection** into assistant-ui messages. Hearth
  records those same events as `pi.<type>` with a monotonic `seq`, so the adapter is
  "strip the `pi.` prefix, keep the seq". The spike renders a Hearth-shaped event log
  with it in a Vite build served under Hearth's exact CSP with **zero CSP
  violations**, and it type-checks under **TypeScript 7.0.2** with Hearth's compiler
  flags.
- **AI Elements is out:** typed against the AI SDK's `UIMessage`/`ToolUIPart`,
  documented as Next.js + AI SDK only, and deprecated at the end of this month.
- **pi's own web UI is out (ruled out by owner: stack is React + Tailwind):** it is
  built on Lit web components. Independently of that, `@earendil-works/pi-web-ui` is no longer in the pi
  repo (last npm release 0.75.3, May 2026, against pi-ai 0.75; Hearth pins 1.5.2),
  it is Lit web components, and it runs the agent in the browser with keys in
  IndexedDB, the opposite of Hearth's brain-in-the-hub model (0009).

**Recommendation: adopt assistant-ui (primitives + `@assistant-ui/react-pi`'s
reducer and projection) behind Hearth's own polling transport, and borrow the
tool-group pattern from eve.** Details, costs and risks below.

## What Hearth has today

- **Event model.** The runner records every pi AgentSession event as-is, as
  `pi.${event.type}` (`hearth@444e9cd:apps/hub/src/runner/runner.ts:391`), plus
  `runner.*` notices (`runner.ts:276` outcome-unknown, `:353` interrupted, and
  `runner.failed`) and `runner.usage`. `apps/hub/src/runner/runner.test.ts:378-412`
  asserts that the log *contains* these types (`toContain`, not their order):
  agent_start, turn_start, message_update with `text_delta`, message_end,
  tool_execution_start/end and agent_end, plus `runner.entry` and `runner.usage`;
  only `runner.header` is pinned, as the first event.
- **Client reducer.** `hearth@9315289:apps/web/src/chat.ts:100-198` folds the log
  into four item kinds (user, assistant, tool, notice). It reads `message.user` for
  user text (`:106-112`), takes the assistant text from the full message carried by
  each `pi.message_*` event (`:116-130`), opens a tool card on
  `pi.tool_execution_start` and fills it on update/end (`:131-168`), and marks
  still-running tools `interrupted` on `pi.agent_end` (`:169-178`).
  `outcome-unknown` is detected from the error text (`:47-48`, `:158-163`).
- **Rendering.** `apps/web/src/components.tsx:21-90`: a `<details>` card per tool
  with a status pill (running / done / error / outcome unknown / interrupted), plain
  pre-wrapped text for assistant messages (no markdown), and a list. 359 lines in
  `chat.ts` + `components.tsx` together.
- **Constraints.** CSP `default-src 'self'; script-src 'self'; style-src 'self'; …`
  with no `'unsafe-inline'`, and the e2e fails on any CSP console violation
  (`docs/DECISIONS.md:1379-1388` on the PR #66 branch). TypeScript 7.0.2: anything
  that imports the `typescript` JS API does not work
  (`docs/spikes/pi-runner.md:229` on the PR #63 branch).

## Candidates

### 1. eve chat template (vercel-labs/eve-chat-template, now vercel/eve/apps/templates/eve-chat-template)

- **Status and license.** The repo says: "This repository is archived and no longer
  maintained. The maintained eve templates now live in `vercel/eve-examples`"
  (`eve-chat-template:README.md:3-5`), and that repo in turn says it moved to
  `vercel/eve/apps/templates` (`eve-examples:README.md:3`). The archived repo has
  **no LICENSE file**, so by default nothing in it may be copied. The maintained copy
  is covered by `vercel/eve`'s Apache-2.0 `LICENSE` (no separate license file in the
  template directory).
- **What it is.** "This is not a generic stateless chat UI. The browser talks to an
  eve agent through same-origin `/eve/v1/*` routes, persists eve stream events and
  the eve session cursor in either browser storage or Postgres, and uses a static
  Next.js shell" (`eve-chat-template:docs/how-the-chatbot-works.md:7-11`). The core
  is `useEveAgent` from `eve/react`, which "owns the browser transport" and reduces
  eve stream events into messages (`:282-292`), streaming from
  `GET /eve/v1/session/:sessionId/stream?startIndex=<n>` (`:296-306`). Dependencies
  include `next 16.2.6`, `eve ^0.31.3`, `better-auth`, `drizzle-orm`, Neon, Upstash
  and four Streamdown plugins (`eve-chat-template:package.json:24-56`).
- **Data model fit.** The renderer `components/chat/message.tsx` (891 lines;
  776 in the maintained copy) is typed against `EveMessage`, `EveMessagePart` and
  the tool part from `eve/react` (`eve-chat-template:components/chat/message.tsx:3-8`;
  maintained copy `vercel/eve:apps/templates/eve-chat-template/apps/web/components/chat/message.tsx:3`).
  `EveToolPart` carries eve's own call states, capability `kind` and `interaction`
  (`vercel/eve:packages/eve/src/client/message-types.ts:45-110`). It is not the AI
  SDK's `UIMessage` and not pi's message. Feeding it from Hearth means writing a pi →
  `EveMessage` converter with no upstream support, then pinning a pre-1.0 type
  surface (`eve@1.0.0-rc.18`; the archived template pins `^0.31.3`).
- **Is AI Elements the layer it uses?** No. The template has no AI Elements
  components and no `ai` import in its UI; it uses its own `components/chat/*` on top
  of shadcn `components/ui/*`, Streamdown and `use-stick-to-bottom`
  (`components/chat/markdown.tsx:3-8`, `components/chat/conversation.tsx:3-6`).
- **Next.js coupling.** The chat components themselves only use React, lucide and
  shadcn primitives; the one `next/*` import in `components/` is in the auth menu
  (`components/auth/user-menu.tsx:5`). The coupling is in the shell: routing, server
  actions, Suspense bootstrap and `withEve(nextConfig)` (`docs/how-the-chatbot-works.md:24-50`).
  eve itself has a `./vite` export and a TanStack Start template
  (`vercel/eve:packages/eve/package.json` exports; `apps/templates/eve-tanstack-start-template`),
  but that is for running an **eve agent**, which Hearth will not do.
- **CSP.** The maintained template injects inline scripts: `app/layout.tsx:94`
  (`themeScript`), `app/_components/agent-chat-shell.tsx:405` (sidebar cookie hint)
  and `components/auth/auth-display.tsx:35`. Each would violate `script-src 'self'`.
  The chat components themselves have no `style=` or `dangerouslySetInnerHTML`.
- **Tool-call UX (the part worth borrowing).** Consecutive tool parts become one
  `ToolGroup` row (`eve-chat-template:components/chat/message.tsx:328-389`): a status
  icon, a one-line summary, an `sr-only` status label, and a chevron to expand only
  when a call has details. The group status is error > denied > running > completed
  (`:682-698`), and the summary counts calls by category: "Searched N things, Read N
  items, Wrote N items, Ran N actions" (`:713-740`, categories by tool name at
  `:744-760`). Rows auto-open when a call needs input (`:339-349`). Reasoning is a
  collapsible "Thinking…" block, and a "Thinking…" presence row shows only while no
  output has arrived (`docs/how-the-chatbot-works.md:619-633`).
- **Accessibility and mobile.** `role="log"` on the conversation
  (`components/chat/conversation.tsx:15`), `sr-only` tool status, a mobile sidebar
  drawer (`docs/how-the-chatbot-works.md:151-152`). Not tested here.

### 2. Vercel AI Elements

- **Status.** "AI Elements is moving to shadcn/ui. This project will be deprecated at
  the end of November 2026" (`ai-elements:README.md:4`). Prerequisites: "Next.js
  project with AI SDK installed" (`:29`). Apache-2.0 (`ai-elements:LICENSE:1-3`).
  Distributed as shadcn registry source, not a package (`packages/elements` is
  `private`).
- **Data model fit.** The components take AI SDK types: `UIMessage`
  (`packages/elements/src/message.tsx:19`, `conversation.tsx:5`), `ToolUIPart` /
  `DynamicToolUIPart` (`tool.tsx:10`, `confirmation.tsx:6`). Tool states are the AI
  SDK's (`input-streaming`, `input-available`, `approval-requested`,
  `approval-responded`, `output-available`, `output-error`, `output-denied`;
  `tool.tsx:47-55`). The imports are type-only, so a pi → `UIMessage` adapter is
  possible, but Hearth would carry `ai` as a dev dependency for types and map
  outcome-unknown / interrupted onto states that do not mean that.
- **CSP.** `code-block.tsx` uses `style` props and Shiki
  (`code-block.tsx:30, 64, 277, 316`); `schema-display.tsx:110` uses
  `dangerouslySetInnerHTML`. React `style` props go through the CSSOM and are allowed
  by `style-src 'self'`; Shiki HTML strings with `style="…"` attributes inserted as
  HTML would not be. Not tested.
- **Verdict.** Not worth adopting weeks before its deprecation; its successor in
  shadcn/ui was not read (unverified).

### 3. pi's own web UI (`@earendil-works/pi-web-ui`) — ruled out by owner: stack is React + Tailwind

- **Not in the repo any more.** `pi-mono@463e17f:packages/` has `agent, ai, chord,
  codemode, coding-agent, durable, env, evals, mcp, schema, telemetry, tui` and no
  `web-ui`. npm still has `@earendil-works/pi-web-ui@0.75.3` (MIT, last modified
  2026-05-27) and the deprecated `@mariozechner/pi-web-ui@0.73.1`; it depends on
  `@earendil-works/pi-ai ^0.75.3` while Hearth pins 1.5.2.
- **Model.** "Built with mini-lit web components and Tailwind CSS v4"
  (`pi-web-ui@0.75.3:README.md:5`). The quick start creates the `Agent`, model and
  API keys **in the browser** with IndexedDB storage (`README.md:24-80`). A
  `<message-list>` element takes pi `AgentMessage[]` directly
  (`src/components/MessageList.ts:12-15`), which is the closest native fit, but it is
  Lit (not React), unmaintained, version-skewed, and ships artifacts, a JS REPL and
  sandboxed iframes Hearth does not want.
- **Verdict.** Ruled out by owner: stack is React + Tailwind, and pi-web-ui is Lit.
  It would not be adoptable anyway for the reasons above. The useful pi-native layer is now assistant-ui's
  `react-pi` (next section).

### 4. assistant-ui (primary candidate)

- **License and maintenance.** MIT (`assistant-ui:LICENSE:1-3`), 13.2k stars,
  pushed 2026-11-15, near-daily npm releases. `@assistant-ui/react@0.15.36` depends
  on `@assistant-ui/core`, `store`, `tap`, `assistant-cloud`, `assistant-stream`,
  `radix-ui`, `react-textarea-autosize`, `safe-content-frame`, `zod` and `zustand`
  (`packages/react/package.json:68-78`; the same ten in the published 0.15.36); it is pre-1.0, so expect API churn
  (example: `makeAssistantToolUI` is now `@deprecated` in favour of toolkit entries or
  `MessagePrimitive.Parts` overrides,
  `packages/core/src/react/model-context/makeAssistantToolUI.ts:7-16`).
- **Runtime model.** `useExternalStoreRuntime` lets the app own the message state and
  supply `messages`, `convertMessage`, `isRunning`, `onNew`, `onCancel`
  (`apps/docs/content/docs/runtimes/custom/external-store.mdx:73-140`). No AI SDK is
  needed.
- **pi support already exists.** `@assistant-ui/react-pi` (MIT, 0.0.33; it has an
  *optional* peer dependency on `@earendil-works/pi-coding-agent >=0.80.8`, which
  1.5.2 satisfies, and a peer on `@assistant-ui/react ^0.15.22`; the spike installs
  with `npm install --legacy-peer-deps`):
  "`@assistant-ui/react-pi` — **browser-safe**. The runtime hook, the pure event
  reducer, the message projection, and the HTTP `PiClient`. This entry **never**
  imports `@earendil-works/pi-*`" (`packages/react-pi/README.md:15-19`). Its
  `PiClientEventBody` is pi's AgentSession event set — `agent_start`, `agent_end`,
  `turn_start/end`, `message_start/update/end` with the full `message`,
  `tool_execution_start/update/end` — plus `{threadId, seq}` "for ordering/dedup"
  (`packages/react-pi/src/types.ts:486-562`). `createPiThreadState`,
  `reducePiThreadState` and `projectPiThreadMessages` are public exports
  (`packages/react-pi/src/index.ts:8-26`); the reducer drops events at or below its
  `lastSeq` (`src/runtime/threadState.ts:217-230`), the same rule as Hearth's
  `applyEvent` (`chat.ts:101`). The `with-pi` example shows the whole stack against a
  local pi (`examples/with-pi/README.md`), but through Next.js routes, which Hearth
  does not need.
- **Data model fit (tested).** Hearth `pi.X` → `{...payload, type: "X", threadId,
  seq}`. In the spike this projects a three-step turn into one user message and one
  assistant message whose parts are text, tool calls with `args`, `result` and
  `isError` joined from the `toolResult` messages (output of `project.test.mts` on
  the spike branch).
- **Tool-call UX.** `MessagePrimitive.GroupedParts` with `groupPartByType` groups
  adjacent parts, for example all tool calls of a step
  (`apps/docs/content/docs/guides/part-grouping.mdx:11-60`), which gives the eve-style
  grouped row. Tool parts carry `status` (`running` / `complete` / `incomplete` /
  `requires-action`). Approvals: tool-call approval gates with `respondToApproval`
  and allow-once / allow-always options (`apps/docs/content/docs/tools/tool-ui.mdx:560-575`),
  human tools via `addResult` (`:384-411`), and in `react-pi`, pi's extension UI
  requests become per-tool approvals (`responseForToolApproval`,
  `src/index.ts:28-35`). Hearth's M3 approvals would need to emit something the
  projection maps to `requires-action` (an `extension_ui_request`-shaped event, or a
  Hearth-specific part). Streaming partial output works through
  `tool_execution_update`.
- **Vite SPA.** Yes. Core packages have no Next.js dependency; the spike is a plain
  Vite 8 build. The `@assistant-ui/vite` plugin is only needed for the
  `"use generative"` toolkit compiler (`apps/docs/content/docs/tools/defining-tools.mdx:50-53`),
  which Hearth does not need.
- **CSP.** No runtime `<style>` injection, `insertRule` or `eval` in `packages/react`,
  `core`, `store`, `tap`, `react-pi` or `react-markdown` sources (grep at the commit
  above). One known issue: "zod probes `new Function` when it builds its first
  object schema, which a strict CSP reports as a script-src violation even though
  zod catches it", fixed with `config({ jitless: true })` imported first
  (`apps/docs/content/docs/guides/vscode.mdx:128-132`, `:234`). The spike imports
  that shim and gets zero violations under Hearth's `WEB_CSP`, but **jitless had no
  measured effect in the spike**: with the shim removed the build also gives zero
  CSP reports, because zod's eval probe is not in the bundle (nothing in the spike
  compiles a zod object schema). It matters once something does, for example tool
  parameter schemas. Hearth's own e2e (0017, `apps/web/e2e/run.ts:54-55` on #66)
  only collects CSP *console* messages, and a caught `new Function` raises a
  `securitypolicyviolation` report with no console error, so it has the same blind
  spot the spike's `shot.cjs` had before review; the #66 rework handles that. Only the primitives used in the
  spike were tested; the styled registry components (`npx assistant-ui add thread`)
  were not.
- **Styling.** Primitives are unstyled; the styled set is shadcn-style source copied
  in by the CLI from the internal `@assistant-ui/ui` package
  (`packages/ui/README.md:1-12`), Tailwind 4 classes. Hearth can keep its own
  Tailwind classes (the spike reuses the current tool-card look).
- **TypeScript 7.0.2.** The spike type-checks with `tsc` 7.0.2 and Hearth's flags
  (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `skipLibCheck`).
  With `skipLibCheck: false` there is one library error, a missing `setImmediate`
  type in `@radix-ui/primitive`, which `skipLibCheck: true` (Hearth's setting)
  hides. Nothing needs the `typescript` JS API.
- **Bundle size (measured, Vite 8 production build).** React-only baseline: 218.8 kB
  JS (68.3 kB gzip). Spike with `@assistant-ui/react` + `react-pi` reducer: 604.6 kB
  (182.6 kB gzip), so about **+386 kB (+114 kB gzip)**. Using `usePiRuntime` (with its
  thread-list runtime) instead was 823.9 kB (244.3 kB gzip). Hearth's current UI
  adds no chat dependency at all.
- **Accessibility and mobile.** Radix-based primitives, `aria-*` on composer and
  viewport (from the source; not audited). The spike was screenshotted at 390×844
  and 900×900 with no layout problems, but the tool cards are Hearth's own markup.

### 5. Others

CopilotKit (MIT, very active) was only checked for license and activity. It is a
full copilot framework with its own runtime protocol (AG-UI); like eve it brings a
backend contract Hearth does not want, so it was not evaluated further
(unverified beyond metadata).

## Comparison

| | Hearth today (PR #66) | eve chat template | AI Elements | pi-web-ui (ruled out by owner: stack is React + Tailwind) | assistant-ui + react-pi |
|---|---|---|---|---|---|
| Ships as | our code, 359 lines | Next.js app code (template) | shadcn registry source | npm (Lit) | npm (React) + optional shadcn source |
| License | ours | archived repo: none; maintained copy: Apache-2.0 | Apache-2.0 | MIT | MIT |
| Maintenance | ours | archived; moved into `vercel/eve` (rc) | deprecated end Nov 2026 | dropped from pi repo, last npm May 2026 | daily releases, pre-1.0 churn |
| Message model | Hearth events | `EveMessage` (eve's own) | AI SDK `UIMessage` | pi `AgentMessage` | pi events → its own `ThreadMessageLike` via `react-pi` |
| Feeds from Hearth log | yes | only via a new pi → eve converter | via a pi → `UIMessage` converter | yes, but runs the agent in the browser | **yes: strip `pi.` prefix (tested)** |
| Needs its backend | no | eve session API (`/eve/v1/*`) | AI SDK route handlers (by design) | in-browser `Agent` + keys | no (`useExternalStoreRuntime`) |
| Vite SPA without Next.js | yes | components yes, shell no | yes with work (documented for Next.js) | yes | **yes (tested)** |
| Strict CSP (0017) | yes | shell has 3 inline scripts | untested; Shiki/inline-HTML risks | untested; artifacts use iframes | **yes, 0 CSP reports (tested; jitless not needed by the spike)** |
| TypeScript 7.0.2 | yes | untested | untested | untested | **yes with `skipLibCheck` (tested)** |
| Tool grouping | no | yes (best summary text) | no (per-tool cards) | no | yes (`GroupedParts`) |
| Collapsible output, status | yes, 5 states | yes, 4 states | yes, 7 AI SDK states | yes | yes; Hearth maps its 5 states |
| Approvals (M3) | no | eve `interaction` parts | `Confirmation` | no | approval gates + pi extension UI requests |
| Markdown | no | Streamdown (+ Shiki, KaTeX, Mermaid) | Streamdown | yes | `@assistant-ui/react-markdown` (not tested) |
| Extra JS | 0 | n/a (whole app) | per component | ~1.7 MB unpacked | +386 kB min / +114 kB gzip |

**eve vs assistant-ui, head to head.** eve's UI is a well-designed *app* for eve's
runtime; reusing it means taking its message type and transport and stripping a
Next.js shell, with no upstream support for pi. assistant-ui is a *library* that
already ships a pi adapter whose event contract is the one Hearth records, and it
works in Hearth's Vite build and CSP as is. eve wins on tool-row polish; we can copy
that idea, not its code.

## Recommendation

**Adopt assistant-ui** (`@assistant-ui/react` primitives +
`@assistant-ui/react-pi`'s `reducePiThreadState` and `projectPiThreadMessages`),
driven by `useExternalStoreRuntime` and Hearth's existing cursor polling.
**Borrow patterns only** from eve: grouped tool rows with a counted summary, error
> running > done group status, auto-open when a call needs input, and a
"Thinking…" row only until output arrives. **Do not adopt** AI Elements;
pi-web-ui is ruled out by owner (stack is React + Tailwind).

This assumes the owner's stack: React 19 + Tailwind 4, as Hearth's `apps/web`
already is. assistant-ui fits it directly: its primitives are unstyled React
components, and its styled layer is shadcn-style source with Tailwind 4 classes,
so Hearth either copies those components in or keeps its own Tailwind classes on
the primitives (the spike does the latter).

What we gain: grouping, markdown, reasoning blocks, approval
primitives for M3, a composer with accessible controls, and a reducer maintained
against pi's event set by someone else. What we lose or pay: ~114 kB gzip of JS, a
pre-1.0 dependency with frequent API churn (pin exactly, as 0017 already requires),
a zod-jitless shim once zod compiles object schemas (tool parameter schemas), and Hearth-specific states that need small
extensions (below).

Keep Hearth's own pieces where the library has no notion of them:

- `runner.failed` → `{type: "error"}` (supported); `runner.interrupted` and
  `runner.outcome-unknown` → status overrides on the matching tool part in our own
  tool renderer, as `chat.ts` does today.
- The 64 KiB output clip (`chat.ts:50-51`) stays, applied before the projection.
- `message.user` becomes redundant once pi's own user `message_start/end` is used,
  but the hub must keep recording it for the optimistic bubble before the runner
  starts.

## Adapter sketch

```ts
// Hearth event -> react-pi event. Payload is the pi AgentSessionEvent the runner records.
function toPiClientEvent(threadId: string, e: HubEvent): PiClientEvent | null {
  if (e.type.startsWith("pi.")) {
    return { ...(e.payload as object), type: e.type.slice(3), threadId, seq: e.seq } as PiClientEvent;
  }
  if (e.type === "runner.failed") {
    return { type: "error", error: `The runner failed: ${msgOf(e.payload)}`, threadId, seq: e.seq };
  }
  return null; // runner.interrupted / outcome-unknown: handled by Hearth's tool renderer
}

// In the session view: poll GET /v1/sessions/:id/events?after=<cursor> as today, then
setState((s) => page.events.map((e) => toPiClientEvent(id, e)).filter(Boolean).reduce(reducePiThreadState, s));
const messages = projectPiThreadMessages({ messages: s.messages, toolExecutions: s.toolExecutions,
  runStatus: s.runStatus, hostUiRequests: s.hostUiRequests });
const runtime = useExternalStoreRuntime({
  messages, convertMessage: (m) => m, isRunning: s.runStatus === "running",
  onNew: (m) => api.sendMessage(id, textOf(m)),   // POST /v1/sessions/:id/messages
  onCancel: () => api.interrupt(id),              // POST /v1/sessions/:id/interrupt
});
```

The full version is `src/hearthPiClient.ts` and `src/main.tsx` on the spike branch.

## Spike

Branch `spike/chat-ui-assistant-ui` (never merged), directory
`spikes/chat-ui-assistant-ui/`:

- `src/events.ts`: a hand-written event log in Hearth's envelope
  (`{seq, ts, type, payload}`) with the pi event types `runner.test.ts:378-412`
  asserts are present (it checks membership, not order; it also expects
  `runner.header` first, which the spike log has, and a `runner.entry`, which it
  leaves out because the chat view ignores it), in pi's emit order: one user prompt, two tool calls in one step, a
  failing `npm test`, and a final answer. It is **not** captured from a live hub (no
  Docker here), so payload details beyond what the tests assert are my reading of
  pi's event types.
- `src/main.tsx`: Vite + React 19 + Tailwind 4, `useExternalStoreRuntime`, grouped
  tool rows, Hearth's tool-card markup.
- `shot.cjs`: serves `dist/` with Hearth's exact `WEB_CSP`, loads it in headless
  Chromium, saves a screenshot, and exits non-zero on any console error, page error
  or CSP report. Reports come from a `securitypolicyviolation` listener installed
  with `page.addInitScript` before any page script runs (spike commit `714d3bb`;
  the first version, `da5677d`, only watched the console and so passed a caught
  `eval`). Positive control: a caught `new Function("")` added to `main.tsx` made
  it exit 1 with `csp-report: script-src eval …`, while the console-only version
  exited 0 on the same build; the control was then removed.

Results: 3 tool cards rendered, 0 CSP reports and `problems: []` at 900×900 and
390×844 (also with the zod-jitless shim removed); `tsc` 7.0.2 clean. Screenshots
(spike commit `714d3bb`):
[desktop](https://github.com/zerone0x/hearth/blob/714d3bb/spikes/chat-ui-assistant-ui/shot-desktop.png), [mobile](https://github.com/zerone0x/hearth/blob/714d3bb/spikes/chat-ui-assistant-ui/shot-mobile.png).
Markdown in the final answer is shown raw (`**2 of 3 tests pass**`), because the
spike neither renders nor tests markdown. A first attempt with `usePiRuntime` (react-pi's
full runtime with a thread list) rendered nothing within 10 s with a single
`threadId`; I did not debug it, because the external-store path is the better fit
for Hearth's one-session-per-page UI anyway.

## Proposed follow-up issue

**Title:** Web UI: render the chat with assistant-ui and react-pi's pi-event reducer

**Scope:**
1. Replace `chat.ts`'s reducer and `ChatList` with `@assistant-ui/react` +
   `@assistant-ui/react-pi` (pinned exactly) fed by the existing `/events?after=`
   polling via `useExternalStoreRuntime`; keep the 64 KiB clip and Hearth's tool-card
   look. Stack: React + Tailwind only (owner ruling); style the primitives with
   Tailwind classes or assistant-ui's shadcn-style Tailwind components, and add no
   Lit or other web-components library.
2. Map `runner.failed`, `runner.interrupted` and `runner.outcome-unknown` onto
   message errors and tool-part status, add eve-style grouped tool rows and
   markdown. Enable zod jitless mode before anything imports zod once the UI
   compiles zod object schemas (tool parameter schemas, for example); the spike did
   not need it. The e2e must catch `securitypolicyviolation` reports, not only CSP
   console messages, or a caught eval passes unseen (handled in the #66 rework).
3. Record the dependency and bundle cost in a DECISIONS entry; keep the existing
   chat tests passing against the new renderer (same event logs in, same visible
   states out).
