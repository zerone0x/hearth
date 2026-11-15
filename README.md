# Hearth

A self-hosted personal agent host. Every session gets its own isolated cloud
desktop (pi + Chrome), keeps working after you close your laptop, picks up on
your phone, and turns finished work into lessons.

Status: M0 skeleton. See the [PRD](docs/PRD.md), the
[decision log](docs/DECISIONS.md) and the [repo rules](AGENTS.md).

## Development

Requires [Bun](https://bun.sh) 1.4.4.

```sh
bun install
bun run check      # typecheck + lint + format check + pi pin check + tests
```

`bun run check` is the gate for every change, locally and in CI.

Other scripts:

```sh
bun run dev:hub    # start the hub with reload on http://127.0.0.1:8787
curl http://127.0.0.1:8787/healthz
bun run format     # apply formatting
bun test           # tests only
```

The hub binds `127.0.0.1:8787` by default; set `HEARTH_HOST` and `HEARTH_PORT`
to change it. Tests that need Docker run only with `HEARTH_DOCKER_TESTS=1`.

## Layout

```
apps/hub            hub process (Hono on Bun)
apps/box-agent      runs inside a box; drives pi and dials the hub
packages/protocol   hub-box wire protocol (types, encode/decode)
packages/core       extension-point interfaces (PRD §7), shared types
scripts             repo tooling
docs                PRD and decision log
```
