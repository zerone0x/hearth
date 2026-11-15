#!/usr/bin/env bash
# Runs scripts/box-firewall.sh with the iptables backend the host's Docker uses
# (decision 0020). The container shares the host's network namespace, so its
# rules are the host's rules. iptables comes in two backends, nft and legacy,
# and the rules must sit next to Docker's own: pick the one whose ruleset
# already has Docker's chains, nft when neither or both do.
# HEARTH_IPTABLES=nft|legacy overrides the detection.
set -euo pipefail

backend="${HEARTH_IPTABLES:-}"
if [[ -z "${backend}" ]]; then
  legacy="$(iptables-legacy-save 2>/dev/null | grep -c '^:DOCKER' || true)"
  nft="$(iptables-nft-save 2>/dev/null | grep -c '^:DOCKER' || true)"
  if [[ "${legacy}" -gt 0 && "${nft}" -eq 0 ]]; then backend=legacy; else backend=nft; fi
fi
case "${backend}" in
  nft | legacy) ;;
  *)
    echo "box-firewall: HEARTH_IPTABLES must be nft or legacy, got \"${backend}\"" >&2
    exit 2
    ;;
esac
# Debian's alternatives switch iptables-save and iptables-restore with iptables.
update-alternatives --set iptables "/usr/sbin/iptables-${backend}" >/dev/null
update-alternatives --set ip6tables "/usr/sbin/ip6tables-${backend}" >/dev/null
echo "box-firewall: iptables backend ${backend}"
exec /usr/local/bin/box-firewall "$@"
