#!/usr/bin/env bash
# Box entrypoint: start the desktop (Xvnc on loopback, Openbox), then box-agent.
#
# With arguments, runs them instead of box-agent once the desktop is up; the smoke
# test uses this to keep a box running while it inspects it.
set -euo pipefail

# Stage 1, as PID 1 (decision 0018): move the join token out of the environment
# into a file only box-agent reads (and deletes), then re-exec under tini without
# it. Every process in the box runs as the same uid, so a token left in the
# environment of tini, Xvnc or Openbox would be readable by any tool command
# through /proc/<pid>/environ. tini runs with -s when something else is PID 1
# (`docker run --init`), so it still reaps orphans.
token_file="/run/hearth/join-token"
if [[ $$ -eq 1 || -n "${HEARTH_JOIN_TOKEN+set}" ]]; then
  if [[ -n "${HEARTH_JOIN_TOKEN:-}" ]]; then
    (umask 077 && printf '%s' "${HEARTH_JOIN_TOKEN}" >"${token_file}")
    export HEARTH_JOIN_TOKEN_FILE="${token_file}"
  fi
  tini_flags=()
  [[ $$ -eq 1 ]] || tini_flags=(-s)
  exec env -u HEARTH_JOIN_TOKEN /usr/bin/tini "${tini_flags[@]}" -- "$0" "$@"
fi

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
