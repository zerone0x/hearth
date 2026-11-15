#!/usr/bin/env bash
# Runs a command after every firewalld reload (decision 0023).
#
# `firewall-cmd --reload` reloads firewalld over D-Bus, not through systemd,
# so a unit's `ReloadPropagatedFrom=firewalld.service` never sees it; with
# firewalld's iptables backend the reload flushes the box firewall's rules
# while the marker stays. firewalld announces every finished reload with the
# D-Bus signal org.fedoraproject.FirewallD1.Reloaded; this script waits for it
# and runs the command each time, e.g.
#
#   scripts/firewalld-reload-watch.sh systemctl reload hearth-box-firewall.service
#
# A failed command is logged and the watch goes on. When the monitor ends (the
# system bus went away) the script exits 1, so systemd's Restart= brings it
# back. HEARTH_DBUS_MONITOR replaces the monitor command (tests).
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

monitor=(dbus-monitor --system
  "type='signal',interface='org.fedoraproject.FirewallD1',member='Reloaded'")
if [[ -n "${HEARTH_DBUS_MONITOR:-}" ]]; then
  monitor=("${HEARTH_DBUS_MONITOR}")
fi

# dbus-monitor prints one header line per message, e.g.
#   signal time=... sender=:1.5 -> destination=(null destination) serial=9
#   path=/org/fedoraproject/FirewallD1; interface=org.fedoraproject.FirewallD1;
#   member=Reloaded
# (one line), plus a NameAcquired signal of its own at start.
while IFS= read -r line; do
  case "${line}" in
    signal\ *"interface=org.fedoraproject.FirewallD1; member=Reloaded"*)
      echo "firewalld reloaded: running $*"
      "$@" || echo "firewalld-reload-watch: '$*' failed with exit $?" >&2
      ;;
    *) ;;
  esac
done < <("${monitor[@]}")

echo "firewalld-reload-watch: the D-Bus monitor ended" >&2
exit 1
