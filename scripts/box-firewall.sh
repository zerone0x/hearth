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
# and reserved IPv4 ranges beyond the host (DOCKER-USER, reached from FORWARD).
# Boxes have IPv6 off (provider sysctls); IPv6 from hbx+ is dropped here too.
#
# `apply` checks every setting before it touches a rule, then installs the
# whole IPv4 rule set in one iptables-restore transaction, so a failed apply
# leaves the previous rules exactly as they were. Only once every rule is in
# place does it write the marker the hub checks before it starts a box
# ($HEARTH_BOX_EGRESS_MARKER, on tmpfs, so it is gone after a reboot exactly
# like the rules). Without the marker the hub refuses to start boxes unless
# HEARTH_BOX_EGRESS=unrestricted is set.
#
# Usage (as root, once per boot after Docker started; idempotent):
#   scripts/box-firewall.sh apply    install or refresh the rules
#   scripts/box-firewall.sh remove   take them out again
#   scripts/box-firewall.sh check    validate the settings only; change nothing
# Settings:
#   HEARTH_BOX_PORT            the hub's box listener port (default 8788)
#   HEARTH_BOX_EGRESS_ALLOW    comma-separated IPv4 addresses or CIDRs to let
#                              through anyway, e.g. a LAN DNS resolver
#                              ("192.168.1.1/32"), on one line. A /0, an
#                              octet with a leading zero and a newline are
#                              refused.
#   HEARTH_BIFROST_ADDR        the model gateway's IPv4 address on its compose
#                              network (decision 0046). It must lie in a range
#                              these rules reject, and no allow entry may
#                              cover it, so no box reaches Bifrost's admin or
#                              inference API. Empty: no gateway to check.
#   HEARTH_BOX_EGRESS_MARKER   the marker path (default
#                              /run/hearth/box-egress.applied); the hub reads
#                              the same variable
#   HEARTH_RESOLV_CONF         the resolv.conf whose resolvers are checked
#                              (default: systemd-resolved's upstream file if
#                              present, else /etc/resolv.conf)
set -euo pipefail

port="${HEARTH_BOX_PORT:-8788}"
allow="${HEARTH_BOX_EGRESS_ALLOW:-}"
bifrost="${HEARTH_BIFROST_ADDR:-}"
marker="${HEARTH_BOX_EGRESS_MARKER:-/run/hearth/box-egress.applied}"
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

fail() {
  echo "box firewall: $*" >&2
  exit 2
}

# The IPv4 address $1 as an integer, or failure if it is not dotted-quad IPv4.
# An octet with a leading zero ("010") is refused: this script would read it as
# decimal 10, but iptables (inet_aton) reads it as octal 8 and would install a
# different address than the one checked and recorded in the marker.
ip_to_int() {
  local -a o
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  o=("${BASH_REMATCH[@]:1}")
  local x
  for x in "${o[@]}"; do
    [[ "$x" == 0 || "$x" != 0* ]] || return 1
    ((10#$x <= 255)) || return 1
  done
  echo $(((10#${o[0]} << 24) | (10#${o[1]} << 16) | (10#${o[2]} << 8) | 10#${o[3]}))
}

# Normalize one allow entry to address/prefix, or fail with the reason.
check_cidr() {
  local entry="$1" ip prefix
  case "$entry" in
    *:*) fail "HEARTH_BOX_EGRESS_ALLOW takes IPv4 only (box IPv6 is off), got '$entry'" ;;
    */*) ip="${entry%/*}" prefix="${entry#*/}" ;;
    *) ip="$entry" prefix=32 ;;
  esac
  if ! [[ "$prefix" =~ ^[0-9]{1,2}$ ]] || ((10#$prefix > 32)) || ! ip_to_int "$ip" >/dev/null; then
    fail "HEARTH_BOX_EGRESS_ALLOW: '$entry' is not an IPv4 address or CIDR" \
      "(dotted-quad decimal, no leading zeros)"
  fi
  ((10#$prefix > 0)) ||
    fail "HEARTH_BOX_EGRESS_ALLOW: refusing '$entry', it would let boxes reach everything"
  echo "$ip/$((10#$prefix))"
}

# Whether IPv4 address $1 lies in CIDR $2.
in_cidr() {
  local ip net prefix mask
  ip="$(ip_to_int "$1")" || return 1
  net="$(ip_to_int "${2%/*}")" || return 1
  prefix="${2#*/}"
  mask=$(((0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF))
  (((ip & mask) == (net & mask)))
}

# Every check runs before a rule changes: the port and each allow entry.
case "$port" in
  '' | *[!0-9]*) fail "HEARTH_BOX_PORT must be a port number, got '$port'" ;;
esac
((10#$port >= 1 && 10#$port <= 65535)) || fail "HEARTH_BOX_PORT must be 1-65535, got '$port'"
port=$((10#$port))
allowed=()
# `read` below takes only the first line: entries after a newline would be
# dropped without a word, so a newline is an error, not a separator.
case "$allow" in
  *$'\n'*) fail "HEARTH_BOX_EGRESS_ALLOW must be one line of comma-separated entries, got a newline" ;;
esac
if [ -n "$allow" ]; then
  IFS=',' read -r -a entries <<<"$allow"
  for entry in "${entries[@]}"; do
    entry="${entry//[[:space:]]/}"
    [ -n "$entry" ] || continue
    cidr="$(check_cidr "$entry")" || exit 2
    allowed+=("$cidr")
  done
fi

# Bifrost (decision 0046): a rejected private address that no allow entry covers.
if [ -n "$bifrost" ]; then
  ip_to_int "$bifrost" >/dev/null ||
    fail "HEARTH_BIFROST_ADDR: '$bifrost' is not an IPv4 address (dotted-quad decimal, no leading zeros)"
  covered=""
  for cidr in "${blocked[@]}"; do
    if in_cidr "$bifrost" "$cidr"; then covered=1; fi
  done
  [ -n "$covered" ] ||
    fail "HEARTH_BIFROST_ADDR: $bifrost is not in a private range these rules reject; boxes could reach Bifrost"
  for cidr in "${allowed[@]}"; do
    if in_cidr "$bifrost" "$cidr"; then
      fail "HEARTH_BOX_EGRESS_ALLOW: '$cidr' covers Bifrost's address $bifrost; boxes must never reach the model gateway"
    fi
  done
fi

# The rule exists already (so the restore must not insert it again).
has_rule() {
  local tool="$1"
  shift
  "$tool" -w -C "$@" 2>/dev/null
}

has_chain() {
  "$1" -w -S "$2" >/dev/null 2>&1
}

# The IPv4 rule set in iptables-restore format. Declaring a chain empties it
# within the same transaction; built-in chains and DOCKER-USER (when it exists)
# are never declared, so their other rules are kept.
ipv4_rules() {
  local cidr
  echo "*filter"
  echo ":$in_chain - [0:0]"
  echo ":$fwd_chain - [0:0]"
  has_chain iptables DOCKER-USER || echo ":DOCKER-USER - [0:0]"
  # Box to host: only the box listener on the box's own bridge address.
  echo "-A $in_chain -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  echo "-A $in_chain -p tcp --dport $port -m addrtype --dst-type LOCAL --limit-iface-in -j ACCEPT"
  echo "-A $in_chain -p tcp -j REJECT --reject-with tcp-reset"
  echo "-A $in_chain -j REJECT --reject-with icmp-admin-prohibited"
  # Box to anything beyond the host: the internet only.
  for cidr in "${allowed[@]}"; do
    echo "-A $fwd_chain -d $cidr -j RETURN"
  done
  for cidr in "${blocked[@]}"; do
    echo "-A $fwd_chain -d $cidr -p tcp -j REJECT --reject-with tcp-reset"
    echo "-A $fwd_chain -d $cidr -j REJECT --reject-with icmp-admin-prohibited"
  done
  has_rule iptables INPUT -i "$iface" -j "$in_chain" ||
    echo "-I INPUT 1 -i $iface -j $in_chain"
  has_rule iptables DOCKER-USER -i "$iface" -j "$fwd_chain" ||
    echo "-I DOCKER-USER 1 -i $iface -j $fwd_chain"
  # Docker in iptables mode adds this jump itself. With its nftables backend
  # or "iptables": false nothing does, and DOCKER-USER would never be reached.
  has_rule iptables FORWARD -j DOCKER-USER ||
    echo "-I FORWARD 1 -j DOCKER-USER"
  echo "COMMIT"
}

ipv6_rules() {
  echo "*filter"
  echo ":$in_chain - [0:0]"
  echo "-A $in_chain -j DROP"
  has_rule ip6tables INPUT -i "$iface" -j "$in_chain" ||
    echo "-I INPUT 1 -i $iface -j $in_chain"
  has_rule ip6tables FORWARD -i "$iface" -j "$in_chain" ||
    echo "-I FORWARD 1 -i $iface -j $in_chain"
  echo "COMMIT"
}

# The host resolvers Docker's embedded DNS forwards to from the box network:
# systemd-resolved's upstream list when the host uses its stub.
resolv_conf() {
  if [ -n "${HEARTH_RESOLV_CONF:-}" ]; then
    echo "$HEARTH_RESOLV_CONF"
  elif [ -r /run/systemd/resolve/resolv.conf ]; then
    echo /run/systemd/resolve/resolv.conf
  else
    echo /etc/resolv.conf
  fi
}

# Print the allow line for every resolver the rules make unreachable.
check_dns() {
  local file key ns cidr hit line
  local -a unreachable=()
  file="$(resolv_conf)"
  [ -r "$file" ] || return 0
  while read -r key ns _; do
    [ "$key" = nameserver ] || continue
    ip_to_int "$ns" >/dev/null || continue
    # A loopback stub is not used from a box network (Docker falls back).
    if in_cidr "$ns" 127.0.0.0/8; then continue; fi
    hit=""
    for cidr in "${blocked[@]}"; do
      if in_cidr "$ns" "$cidr"; then hit=1; fi
    done
    for cidr in "${allowed[@]}"; do
      if in_cidr "$ns" "$cidr"; then hit=""; fi
    done
    if [ -n "$hit" ]; then unreachable+=("$ns/32"); fi
  done <"$file"
  [ "${#unreachable[@]}" -gt 0 ] || return 0
  line="$(
    IFS=','
    echo "${allowed[*]}${allowed[*]:+,}${unreachable[*]}"
  )"
  # Whether this breaks DNS depends on where Docker's embedded DNS sends the
  # query from: from the box's network it is rejected here; from the host's
  # own namespace (what CI's runner does) it never crosses these rules.
  echo "WARNING: the host resolves names through ${unreachable[*]} ($file)," \
    "a private address these rules keep boxes from reaching. If Docker forwards" \
    "box DNS from the box's network, names do not resolve in boxes. Check with" \
    "'docker exec <box> getent hosts github.com'; if it fails, apply with:" >&2
  echo "  HEARTH_BOX_EGRESS_ALLOW=\"$line\" scripts/box-firewall.sh apply" >&2
}

write_marker() {
  local dir tmp
  dir="$(dirname "$marker")"
  mkdir -p "$dir"
  chmod 0755 "$dir"
  tmp="$(mktemp "$dir/.box-egress.XXXXXX")"
  printf 'applied %s port=%s allow=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$port" \
    "$(
      IFS=','
      echo "${allowed[*]}"
    )" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$marker"
}

apply() {
  command -v iptables-restore >/dev/null || fail "iptables-restore is not installed"
  local v4 v6=""
  v4="$(ipv4_rules)"
  if command -v ip6tables-restore >/dev/null 2>&1; then v6="$(ipv6_rules)"; fi

  # From here on rules change: the hub must not trust an older marker until
  # this apply is complete.
  rm -f "$marker"
  printf '%s\n' "$v4" | iptables-restore -w --noflush ||
    fail "iptables-restore refused the rules; the previous rules are unchanged"
  if [ -n "$v6" ]; then
    printf '%s\n' "$v6" | ip6tables-restore -w --noflush ||
      fail "ip6tables-restore refused the rules; the previous IPv6 rules are unchanged"
  fi

  # Never claim "applied" for rules that cannot match a packet.
  has_rule iptables INPUT -i "$iface" -j "$in_chain" || fail "INPUT does not jump to $in_chain"
  has_rule iptables DOCKER-USER -i "$iface" -j "$fwd_chain" ||
    fail "DOCKER-USER does not jump to $fwd_chain"
  has_rule iptables FORWARD -j DOCKER-USER ||
    fail "FORWARD does not jump to DOCKER-USER; box traffic would skip the rules"

  write_marker
  echo "box firewall applied: boxes on $iface reach the host on TCP $port only," \
    "and no private ranges${allowed[*]:+ except ${allowed[*]}}"
  echo "marker written: $marker (cleared on reboot; apply again after every boot)"
  check_dns
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

remove() {
  # The marker goes first: the hub stops starting boxes before the rules go.
  rm -f "$marker"
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
  check) echo "box firewall settings are valid" ;;
  *)
    echo "usage: $0 apply|remove|check" >&2
    exit 2
    ;;
esac
