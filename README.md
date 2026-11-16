# Hearth

A self-hosted personal agent host. Every session gets its own isolated cloud
desktop (pi + Chrome), keeps working after you close your laptop, picks up on
your phone, and turns finished work into lessons.

Status: M1 prototype done (PRD §11.1): the hub with its web UI and login,
sessions whose pi runner works in a Docker box, the box desktop in the browser,
trajectories, and the box egress firewall. Next is M2 Browser & vault. What
you can do today and after each stage is in
[PRD §11](docs/PRD.md#11-milestones). See the [PRD](docs/PRD.md), the
[architecture](docs/ARCHITECTURE.md), the [decision log](docs/DECISIONS.md)
and the [repo rules](AGENTS.md).

## Run it

[docs/install.md](docs/install.md) installs Hearth with Docker Compose on one
host. CI runs that page verbatim in the `compose-e2e` job. On first start the
hub logs a one-time setup token: open the web UI, set the owner password with
it, then sign in (decision 0014).

## Development

Requires [Bun](https://bun.sh) 1.4.4.

```sh
bun install --frozen-lockfile
bun run check      # typecheck + lint + format check + pi pin check + tests
```

`bun run check` is the gate for every change, locally and in CI. It includes
the docs drift checks (`scripts/docs-drift.test.ts`): the configuration table
below and the invariants table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
must match the code.

```sh
bun run dev:hub              # the hub with reload on http://127.0.0.1:8787
bun run build:web            # build the web UI the hub serves (apps/web/dist)
bun apps/hub/src/demo.ts     # hub-box echo without Docker (docs/demo.md)
bun run format               # apply formatting
bun test                     # tests only
```

The API only answers requests whose `Host` is loopback or the bound address
(or the host of `HEARTH_PUBLIC_ORIGIN` behind a reverse proxy), whose
`Origin`, if any, is the hub's own, and whose body is `application/json`
(decision 0010). Every route except `/healthz` and the web UI's static files
needs a login session.

## Configuration

Environment variables, from a grep of the code. A drift check fails
`bun run check` when the code reads a `HEARTH_*` or `OTEL_*` variable this
table does not list. The compose install sets most of them from
`deploy/.env` (`deploy/hearth.env.example`).

Hub:

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `HEARTH_HOST` | `127.0.0.1` | `apps/hub/src/main.ts` | API and web UI listen address |
| `HEARTH_PORT` | `8787` | `apps/hub/src/main.ts` | API and web UI port |
| `HEARTH_PUBLIC_ORIGIN` | unset | `apps/hub/src/main.ts` | origin of a reverse proxy in front of the hub (0010) |
| `HEARTH_DATA_DIR` | `data` | `apps/hub/src/main.ts`, `apps/hub/src/trajectory-cli.ts` | directory of `hearth.db` |
| `HEARTH_WEB_DIR` | `apps/web/dist` if built | `apps/hub/src/main.ts` | built web UI (0017) |
| `HEARTH_MODEL_PROVIDER` | unset | `apps/hub/src/main.ts` | pi provider of the runner's model; required with `HEARTH_MODEL` |
| `HEARTH_MODEL` | unset (runner off) | `apps/hub/src/main.ts` | the runner's model (0015) |
| `HEARTH_MODEL_KEY_REF` | unset | `apps/hub/src/main.ts`, `apps/hub/src/trajectory-cli.ts` | SecretStore reference of the model key, e.g. `file:/run/secrets/model_key` |
| `HEARTH_MODELS_FILE` | unset | `apps/hub/src/main.ts` | absolute path of a pi `models.json` (0020) |
| `HEARTH_VAULT_KEY_REF` | unset (vault disabled) | `apps/hub/src/main.ts`, `apps/hub/src/trajectory-cli.ts` | SecretStore reference of the vault key, the base64 of 32 bytes; compose: `file:/run/hearth-secrets/vault_key` (0031) |
| `HEARTH_VAULT_KEY_NEXT_REF` | unset | `apps/hub/src/main.ts`, `apps/hub/src/trajectory-cli.ts` | the key to rotate the vault to; a missing file means no rotation (0031) |
| `HEARTH_IDLE_MINUTES` | `15` | `apps/hub/src/main.ts` | idle minutes before a session's box is stopped |
| `HEARTH_BOX_PROVIDER` | `docker` | `apps/hub/src/main.ts` | `docker`, or `none` for a hub that starts no boxes |
| `HEARTH_BOX_PORT` | `8788` | `apps/hub/src/main.ts`, `scripts/box-firewall.sh` | box listener port on each box network's gateway (0012) |
| `HEARTH_BOX_IMAGE` | `hearth-box:local` | `apps/hub/src/main.ts` | image of session boxes |
| `HEARTH_BOX_EGRESS` | `filtered` | `apps/hub/src/box/egress.ts` | `unrestricted` starts boxes without the firewall (0012) |
| `HEARTH_BOX_EGRESS_MARKER` | `/run/hearth/box-egress.applied` | `apps/hub/src/box/egress.ts`, `scripts/box-firewall.sh` | firewall marker; trusted only if root-owned (0023, 0024) |
| `HEARTH_VERSION` | package version + git sha | `apps/hub/src/obs/version.ts` | build stamped on `/healthz`, trajectories and spans (0021) |
| `HEARTH_LOG_LEVEL` | `info` | `apps/hub/src/obs/setup.ts` | `debug`, `info`, `warn` or `error` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (no export) | `apps/hub/src/obs/telemetry.ts` | OTLP endpoint for traces and metrics (0021) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | `apps/hub/src/obs/telemetry.ts` | per-signal endpoint for traces |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | `apps/hub/src/obs/telemetry.ts` | per-signal endpoint for metrics (the name is built at run time, so the drift check cannot see it) |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `apps/hub/src/obs/telemetry.ts` | headers for the exporter |
| `OTEL_SDK_DISABLED` | unset | `apps/hub/src/obs/telemetry.ts` | `true` turns export off |

Docker box provider (decision 0007):

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `HEARTH_DOCKER_SOCKET` | `/var/run/docker.sock` | `apps/hub/src/box/docker/config.ts` | Docker Engine socket |
| `HEARTH_DOCKER_API_VERSION` | `1.44` | `apps/hub/src/box/docker/config.ts` | Engine API version the hub speaks |
| `HEARTH_BOX_INSTANCE` | `hearth` | `apps/hub/src/box/docker/config.ts` | name prefix and label of this hub's boxes |
| `HEARTH_BOX_CPUS` | `2` | `apps/hub/src/box/docker/config.ts` | CPU limit per box |
| `HEARTH_BOX_MEMORY_BYTES` | `2147483648` | `apps/hub/src/box/docker/config.ts` | memory limit per box |
| `HEARTH_BOX_PIDS` | `1024` | `apps/hub/src/box/docker/config.ts` | process limit per box |
| `HEARTH_BOX_DISK_BYTES` | unset (no limit) | `apps/hub/src/box/docker/config.ts` | writable layer size limit |
| `HEARTH_BOX_PULL` | `missing` | `apps/hub/src/box/docker/config.ts` | `missing` or `never` |

Box firewall (`scripts/box-firewall.sh`, the compose firewall container):

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `HEARTH_BOX_EGRESS_ALLOW` | unset | `scripts/box-firewall.sh` | IPv4 addresses or CIDRs boxes may reach anyway, e.g. a LAN resolver |
| `HEARTH_RESOLV_CONF` | systemd-resolved's, else `/etc/resolv.conf` | `scripts/box-firewall.sh` | resolv.conf checked for private resolvers |
| `HEARTH_IPTABLES` | detected | `deploy/firewall-entrypoint.sh` | `nft` or `legacy` |
| `HEARTH_DBUS_MONITOR` | `dbus-monitor` | `scripts/firewalld-reload-watch.sh` | monitor command (tests) |

Inside the box (set by the hub or the box image, not by the owner):

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `HEARTH_HUB_URL` | set by the hub | `apps/box-agent/src/main.ts` | box listener URL |
| `HEARTH_BOX_ID` | set by the hub | `apps/box-agent/src/main.ts` | the box's id |
| `HEARTH_JOIN_TOKEN` | set by the hub | `apps/box-agent/src/boot.ts`, `apps/box-agent/image/entrypoint.sh` | one-time join token, moved to a file and scrubbed (0018) |
| `HEARTH_JOIN_TOKEN_FILE` | set by the entrypoint | `apps/box-agent/src/boot.ts` | the token file box-agent reads and deletes |
| `HEARTH_BOX_REEXEC` | set by the entrypoint | `apps/box-agent/image/entrypoint.sh` | marks the re-exec under tini |
| `HEARTH_WORKSPACE_ID` | set by the hub | `apps/hub/src/box/docker/provider.ts` | the box's workspace |
| `HEARTH_SESSION_ID` | set by the hub | `apps/box-agent/image/entrypoint.sh` | the session shown on the desktop's start page |
| `HEARTH_CHROMIUM_SANDBOX` | `off` from the hub | `apps/box-agent/image/entrypoint.sh` | `off` launches Chromium with `--no-sandbox` (0026) |
| `HEARTH_WORKSPACE` | `/workspace` | `apps/box-agent/src/main.ts` | workspace root, for box-agent outside the image |
| `HEARTH_DISPLAY` | `:1` | `apps/box-agent/src/main.ts`, `apps/box-agent/image/entrypoint.sh` | X display of the desktop; the default comes from the image and its entrypoint, not from `main.ts` |
| `HEARTH_VNC_PORT` | `5901` | `apps/box-agent/src/main.ts`, `apps/box-agent/image/entrypoint.sh` | Xvnc port, loopback only (0016) |
| `HEARTH_SCREEN` | `1280x800` | `apps/box-agent/image/entrypoint.sh` | desktop size |
| `HEARTH_CDP_PORT` | `9222` | `apps/box-agent/image/entrypoint.sh` | Chromium DevTools port, loopback only (0026) |
| `HEARTH_EXEC` | set by box-agent | `apps/box-agent/src/tools/process.ts` | marker on each command's processes, to kill them all |

Tests (the e2e harnesses document theirs in `apps/web/e2e/run.ts` and
`deploy/e2e/prototype.ts`):

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `HEARTH_DOCKER_TESTS` | unset (skipped) | `apps/hub/src/box/echo.docker.test.ts` | `1` runs the `*.docker.test.ts` suites |
| `HEARTH_BOX_AGENT_IMAGE` | `hearth-box:ci` | `apps/hub/src/box/echo.docker.test.ts` | box image those suites start |
| `HEARTH_FIREWALL_TESTS` | unset (skipped) | `apps/hub/src/box/firewall.test.ts` | `1` runs the firewall script in network namespaces (root) |
| `HEARTH_TEST_LAN_URL` | none | `apps/hub/src/box/echo.docker.test.ts` | an HTTP server on a private address |
| `HEARTH_TEST_EGRESS` | `filtered` | `apps/hub/src/box/echo.docker.test.ts` | `open` when the firewall is not applied |

## Layout

```
apps/hub            hub process (Hono on Bun): API, sessions, pi runner, box provider
apps/box-agent      runs inside a box: tools, desktop relay; dials the hub
apps/web            web UI (React, built with Vite, served by the hub)
packages/protocol   hub-box wire protocol (types, encode/decode)
packages/core       extension-point interfaces (PRD §7), shared types
deploy              Docker Compose install, hub and firewall images, compose e2e
scripts             box firewall, box image smoke test, pin and docs checks
docs                PRD, architecture, decision log, install and demo guides
spikes              throwaway experiments
```
