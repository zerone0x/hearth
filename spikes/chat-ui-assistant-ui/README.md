# Spike: Hearth chat with assistant-ui (issue #67)

Throwaway. This branch is never merged; see `docs/research/chat-ui.md` on the #67 PR.

Renders a Hearth-shaped event log (`src/events.ts`) with `@assistant-ui/react`
primitives and `@assistant-ui/react-pi`'s pure pi-event reducer and projection,
through `useExternalStoreRuntime`. The adapter is `src/hearthPiClient.ts`.

Run it outside the Bun workspace (it uses npm so it does not touch `bun.lock`):

```sh
npm install --legacy-peer-deps
npx vite build
PW_CHROMIUM=<chrome-headless-shell> node shot.cjs shot-desktop.png 900 900
node --experimental-strip-types project.test.mts   # prints the projection
npm install --no-save typescript@7.0.2 @types/react@19.3.0 @types/react-dom@19.3.0
npx tsc -p tsconfig.json
```

`shot.cjs` serves `dist/` with Hearth's `WEB_CSP` (decision 0017) and exits non-zero
on any console error, page error or CSP report. CSP reports come from a
`securitypolicyviolation` listener added with `page.addInitScript`, so a blocked
`eval`/`new Function` that the page catches (no console error) still fails the run.
Positive control (review rework 1): adding a caught `new Function("")` to `main.tsx`
made it exit 1 with `csp-report: script-src eval ...`; the previous console-only
version exited 0 on the same build. The control was then removed.
Result on 2026-11-15: 3 tool cards, 0 CSP reports, no problems, at 900×900 and
390×844. The same holds with `src/zod-jitless.ts` not imported: the bundle never
calls zod's eval probe, because nothing here compiles a zod object schema, so
jitless had no measured effect in this spike. The screenshots show markdown raw,
because the spike does not render or test markdown; `tsc` 7.0.2 clean; bundle 604.6 kB (182.6 kB gzip) against a
React-only baseline of 218.8 kB (68.3 kB gzip).
