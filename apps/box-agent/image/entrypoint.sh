#!/usr/bin/env bash
# Box entrypoint: start the desktop (Xvnc on loopback, Openbox), then box-agent.
#
# With arguments, runs them instead of box-agent once the desktop is up; the smoke
# test uses this to keep a box running while it inspects it.
set -euo pipefail

display="${HEARTH_DISPLAY:-:1}"
vnc_port="${HEARTH_VNC_PORT:-5901}"
screen="${HEARTH_SCREEN:-1280x800}"
socket="/tmp/.X11-unix/X${display#:}"

# Xvnc listens for RFB on loopback only (-localhost) and takes no X11 TCP clients.
# There is no VNC password: only processes inside the box can reach the port, and
# box-agent is the one that relays it to the hub over its own authenticated connection.
Xvnc "${display}" \
  -localhost \
  -rfbport "${vnc_port}" \
  -nolisten tcp \
  -SecurityTypes None \
  -geometry "${screen}" \
  -depth 24 \
  -AlwaysShared \
  >/tmp/xvnc.log 2>&1 &

for _ in $(seq 1 100); do
  [[ -S "${socket}" ]] && break
  sleep 0.1
done
if [[ ! -S "${socket}" ]]; then
  echo "hearth-box: Xvnc did not start on ${display}" >&2
  cat /tmp/xvnc.log >&2 || true
  exit 1
fi

export DISPLAY="${display}"
openbox >/tmp/openbox.log 2>&1 &

if [[ $# -gt 0 ]]; then
  exec "$@"
fi
exec bun /opt/hearth/apps/box-agent/src/main.ts
