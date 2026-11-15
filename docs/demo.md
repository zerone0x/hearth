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
# in another shell:
curl -s -X POST http://127.0.0.1:8787/v1/boxes/<boxId>/echo -d '{"message":"hi"}'
```

Today this can only answer `409` with `box.not-connected`. The hub has the
Docker box provider wired in and listens for each box on its network's gateway
(decision 0012), but nothing in the API starts a box until the session manager
lands (#28). The echo round trip runs in the two setups below, where the test
starts the box itself.

### With Docker and the real box image

```sh
pi_version="$(jq -er '.dependencies["@earendil-works/pi-coding-agent"]' apps/box-agent/package.json)"
docker build -f apps/box-agent/Dockerfile --build-arg "PI_VERSION=${pi_version}" -t hearth-box:ci .
HEARTH_DOCKER_TESTS=1 HEARTH_BOX_AGENT_IMAGE=hearth-box:ci \
  bun test apps/hub/src/box/echo.docker.test.ts
```

The test starts a hub on its production defaults (API on loopback, box
listener on the box network's gateway, decision 0012), starts the box with
`hub.startBox` (its own bridge network, no published ports, the box
listener's URL and a join token in its boot environment), waits for the box's
own box-agent to dial in, checks the echo round trip, and probes the box's
egress. It needs `HEARTH_TEST_LAN_URL` (an HTTP server on a private address)
and `HEARTH_TEST_EGRESS=open` unless `sudo scripts/box-firewall.sh apply` ran. CI runs it in the `box-provider` job.

### The reliability tests

```sh
bun test apps/hub/src/box/connection.test.ts
```

Join, echo, a reused join token rejected with `bad-credential`, another
protocol major rejected with `version-mismatch`, and a hub killed mid-stream and
restarted with no lost and no duplicated events. Raw-socket tests cover the
hub's own checks: `event.append` is authorized and audited per frame, a frame
for another session or boot is not acked and closes the socket with 4003, a
second socket for a box closes the first with 4002, an unanswered echo returns
`504` `rpc.deadline`, and hostile handshakes (expired token, another box's
token, a frame before `hello`, binary junk, oversized fields) are refused.
