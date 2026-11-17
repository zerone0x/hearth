#!/bin/sh
# Bifrost's start in the compose install (docs/DECISIONS.md, 0046).
#
# Bifrost's admin password and its encryption_key are vault entries. The hub
# writes them into the handoff directory, a tmpfs volume shared with this
# container, once its vault is open; nothing is written to disk beside
# Bifrost's store. This waits for them, exports them under the names
# deploy/bifrost/config.json reads (env.BIFROST_*), copies that config into
# the data directory and runs Bifrost's own entrypoint ("$@").
#
# Settings (the defaults are the compose install's paths):
#   HEARTH_BIFROST_HANDOFF_DIR  default /run/hearth-bifrost
#   HEARTH_BIFROST_CONFIG       default /etc/hearth-bifrost/config.json
#   APP_DIR                     Bifrost's data directory, default /app/data
set -eu

handoff="${HEARTH_BIFROST_HANDOFF_DIR:-/run/hearth-bifrost}"
config="${HEARTH_BIFROST_CONFIG:-/etc/hearth-bifrost/config.json}"
app_dir="${APP_DIR:-/app/data}"

waited=0
until [ -r "$handoff/admin_password" ] && [ -r "$handoff/encryption_key" ]; do
  if [ $((waited % 30)) -eq 0 ]; then
    echo "bifrost: waiting for the hub to hand over its secrets from the vault ($handoff)"
  fi
  sleep 1
  waited=$((waited + 1))
done

BIFROST_ADMIN_PASSWORD="$(cat "$handoff/admin_password")"
BIFROST_ENCRYPTION_KEY="$(cat "$handoff/encryption_key")"
export BIFROST_ADMIN_PASSWORD BIFROST_ENCRYPTION_KEY
cp "$config" "$app_dir/config.json"
echo "bifrost: secrets received from the hub; starting"
exec "$@"
