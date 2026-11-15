#!/usr/bin/env bash
# Host firewall for Hearth boxes (docs/DECISIONS.md, 0012).
#
# Every box network's Linux bridge is named hbx<12 hex> (DockerBoxProvider),
# so these rules match the interface wildcard hbx+ and cover boxes created
# later without any per-box change. A box may then reach:
#   - the hub's box listener: TCP $HEARTH_BOX_PORT on its own bridge's address;
#   - the public internet.
# Everything else is refused: every address of the host itself (INPUT), and
# private, shared, loopback, link-local (169.254.169.254 included), multicast
# and reserved IPv4 ranges beyond the host (DOCKER-USER). Boxes have IPv6 off
# (provider sysctls); IPv6 from hbx+ is dropped here as well.
#
# Usage (as root, once per boot after Docker started; idempotent):
#   scripts/box-firewall.sh apply    install or refresh the rules
#   scripts/box-firewall.sh remove   take them out again
# Settings:
#   HEARTH_BOX_PORT           the hub's box listener port (default 8788)
#   HEARTH_BOX_EGRESS_ALLOW   comma-separated IPv4 CIDRs to let through anyway,
#                             e.g. a LAN DNS resolver ("192.168.1.1/32")
set -euo pipefail

port="${HEARTH_BOX_PORT:-8788}"
allow="${HEARTH_BOX_EGRESS_ALLOW:-}"
iface="hbx+"
in_chain="HEARTH-BOX-IN"
fwd_chain="HEARTH-BOX-FWD"

# Not the internet: RFC 1918, CGNAT, loopback, link-local, "this network",
# IETF protocol assignments, documentation and benchmarking nets, multicast,
# reserved and broadcast.
blocked=(
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
  192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24
  203.0.113.0/24 224.0.0.0/4 240.0.0.0/4
)

case "$port" in
  '' | *[!0-9]*)
    echo "HEARTH_BOX_PORT must be a port number, got '$port'" >&2
    exit 2
    ;;
esac

# Create a chain or empty it if it exists.
fresh_chain() {
  local tool="$1" chain="$2"
  "$tool" -w -N "$chain" 2>/dev/null || "$tool" -w -F "$chain"
}

# Insert a jump at the top of a built-in chain unless it is already there.
ensure_jump() {
  local tool="$1" parent="$2" chain="$3"
  "$tool" -w -C "$parent" -i "$iface" -j "$chain" 2>/dev/null ||
    "$tool" -w -I "$parent" 1 -i "$iface" -j "$chain"
}

drop_jump() {
  local tool="$1" parent="$2" chain="$3"
  while "$tool" -w -D "$parent" -i "$iface" -j "$chain" 2>/dev/null; do :; done
}

drop_chain() {
  local tool="$1" chain="$2"
  "$tool" -w -F "$chain" 2>/dev/null || true
  "$tool" -w -X "$chain" 2>/dev/null || true
}

apply() {
  # Box to host: only the box listener on the box's own bridge address.
  fresh_chain iptables "$in_chain"
  iptables -w -A "$in_chain" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -w -A "$in_chain" -p tcp --dport "$port" \
    -m addrtype --dst-type LOCAL --limit-iface-in -j ACCEPT
  iptables -w -A "$in_chain" -p tcp -j REJECT --reject-with tcp-reset
  iptables -w -A "$in_chain" -j REJECT --reject-with icmp-admin-prohibited
  ensure_jump iptables INPUT "$in_chain"

  # Box to anything beyond the host: the internet only.
  fresh_chain iptables "$fwd_chain"
  local cidr
  if [ -n "$allow" ]; then
    IFS=',' read -r -a extra <<<"$allow"
    for cidr in "${extra[@]}"; do
      iptables -w -A "$fwd_chain" -d "$cidr" -j RETURN
    done
  fi
  for cidr in "${blocked[@]}"; do
    iptables -w -A "$fwd_chain" -d "$cidr" -p tcp -j REJECT --reject-with tcp-reset
    iptables -w -A "$fwd_chain" -d "$cidr" -j REJECT --reject-with icmp-admin-prohibited
  done
  # Docker evaluates DOCKER-USER before its own forwarding rules and creates it
  # on start; create it here too so the rules survive the order of startup.
  iptables -w -N DOCKER-USER 2>/dev/null || true
  ensure_jump iptables DOCKER-USER "$fwd_chain"

  if command -v ip6tables >/dev/null 2>&1; then
    fresh_chain ip6tables "$in_chain"
    ip6tables -w -A "$in_chain" -j DROP
    ensure_jump ip6tables INPUT "$in_chain"
    ensure_jump ip6tables FORWARD "$in_chain"
  fi
  echo "box firewall applied: boxes on $iface reach the host on TCP $port only, and no private ranges"
}

remove() {
  drop_jump iptables INPUT "$in_chain"
  drop_jump iptables DOCKER-USER "$fwd_chain"
  drop_chain iptables "$in_chain"
  drop_chain iptables "$fwd_chain"
  if command -v ip6tables >/dev/null 2>&1; then
    drop_jump ip6tables INPUT "$in_chain"
    drop_jump ip6tables FORWARD "$in_chain"
    drop_chain ip6tables "$in_chain"
  fi
  echo "box firewall removed"
}

case "${1:-}" in
  apply) apply ;;
  remove) remove ;;
  *)
    echo "usage: $0 apply|remove" >&2
    exit 2
    ;;
esac
