#!/usr/bin/env bash
# Box entrypoint: start the desktop (Xvnc on loopback, Openbox, a supervised
# Chromium with CDP on loopback), then box-agent.
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
# HEARTH_BOX_REEXEC marks stage 2, so a token that survived the re-exec stops the
# box at once instead of re-executing it forever.
token_file="/run/hearth/join-token"
if [[ -n "${HEARTH_BOX_REEXEC:-}" ]]; then
  unset HEARTH_BOX_REEXEC
  if [[ -n "${HEARTH_JOIN_TOKEN+set}" ]]; then
    echo "hearth-box: HEARTH_JOIN_TOKEN is still set after the re-exec under tini" >&2
    exit 1
  fi
elif [[ $$ -eq 1 || -n "${HEARTH_JOIN_TOKEN+set}" ]]; then
  if [[ -n "${HEARTH_JOIN_TOKEN:-}" ]]; then
    (umask 077 && printf '%s' "${HEARTH_JOIN_TOKEN}" >"${token_file}")
    export HEARTH_JOIN_TOKEN_FILE="${token_file}"
  fi
  tini_flags=()
  [[ $$ -eq 1 ]] || tini_flags=(-s)
  exec env -u HEARTH_JOIN_TOKEN HEARTH_BOX_REEXEC=1 /usr/bin/tini "${tini_flags[@]}" -- "$0" "$@"
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
# A desktop that is not black, so an empty desktop is told apart from a dead one.
xsetroot -solid '#3b4a5c' || true
openbox >/tmp/openbox.log 2>&1 &

# Chromium on the desktop (PRD §6.2, decision 0026), started once Openbox
# manages windows so it opens maximised.
for _ in $(seq 1 50); do
  [[ "$(xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null)" == *"window id"* ]] && break
  sleep 0.1
done

cdp_port="${HEARTH_CDP_PORT:-9222}"
chromium_profile="/home/hearth/.config/hearth-chromium"
start_url="file:///usr/share/hearth/start.html"
if [[ "${HEARTH_SESSION_ID:-}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  start_url+="#session=${HEARTH_SESSION_ID}"
fi
window_size="${screen/x/,}"
chromium_flags=(
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port="${cdp_port}"
  --user-data-dir="${chromium_profile}"
  --start-maximized
  "--window-position=0,0"
  --window-size="${window_size}"
  --no-first-run
  --no-default-browser-check
  --password-store=basic
  --disable-gpu
  --hide-crash-restore-bubble
)
# The box is Chromium's sandbox (decisions 0007, 0026): the provider sets this
# because the boxes' seccomp profile and no-new-privileges leave Chromium's own
# sandbox no way to start. Any other value keeps Chromium's sandbox on.
if [[ "${HEARTH_CHROMIUM_SANDBOX:-}" == "off" ]]; then
  chromium_flags+=(--no-sandbox)
fi
# Chromium gets a fresh environment, not this script's: nothing from the
# provider's boot env (decision 0018) reaches the browser or its pages.
chromium_env=(
  HOME=/home/hearth
  USER=hearth
  LOGNAME=hearth
  SHELL=/bin/bash
  PATH=/usr/local/bin:/usr/bin:/bin
  LANG=C.UTF-8
  DISPLAY="${display}"
)

# Restarts Chromium whenever it exits (closed by the user or the agent, or
# crashed), waiting 1 s, doubling to 30 s while it keeps exiting within 30 s.
supervise_chromium() {
  local delay=1 started code
  mkdir -p "${chromium_profile}"
  while true; do
    # The profile outlives the container (the home volume); a lock left by the
    # previous container names another host and would block the start.
    rm -f "${chromium_profile}"/Singleton{Lock,Socket,Cookie}
    started="${SECONDS}"
    code=0
    env -i "${chromium_env[@]}" chromium "${chromium_flags[@]}" "${start_url}" || code=$?
    if ((SECONDS - started >= 30)); then delay=1; fi
    echo "hearth-box: chromium exited ${code}; restarting in ${delay}s"
    sleep "${delay}"
    delay=$((delay * 2 > 30 ? 30 : delay * 2))
  done
}
supervise_chromium >>/tmp/chromium.log 2>&1 &

if [[ $# -gt 0 ]]; then
  exec "$@"
fi
exec bun /opt/hearth/apps/box-agent/src/main.ts
