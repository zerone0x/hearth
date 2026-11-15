# @hearth/web

The Hearth web UI: sign-in, session list, chat and desktop (PRD §6.6). Built to
static assets the hub serves same-origin under a strict CSP (decisions 0017
and 0019).

```sh
bun run build:web   # writes apps/web/dist
bun run e2e:web     # Chromium against a real hub (faux model, local box-agent)
```

## Packages

- Chat: `@assistant-ui/react` with `@assistant-ui/react-pi`'s reducer and
  projection over the hub's event log (`src/hearthPi.ts`), through
  `useExternalStoreRuntime` (`src/Thread.tsx`).
- Thread, messages and composer: assistant-ui's registry `thread`
  (`src/components/assistant-ui/elements/thread.aui.tsx`); Hearth's tool card,
  notices, empty state and a flat tool group go in through its `components`
  slots.
- Tool cards: assistant-ui's `ToolFallback` from its shadcn registry.
- Primitives: shadcn/ui (`src/components/ui`, from the shadcn CLI; see
  `components.json`).
- Data fetching and polling: TanStack Query (`src/queries.ts`).
- Desktop: `@novnc/novnc`.

`src/components/ui`, `src/components/assistant-ui` and `src/hooks` are
registry source: update them with the CLI (`bunx shadcn@4.23.0 add <name>`),
not by hand. After the CLI runs:

- point any `import { cn } from "cn"` back at `@/lib/utils` and drop the `cn`
  package it adds;
- re-apply the local edits in `thread.aui.tsx` (decision 0019): the
  composer input `aria-label="Message"`, the send button `aria-label="Send"`,
  the stop button `"Interrupt"` (instead of `Message input`, `Send message`,
  `Stop generating`), `export` on `AssistantMessage`, and the attach button
  wrapped in `AuiIf` on `s.thread.capabilities.attachments`.
  `src/web.test.tsx` fails until they are back.

Tests: `bun run test` runs `src/web.test.tsx` (server-rendered) and then
`src/web.dom.tsx` (happy-dom, its own process).

## Stable accessible names

End-to-end tests (`e2e/run.ts`, and the compose exit e2e of #47) find the UI
by role and label. Keep these names; changing one breaks those tests.

| Where | Element | Name |
|---|---|---|
| Setup | heading | `Set up Hearth` |
| Setup | textbox (label) | `Setup token` |
| Setup, sign-in | password field (label) | `Password` |
| Setup | button | `Set password` |
| Sign-in | heading | `Sign in` |
| Sign-in | button | `Sign in` |
| Any form | alert | the error text (`role="alert"`) |
| Session list | button | `Sign out` |
| Session list | textbox (label) | `New session title` |
| Session list | button | `New session` |
| Session list | list | `Sessions`; each row is a `listitem` with `data-testid="session-row"` and a link |
| Session | link | `Sessions` (back to the list) |
| Session | textbox (label) | `Message` |
| Session | button | `Send` (while idle), `Interrupt` (while a turn runs) |
| Session | tool card button | `Tool call <tool>: <status>`, status one of `running`, `done`, `error`, `outcome unknown`, `interrupted`; the card has `data-testid="tool-card"` and `data-status` (`running`, `ok`, `error`, `outcome-unknown`, `interrupted`) |
| Session | region | `Desktop` (`data-testid="desktop"`, `data-phase`) |
| Desktop | button | `Open desktop`, `Wake` (asleep), `Reconnect` (ended) |
| Session, narrow screens | button | `Desktop` / `Hide desktop` |
