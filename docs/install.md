# Install Hearth with Docker Compose

This installs the M1 prototype (PRD §11.1) on one Docker host: the hub with
its web UI, the box image, and the box egress firewall. The layout and its
trade-offs are in decision 0020 (`docs/DECISIONS.md`).

CI runs this page verbatim: every block tagged `install:<step>` is run, in
order, by `scripts/run-doc-block.sh` in the `compose-e2e` job
(`.github/workflows/ci.yml`). Untagged blocks are the ones CI cannot run (a
clone of `main`, an interactive prompt, systemd).

## Prerequisites

- Linux, x86_64 or arm64, with about 4 GB of free disk for the images and
  0.5 GB of RAM per running session.
- Docker Engine 25 or later (Engine API 1.44, decision 0007) and the Compose
  plugin 2.24 or later, run by root (rootless Docker is not supported: the box
  firewall needs the host's network namespace).
- `iptables` on the host is not needed; the firewall runs in a container. The
  host's Docker must use iptables (the default; not `"iptables": false`).
- `git`, and a model API key for a provider pi supports (for example an
  Anthropic key), or an OpenAI-compatible endpoint.

Check Docker and Compose:

```sh install:prereq
docker version --format 'engine {{.Server.Version}} api {{.Server.APIVersion}}'
docker compose version
```

### What the install can do on this host

Read this before you install.

- **The hub holds the Docker socket** (`/var/run/docker.sock`). That is how it
  creates a container, a network and two volumes per session. Whoever controls
  the hub process controls the Docker daemon, which is root on this host. The
  hub runs as root in its container for that reason: a non-root user with the
  socket's group would be no smaller boundary. Keep the UI/API behind its login
  (always on) and on loopback, or behind a TLS reverse proxy.
- **The hub shares the host's network** (`network_mode: host`). It must bind
  each box network's gateway address so boxes can reach it, and nothing else
  can (decision 0012). Its UI/API binds `127.0.0.1:8787`; its box listeners
  bind the box networks' gateways on port 8788.
- **The `box-firewall` one-shot changes the host's iptables rules**: it runs in
  the host's network namespace with `NET_ADMIN` and installs the rules of
  `scripts/box-firewall.sh` (decision 0012), which keep boxes off the host,
  your LAN and cloud metadata. It writes `/run/hearth/box-egress.applied`; the
  hub starts no box without it.

## First run

Get the code (CI tests the checked-out commit instead):

```sh
git clone https://github.com/zerone0x/hearth.git
cd hearth/deploy
```

Every command below runs in `deploy/`.

### Configure

```sh install:configure
cp hearth.env.example .env
```

Edit `.env`: set `HEARTH_MODEL_PROVIDER` and `HEARTH_MODEL` to the pi provider
and model you use (`anthropic` and `claude-sonnet-4-5` by default). For an
OpenAI-compatible endpoint, put a pi `models.json` in `deploy/config/` and set
`HEARTH_MODELS_FILE=/etc/hearth/models.json` (`deploy/config/` is mounted
read-only at `/etc/hearth`), for example:

```json
{
  "providers": {
    "my-endpoint": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "models": [{ "id": "my-model" }]
    }
  }
}
```

with `HEARTH_MODEL_PROVIDER=my-endpoint` and `HEARTH_MODEL=my-model`. The hub
shares the host's network, so `127.0.0.1` there is the host.

### Add the model key

The key goes in a file, never in `.env`: compose mounts
`deploy/secrets/model_key` at `/run/secrets/model_key`, and the hub reads it
through its SecretStore (`HEARTH_MODEL_KEY_REF=file:/run/secrets/model_key`).
It stays in the hub; boxes never see it (PRD §8). Type the key without echoing
it:

```sh
read -rs HEARTH_MODEL_KEY && export HEARTH_MODEL_KEY
```

then write it, readable only by you (and root, which the hub runs as):

```sh install:key
(umask 077 && printf '%s' "$HEARTH_MODEL_KEY" > secrets/model_key)
unset HEARTH_MODEL_KEY
```

A model without a key (a local endpoint) still needs the file; leave it empty.

### Start

```sh install:up
docker compose up -d --build --wait hub
```

The first build takes several minutes (the box image has Chromium and a
desktop). Compose builds the three images, runs `box-firewall` (it prints
`box-firewall: iptables backend ...` and the rules it applied), and starts the
hub once the firewall is in place. `--wait` returns when the hub's health
check passes.

### Set the owner password

A fresh hub has no password. It logs a one-time setup token:

```sh install:setup-token
docker compose logs hub | grep 'setup token'
```

Open `http://127.0.0.1:8787` in a browser on this host. From another machine,
tunnel the port first (`ssh -L 8787:127.0.0.1:8787 <host>`) and open the same
URL there. Enter the setup token and a password of at least 12 characters.
The token stops working once the password is set.

To serve the UI under a domain, put a TLS reverse proxy in front of
`127.0.0.1:8787` and set `HEARTH_PUBLIC_ORIGIN` in `.env` to its origin, for
example `https://hearth.example.com` (decision 0010), then run
`docker compose up -d --wait hub` again.

### Check it

`curl -s http://127.0.0.1:8787/healthz` answers `"boxEgress":"filtered"`.
Create a session in the UI and send a message: the first tool call starts the
session's box, so the first answer takes longer.

## After a reboot

The firewall rules and the marker are gone after a reboot. Docker restarts the
hub, but the hub starts no box (`box.egress-unfiltered`) until the firewall
runs again. A firewalld reload or restart can drop the rules too, while the
marker stays. Run the install again, or let systemd do it at boot and after
every firewalld restart (adjust the path):

```ini
# /etc/systemd/system/hearth.service
[Unit]
Description=Hearth (docker compose)
After=docker.service firewalld.service
Requires=docker.service
PartOf=firewalld.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/hearth/deploy
ExecStart=/usr/bin/docker compose run --rm box-firewall apply
ExecStart=/usr/bin/docker compose up -d --wait hub
ExecReload=/usr/bin/docker compose run --rm box-firewall apply

[Install]
WantedBy=multi-user.target
```

`PartOf=firewalld.service` runs the unit again when firewalld restarts: the
firewall is applied, and the running hub is left as it is. `firewall-cmd
--reload` goes to firewalld over D-Bus and never reaches systemd, so on a host
with firewalld also run the watcher (it needs `dbus-monitor`, Debian's
`dbus-bin`):

```ini
# /etc/systemd/system/hearth-firewalld-watch.service
[Unit]
Description=Re-apply the Hearth box firewall after a firewalld reload
After=dbus.service hearth.service

[Service]
ExecStart=/opt/hearth/scripts/firewalld-reload-watch.sh /usr/bin/systemctl reload hearth.service
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now hearth hearth-firewalld-watch`.

## Upgrade

```sh
git pull --ff-only
```

```sh install:upgrade
docker compose up -d --build --wait hub
```

Compose rebuilds the images that changed and recreates the hub. The database
is in the `hearth_hearth-data` volume and survives; so do the sessions' box
volumes. Running boxes keep running and dial the new hub. A turn running
during the restart is not resumed (PRD §6.3).

## Uninstall

Stop the hub, take the firewall rules out, and remove the session boxes and
their networks. Data stays in the volumes:

```sh install:uninstall
docker compose run --rm box-firewall remove
docker compose down
docker ps -aq --filter label=dev.hearth.managed=true --filter label=dev.hearth.instance=hearth | xargs -r docker rm -f
docker network ls -q --filter label=dev.hearth.managed=true --filter label=dev.hearth.instance=hearth | xargs -r docker network rm
```

To delete everything, also the database, every session's files and the
images:

```sh install:purge
docker volume ls -q --filter label=dev.hearth.managed=true --filter label=dev.hearth.instance=hearth | xargs -r docker volume rm
docker compose down --volumes --rmi all
rm -f secrets/model_key
```
