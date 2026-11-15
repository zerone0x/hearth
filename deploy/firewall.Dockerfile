# syntax=docker/dockerfile:1
#
# The box egress firewall as a one-shot (decision 0020): scripts/box-firewall.sh
# (decision 0012) with iptables, run by deploy/compose.yaml in the host's
# network namespace with NET_ADMIN. It holds no state; the rules live in the
# host's kernel and the marker in the host's /run/hearth.

FROM debian:trixie-slim

# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables \
  && rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 scripts/box-firewall.sh /usr/local/bin/box-firewall
COPY --chmod=0755 deploy/firewall-entrypoint.sh /usr/local/bin/box-firewall-entrypoint

LABEL org.opencontainers.image.title="hearth-box-firewall" \
      org.opencontainers.image.source="https://github.com/zerone0x/hearth"

ENTRYPOINT ["/usr/local/bin/box-firewall-entrypoint"]
CMD ["apply"]
