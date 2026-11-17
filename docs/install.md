# Install Hearth with Docker Compose

This installs the M1 prototype (PRD §11.1) on one Docker host: the hub with
its web UI, the box image, the box egress firewall, and the Bifrost model
gateway (PRD §6.4, decision 0046). The layout and its
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
- **Bifrost, the model gateway, runs next to the hub** (`maximhq/bifrost`
  v2.5.1, pinned by digest; decision 0046). It is on its own bridge network,
  `hearth-bifrost`, at `172.29.249.2` (`HEARTH_BIFROST_ADDR` and
  `HEARTH_BIFROST_SUBNET` in `.env` change it if that range is taken), with no
  port published. The hub reaches it from the host's network; boxes cannot:
  the firewall rejects private ranges, and it refuses an allow list that
  covers Bifrost's address. Its admin password and the key that encrypts the
  provider keys in its store are vault entries the hub generates; they reach
  Bifrost through a memory-only volume, never a file beside its store. Model
  calls do not go through Bifrost yet (#157), so the hub does not depend on
  it: it starts and stays healthy when Bifrost cannot, and `/healthz` says
  `"bifrost":"unavailable"`.
- **Bifrost needs outbound HTTPS** (see [Bifrost's egress](#bifrosts-egress)).

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
# The build stamped on trajectories and /healthz (decision 0021).
version="$(git describe --always --dirty)"
sed -i "s/^HEARTH_VERSION=.*/HEARTH_VERSION=${version}/" .env
```

Edit `.env`: set `HEARTH_MODEL_PROVIDER` and `HEARTH_MODEL` to the pi provider
and model you use (`anthropic` and `claude-sonnet-5-5` by default). For an
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

On the first start with a vault (next step), the hub copies this key into the
vault as `model-key-<provider>` and saves the model as the Settings page's
choice (decision 0038). `HEARTH_MODEL` in `.env` still wins while it is set;
to manage the model and its key on the Settings page instead, empty the
`HEARTH_MODEL_PROVIDER` and `HEARTH_MODEL` lines and restart the hub. Keep the
`secrets/model_key` file until a release drops it from `compose.yaml`.

### Create the vault key

The vault (decision 0031) encrypts the secrets you add in Settings with a key
kept outside the database: `deploy/secrets/vault_key`, the base64 of 32 random
bytes. This step creates it, readable only by you (and root, which the hub runs
as). It never overwrites an existing key, so it is safe to run again; every
upgrade runs it too. You never type, paste or edit this file:

```sh install:vault-key
[ -e secrets/vault_key ] || (umask 077 && head -c 32 /dev/urandom | base64 > secrets/vault_key)
```

**Back it up apart from the data volume.** The database alone, or a backup of
the volume, decrypts nothing; the key alone holds no secret. Lose the key and
every secret in the vault is lost. If the file is missing or does not match
the database, the hub still starts with the vault disabled and logs why
(`vault: disabled (key-missing)` or `key-mismatch`); model keys given as
`file:` or `env:` references keep working.

To replace the key, write the new one next to it and restart the hub; it
rewraps the vault under the new key in one transaction and logs
`vault: key rotated`:

```sh
(umask 077 && head -c 32 /dev/urandom | base64 > secrets/vault_key.next)
docker compose up -d --force-recreate --wait hub
```

Then move it over the old one and restart again (the cutover). Until then the
hub runs on `vault_key.next` and says so in its log. Keep the old key with the
backups taken before the rotation; they need it.

```sh
mv secrets/vault_key.next secrets/vault_key
docker compose up -d --force-recreate --wait hub
```

### Bifrost's egress

Bifrost connects out to:

- the model providers whose keys you add (for example `api.anthropic.com`,
  `api.openai.com`), once model calls go through it (#157);
- `getbifrost.ai`, for its model price list (`/datasheet`) and model
  parameters, at its first start and every 24 hours after. **On its first
  start Bifrost v2.5.1 exits if the price list cannot be downloaded** and it
  has none stored yet; compose restarts it until it can. The hub runs
  meanwhile (model calls do not use Bifrost yet). On a host without
  this access, set `framework.pricing.pricing_url` and `model_parameters_url`
  in `deploy/bifrost/config.json` to a mirror you host.

Its MCP catalog sync is off (`mcp_library_sync_interval: 0`). The binary also
names other `getbifrost.ai` addresses and news feeds; which of them it fetches
in this configuration is not verified. Bifrost's egress is not filtered by the
box firewall, which applies to boxes only.

### Start

```sh install:up
docker compose up -d --build --wait hub
# Bifrost (decision 0046): no model call uses it yet, so the hub does not wait for it.
docker compose up -d bifrost || echo "Bifrost did not start; the hub runs without it (see Check it)"
```

The first build takes several minutes (the box image has Chromium and a
desktop). Compose builds the three images, pulls Bifrost's, runs
`box-firewall` (it prints `box-firewall: iptables backend ...` and the rules it
applied), starts Bifrost (it waits for its secrets) and starts the hub once the
firewall is in place. `--wait` returns when the hub's health check passes;
Bifrost is not part of it. The second command starts Bifrost, which waits
for its secrets: the hub creates Bifrost's two vault entries on its first
start (`vault: secret bifrost-admin-password added`) and hands them over.

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

`curl -s http://127.0.0.1:8787/healthz` answers `"boxEgress":"filtered"` and
`"bifrost":"ok"`: the hub reached Bifrost and its admin password was accepted.
`"bifrost":"unavailable"` does not stop the hub (model calls do not use
Bifrost yet); `bifrostState` names what is wrong (`unreachable`,
`unauthorized`, `vault-disabled`, `secrets-unusable`, `box-reachable`), and
the hub's log has a `bifrost:` line with the reason:

```sh install:bifrost
timeout 180 sh -c 'until curl -fsS http://127.0.0.1:8787/healthz | grep -qF "\"bifrost\":\"ok\""; do sleep 2; done'
docker compose logs hub | grep -F 'bifrost: ok'
```

Provider keys you add on the Settings page are pushed to Bifrost from the
vault (`bifrost: provider keys pushed from the vault`); keep adding them there,
never in Bifrost's own UI: a key Bifrost has that the vault does not is
removed at the next push.

The Settings page lists `bifrost-admin-password` and `bifrost-encryption-key`
as "Managed by the hub", without Rotate or Delete: the hub refuses to change
them, because Bifrost's store cannot be read with another encryption key.

### Bifrost's store

Bifrost keeps the provider keys, encrypted with `bifrost-encryption-key`, in
the `hearth_bifrost-data` volume. If that store ever becomes unreadable (the
volume was copied from another install, or the hub's database was restored
from a backup taken before the key existed), Bifrost answers its admin API
with errors, the hub's log shows `bifrost: unreachable` while Bifrost's own
`/health` passes, and inference auth can be off. Reset the store; it holds
nothing the vault does not have, and the hub pushes the provider keys again
once Bifrost is back (`bifrost: provider keys pushed from the vault`):

```sh
docker compose rm -sf bifrost
docker volume rm hearth_bifrost-data
docker compose up -d bifrost
```
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
# Bifrost: its failure does not fail the unit (model calls do not use it yet).
ExecStart=-/usr/bin/docker compose up -d bifrost
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
# The new build's version (an .env from before HEARTH_VERSION gets the line).
grep -q '^HEARTH_VERSION=' .env || echo 'HEARTH_VERSION=' >> .env
version="$(git describe --always --dirty)"
sed -i "s/^HEARTH_VERSION=.*/HEARTH_VERSION=${version}/" .env
# The vault key (decision 0031): created if an older install has none, never overwritten.
[ -e secrets/vault_key ] || (umask 077 && head -c 32 /dev/urandom | base64 > secrets/vault_key)
docker compose up -d --build --wait hub
docker compose up -d bifrost || echo "Bifrost did not start; the hub runs without it (see Check it)"
```

Compose rebuilds the images that changed and recreates the hub, then
Bifrost when its pinned image changed. The database
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
rm -f secrets/model_key secrets/vault_key secrets/vault_key.next
```
