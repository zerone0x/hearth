# Demos

## M0 demo

The M0 exit criterion (PRD §11): the hub creates a box, the box connects, and
the hub sends `echo` and gets it back. Run from the repo root after
`bun install --frozen-lockfile`.

### Without Docker

```sh
bun apps/hub/src/demo.ts
```

It starts a hub on a free loopback port with a database in a temporary
directory, issues a one-time join token for `box_demo`, starts box-agent as a
child process with `HEARTH_HUB_URL`, `HEARTH_BOX_ID` and `HEARTH_JOIN_TOKEN`,
waits for it to connect, and calls the echo endpoint. Expected last lines:

```
box_demo connected
POST /v1/boxes/box_demo/echo -> 200 {"ok":true,"result":{"message":"hello from the hub"}}
```

### With a running hub

```sh
HEARTH_DATA_DIR=/tmp/hearth-data bun run --filter @hearth/hub start
# in another shell, once a box is connected:
curl -s -X POST http://127.0.0.1:8787/v1/boxes/<boxId>/echo -d '{"message":"hi"}'
```

A box that is not connected answers `409` with `box.not-connected`.

### With Docker and the real box image

```sh
pi_version="$(jq -er '.dependencies["@earendil-works/pi-coding-agent"]' apps/box-agent/package.json)"
docker build -f apps/box-agent/Dockerfile --build-arg "PI_VERSION=${pi_version}" -t hearth-box:ci .
HEARTH_DOCKER_TESTS=1 HEARTH_BOX_AGENT_IMAGE=hearth-box:ci \
  bun test apps/hub/src/box/echo.docker.test.ts
```

The test starts a hub, creates the box with `DockerBoxProvider` (its own
bridge network, no published ports), passes the hub URL and join token in the
box's boot environment, waits for the box's own box-agent to dial in, and
checks the echo round trip. CI runs it in the `box-provider` job.

### The reliability tests

```sh
bun test apps/hub/src/box/connection.test.ts
```

Join, echo, a reused join token rejected with `bad-credential`, another
protocol major rejected with `version-mismatch`, and a hub killed mid-stream and
restarted with no lost and no duplicated events.
