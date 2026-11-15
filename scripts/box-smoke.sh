#!/usr/bin/env bash
# Builds the box image and smoke-tests it (issue #5). Needs Docker and jq.
#
#   scripts/box-smoke.sh            # build and check
#   BOX_IMAGE=my/tag scripts/box-smoke.sh
#
# Checks, each under a timeout:
#   - the image is labeled with the pinned pi version, exposes no ports, is not root;
#   - the default command starts the desktop and box-agent, which reports that pi;
#   - `pi --version` prints the version pinned in apps/box-agent/package.json;
#   - Xvnc accepts a local connection (RFB greeting on loopback);
#   - Chromium headless prints its version and renders a page;
#   - with Xvnc and Chromium CDP running, nothing listens on a non-loopback address.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${BOX_IMAGE:-hearth-box:smoke}"
container="hearth-box-smoke-$$"
vnc_port=5901
cdp_port=9222

fail() {
  echo "box-smoke: FAIL: $*" >&2
  exit 1
}
ok() { echo "box-smoke: ok: $*"; }

# Reads /proc/net/{tcp,tcp6,udp,udp6} lines and prints "<scope> <hex ip> <hex port>"
# for every listening socket: TCP in state 0A (LISTEN) and every bound UDP socket
# (state 07). Loopback means 127.0.0.0/8 (little-endian, so the hex ends in 7F), ::1,
# or IPv4-mapped 127.0.0.0/8; anything else is EXPOSED.
classify_listeners() {
  awk '
    $1 == "sl" { next }
    $4 == "0A" || $4 == "07" {
      split($2, a, ":"); ip = a[1]
      loop = (length(ip) == 8 && substr(ip, 7, 2) == "7F") ||
        ip == "00000000000000000000000001000000" ||
        (substr(ip, 1, 24) == "0000000000000000FFFF0000" && substr(ip, 31, 2) == "7F")
      print (loop ? "loopback" : "EXPOSED"), ip, a[2]
    }'
}
if [[ "${1:-}" == "--classify-listeners" ]]; then
  classify_listeners
  exit 0
fi

command -v docker >/dev/null || fail "docker is not available"
command -v jq >/dev/null || fail "jq is not available"

pi_version="$(jq -er '.dependencies["@earendil-works/pi-coding-agent"]' \
  "${root}/apps/box-agent/package.json")" || fail "no pi pin in apps/box-agent/package.json"

cleanup() { docker rm -f "${container}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "box-smoke: building ${image} with pi ${pi_version}"
timeout 1500 docker build \
  -f "${root}/apps/box-agent/Dockerfile" \
  --build-arg "PI_VERSION=${pi_version}" \
  -t "${image}" \
  "${root}" || fail "image build failed"

size_bytes="$(docker image inspect -f '{{.Size}}' "${image}")"
echo "box-smoke: image size: $((size_bytes / 1000000)) MB (${size_bytes} bytes)"

# Image metadata.
label="$(docker image inspect -f '{{index .Config.Labels "dev.hearth.pi.version"}}' "${image}")"
[[ "${label}" == "${pi_version}" ]] || fail "pi label is '${label}', expected ${pi_version}"
ok "label dev.hearth.pi.version=${label}"

exposed="$(docker image inspect -f '{{json .Config.ExposedPorts}}' "${image}")"
[[ "${exposed}" == "null" || "${exposed}" == "{}" ]] || fail "image exposes ports: ${exposed}"
ok "no exposed ports"

user="$(docker image inspect -f '{{.Config.User}}' "${image}")"
[[ -n "${user}" && "${user}" != "root" && "${user%%:*}" != "0" ]] || fail "image runs as root"
ok "runs as user ${user}"

# Default command: desktop, then box-agent (which exits until the hub connection lands).
agent_out="$(timeout 120 docker run --rm "${image}" 2>&1)" || fail "default command failed: ${agent_out}"
[[ "${agent_out}" == *"pi ${pi_version}"* ]] || fail "box-agent output: ${agent_out}"
ok "box-agent: ${agent_out}"

# A running box to inspect.
timeout 60 docker run -d --name "${container}" "${image}" sleep infinity >/dev/null ||
  fail "could not start the box"
in_box() { timeout 60 docker exec "${container}" "$@"; }

for _ in $(seq 1 60); do
  in_box test -S /tmp/.X11-unix/X1 2>/dev/null && break
  sleep 0.5
done
in_box test -S /tmp/.X11-unix/X1 || fail "Xvnc display :1 did not come up"

pi_out="$(in_box pi --version)" || fail "pi --version failed"
[[ "${pi_out}" == "${pi_version}" ]] || fail "pi --version printed '${pi_out}', expected ${pi_version}"
ok "pi --version: ${pi_out}"

rfb="$(in_box bash -c "exec 3<>/dev/tcp/127.0.0.1/${vnc_port} && head -c 12 <&3")" ||
  fail "no connection to Xvnc on 127.0.0.1:${vnc_port}"
[[ "${rfb}" == RFB\ 003.* ]] || fail "Xvnc greeting was '${rfb}'"
ok "Xvnc greets on 127.0.0.1:${vnc_port}: ${rfb%$'\n'}"

chromium_flags=(--headless --no-sandbox --disable-gpu --disable-dev-shm-usage)
chromium_version="$(in_box chromium "${chromium_flags[@]}" --version)" ||
  fail "chromium --headless --version failed"
[[ "${chromium_version}" == Chromium\ * ]] || fail "chromium printed '${chromium_version}'"
ok "${chromium_version}"

dom="$(in_box chromium "${chromium_flags[@]}" --dump-dom 'data:text/html,<p>hearth-smoke</p>' 2>/dev/null)" ||
  fail "chromium could not render a page"
[[ "${dom}" == *"hearth-smoke"* ]] || fail "chromium rendered: ${dom}"
ok "chromium headless renders a page"

# Start Chromium with CDP so the listener check covers it.
timeout 30 docker exec -d "${container}" chromium "${chromium_flags[@]}" \
  --remote-debugging-port="${cdp_port}" --user-data-dir=/tmp/cdp-profile about:blank
cdp=""
for _ in $(seq 1 60); do
  cdp="$(in_box bash -c "exec 3<>/dev/tcp/127.0.0.1/${cdp_port} &&
    printf 'GET /json/version HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' >&3 && cat <&3" 2>/dev/null)" &&
    [[ "${cdp}" == *Browser* ]] && break
  sleep 0.5
done
[[ "${cdp}" == *Browser* ]] || fail "Chromium CDP did not answer on 127.0.0.1:${cdp_port}"
ok "Chromium CDP answers on 127.0.0.1:${cdp_port}"

# Listening sockets in the box's network namespace, from /proc/net (no ss/netstat needed).
listeners="$(in_box cat /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6)" ||
  fail "could not read /proc/net"
report="$(classify_listeners <<<"${listeners}")"
echo "box-smoke: listeners (scope, hex address, hex port):"
while IFS= read -r line; do echo "  ${line}"; done <<<"${report}"
if grep -q "^EXPOSED" <<<"${report}"; then fail "a socket listens on a non-loopback address"; fi
grep -q "^loopback .* $(printf '%04X' "${vnc_port}")$" <<<"${report}" || fail "Xvnc listener not seen"
grep -q "^loopback .* $(printf '%04X' "${cdp_port}")$" <<<"${report}" || fail "CDP listener not seen"
ok "nothing listens on a non-loopback address"

echo "box-smoke: PASS (pi ${pi_version}, image $((size_bytes / 1000000)) MB)"
