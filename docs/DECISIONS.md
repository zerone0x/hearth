# Decision log

Numbered, append-only. Each entry records a choice that the PRD leaves open or a
change in scope. To reverse a decision, add a new entry that supersedes it.

## 0001: Stack and repo scaffold

- Date: 2026-11-15
- Status: accepted
- Issue: #1

### Decision

- **Runtime and package manager: Bun 1.4.4** (`packageManager` in the root
  `package.json`), with Bun workspaces `apps/*` and `packages/*`:
  `apps/hub`, `apps/box-agent`, `packages/protocol`, `packages/core`. Package
  names are scoped `@hearth/*`. The lockfile `bun.lock` is committed, and
  `bunfig.toml` saves exact versions.
- **No build step between workspaces.** Each workspace exports `./src/index.ts`
  and Bun runs TypeScript directly. Bundling or compiling to a single binary is
  left to the deploy work.
- **TypeScript 7.0.2, typecheck only** (`tsc -p tsconfig.json`, `noEmit`). One
  shared `tsconfig.base.json` with `strict` plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
  `noImplicitOverride` and `verbatimModuleSyntax`. The root `tsconfig.json`
  typechecks every workspace and `scripts/` in one pass; each workspace also has
  a `tsconfig.json` for editors.
- **Biome 2.6.7 for lint, import order and formatting.** One fast tool instead of
  ESLint plus Prettier, with no plugin tree to keep in sync. The `recommended`
  preset is on, with one change: `complexity/useLiteralKeys` is off because it
  conflicts with `noPropertyAccessFromIndexSignature` (which requires
  `process.env["NAME"]`). Markdown is excluded, so docs keep their hand
  formatting.
- **Tests: `bun test`**, with `*.test.ts` files next to the code. No other runner.
- **HTTP: Hono 4.13.18** on `Bun.serve`, as in the PRD's stack table.
- **One gate: `bun run check`**, which runs typecheck, lint, format check,
  `bun run pins` and `bun test`. CI runs the same command, so a local pass and a
  CI pass mean the same thing.
- **pi pin check.** `scripts/check-pins.ts` fails when any manifest uses
  `@mariozechner/*`, when an `@earendil-works/pi-*` dependency is not an exact
  version, when they disagree, or when `bun.lock` resolves any
  `@earendil-works/pi-*` package (including transitive ones) to a different
  version. `apps/box-agent` depends on the three pi packages at 1.5.2 from the
  start, so the pin is enforced before any pi code is written.
- **Renovate** (`renovate.json`) groups the `@earendil-works/pi-*` packages into
  one PR, so they always move together (PRD §8.4).
- **The hub listens on `127.0.0.1:8787` by default** (PRD §10), overridable with
  `HEARTH_HOST` and `HEARTH_PORT`. These are listening settings, not secrets.
- **`GET /healthz` does not call `authorize`.** It is a liveness probe for the
  reverse proxy and container runtime, takes no input and returns no workspace
  data. Every other handler calls `authorize` first (PRD §7).
- **Docker-dependent tests** run only when `HEARTH_DOCKER_TESTS=1` is set, so
  `bun run check` passes on machines without Docker.

### Consequences

- Moving to another formatter or test runner would need a new decision entry.
- TypeScript 7 is the native compiler. If a tool the project adopts later only
  supports the TypeScript 5 API, that tool runs separately; the typecheck gate
  stays on `tsc` 7.
