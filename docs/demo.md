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
waits for it to connect, and calls the echo endpoint. Among the hub's and
box-agent's log lines it prints:

```
box_demo connected
POST /v1/boxes/box_demo/echo -> 200 {"ok":true,"result":{"message":"hello from the hub"}}
```

The `check` job in CI runs it and fails unless it exits 0 and prints both
lines.

### The whole product

[install.md](install.md) installs the M1 prototype with Docker Compose. The
`compose-e2e` CI job runs that page, then walks the prototype's exit criteria
in a browser (`deploy/e2e/prototype.ts`).

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

### The box firewall (required before the hub starts boxes)

The hub refuses `startBox` with `box.egress-unfiltered` until
`scripts/box-firewall.sh apply` has run since the last boot (decision 0012).
The script writes `/run/hearth/box-egress.applied` once every rule is in
place; `/run` is cleared on reboot, like the rules. `/healthz` reports
`boxEgress` (`filtered`, `unfiltered` or `unrestricted`), and the hub logs a
`WARNING` line at startup when it is not `filtered`.

```sh
sudo scripts/box-firewall.sh apply
```

If the host's DNS resolver is on a private address (a home router), the rules
keep boxes from reaching it. `apply` detects this and prints a warning. Whether
DNS in boxes actually breaks depends on where Docker sends box DNS queries
from (the CI runner's private resolver keeps working), so check with
`docker exec <box container> getent hosts github.com`. If names do not
resolve, apply with the line the warning prints, for example:

```sh
sudo HEARTH_BOX_EGRESS_ALLOW="192.168.1.1/32" scripts/box-firewall.sh apply
```

The rules and the marker are gone after a reboot, and a firewalld reload or
restart can drop the rules while the marker stays. Re-apply at boot, and after
every firewalld restart, with a systemd unit (adjust the path):

```ini
# /etc/systemd/system/hearth-box-firewall.service
[Unit]
Description=Hearth box egress firewall
After=docker.service firewalld.service
Wants=docker.service
PartOf=firewalld.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=HEARTH_BOX_PORT=8788
ExecStart=/opt/hearth/scripts/box-firewall.sh apply
ExecReload=/opt/hearth/scripts/box-firewall.sh apply
ExecStop=/opt/hearth/scripts/box-firewall.sh remove

[Install]
WantedBy=multi-user.target docker.service
```

`PartOf=firewalld.service` restarts the unit when firewalld restarts (and
stops it, rules and marker, when firewalld stops). `firewall-cmd --reload`
goes to firewalld over D-Bus and never reaches systemd, so on a host with
firewalld also run the watcher (it needs `dbus-monitor`, Debian's `dbus-bin`):

```ini
# /etc/systemd/system/hearth-firewalld-watch.service
[Unit]
Description=Re-apply the Hearth box firewall after a firewalld reload
After=dbus.service hearth-box-firewall.service

[Service]
ExecStart=/opt/hearth/scripts/firewalld-reload-watch.sh /usr/bin/systemctl reload hearth-box-firewall.service
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now hearth-box-firewall hearth-firewalld-watch`.

The hub trusts the marker only if root owns it and the directories above it,
and nobody else can write any of them (decision 0023), so
`HEARTH_BOX_EGRESS_MARKER` must point into a root-owned directory such as the
default `/run/hearth`.

To run boxes without the firewall on purpose (a disposable VM, for example),
start the hub with `HEARTH_BOX_EGRESS=unrestricted`: boxes then reach the host,
the LAN and cloud metadata, and the hub says so at every start.

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
