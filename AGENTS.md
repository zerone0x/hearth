# Repository rules

These rules apply to every change, by people or agents. `CLAUDE.md` is a symlink
to this file.

## Scope

- `docs/PRD.md` is the source of truth for scope. A change in scope, or a choice
  the PRD leaves open, gets a numbered entry in `docs/DECISIONS.md` in the same PR.
- Decision entries are numbered `0001`, `0002`, … and never renumbered or removed.
  To reverse a decision, add a new entry that supersedes it.

## Language and provenance

- All repo text is in English: code, comments, docs, commit messages, PRs.
- Clean room: never copy code or docs from proprietary sources. Only public
  open-source projects (under their licenses) and public material may be used.
- Do not put personal names in the repo. Where an owner is needed, use `@zerone0x`.

## Layout

| Path | What lives there |
|---|---|
| `apps/hub` | The hub process (Hono on Bun). Owns all state. |
| `apps/web` | The web UI (React + Vite + Tailwind), built to static assets the hub serves (decision 0017). |
| `apps/box-agent` | The process inside a box. Runs pi and dials out to the hub. |
| `packages/protocol` | Hub-box wire protocol: pure types and encode/decode, no I/O. |
| `packages/core` | Extension-point interfaces (PRD §7) and shared types. |
| `scripts` | Repo tooling, such as the pi pin check. |
| `docs` | PRD, decision log, and other docs. |

Workspaces export their TypeScript sources directly (`"exports": "./src/index.ts"`);
there is no build step between workspaces. The one build is `apps/web`
(`bun run build:web`), whose `dist/` the hub serves; it has its own
`tsconfig.json` (DOM types), checked by `bun run typecheck`. Tests sit next to the code as
`*.test.ts`.

## Boundary rules (PRD §7)

- Business code never calls Docker, reads or writes SQLite, or reads secrets from
  the environment directly. It goes through the `packages/core` interfaces
  (`BoxProvider`, `EventStore`, `SecretStore`, …). Only the implementations of
  those interfaces touch the underlying system.
- Every API handler calls `authorize(principal, action, resource)` first, even
  though v1 always allows. The only exception is `GET /healthz` (decision 0001).
- The hub never assumes a box is on the same host: no shared file paths or
  addresses in the protocol or in box config.
- `packages/protocol` stays free of I/O.

## pi

- Use the `@earendil-works/pi-*` packages only. Never `@mariozechner/*` (frozen at 0.73.x).
- All `@earendil-works/pi-*` packages are pinned to the same exact version
  (currently 1.5.2), in every `package.json` and in `bun.lock`.
  `bun run pins` enforces this and is part of `bun run check`.
- Integrate through the public SDK and pi extensions only. No patches to pi internals.

## Gates

- `bun run check` is the single gate: typecheck, lint, format check, pin check and
  tests for the whole repo. Run it before every push and paste its tail in the PR
  under "Local gates".
- CI (`.github/workflows/ci.yml`) runs the same `bun run check`. Never present a CI
  run that did not happen as a pass.
- Tests that need Docker run only when `HEARTH_DOCKER_TESTS=1` is set. A PR lists
  them as "not run" when Docker was not available.
- Run long commands under a timeout. Tests must be hermetic: temporary
  directories, port 0, and no reliance on the user's home or dotfiles.

## Commits and PRs

- Conventional commits: `<type>(<scope>): <subject>`, e.g.
  `feat(protocol): add hello frame`. Types: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`, `perf`, `build`, `ci`.
- PR titles follow the same format. One issue per PR; reference it with `Fixes #N`.
- Stage specific files; never commit `node_modules`, `.env` files or databases.
