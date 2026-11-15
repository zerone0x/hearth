# syntax=docker/dockerfile:1
#
# Hearth box image (PRD §6.2, §8.4): one container per session, running pi, Chromium
# and a VNC desktop. Build from the repo root:
#
#   docker build -f apps/box-agent/Dockerfile \
#     --build-arg PI_VERSION="$(jq -r '.dependencies["@earendil-works/pi-coding-agent"]' apps/box-agent/package.json)" \
#     -t hearth-box .
#
# scripts/box-smoke.sh does exactly that and then checks the result.
#
# Layer order matters (PRD §6.3): OS packages, then the desktop (Xvnc, Openbox,
# Chromium), then the runtime, then pi, then box-agent. Updating box-agent or pi only
# rebuilds the top layers, never the desktop layers.

ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION}-slim AS bun

FROM debian:trixie-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# 1. Base OS packages and the non-root user.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
    procps \
    ripgrep \
    python3 \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 --shell /bin/bash hearth \
  && install -d -o hearth -g hearth /workspace

# 2. Desktop: TigerVNC (Xvnc), Openbox and Chromium.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-dejavu-core \
    fonts-liberation \
    openbox \
    tigervnc-standalone-server \
    x11-utils \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -m 1777 /tmp/.X11-unix

# 3. Runtime: Bun runs box-agent and the pi CLI. pi needs Node >= 22.19, newer than
# Debian's nodejs, so pi runs on Bun instead (decision 0004).
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# 4. pi and the other dependencies, installed from the workspace manifests and the
# lockfile only, so a box-agent source change does not reinstall them.
WORKDIR /opt/hearth
COPY package.json bun.lock bunfig.toml ./
COPY apps/box-agent/package.json apps/box-agent/
COPY apps/hub/package.json apps/hub/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/

ARG PI_VERSION
ENV PI_CLI=/opt/hearth/apps/box-agent/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
RUN test -n "${PI_VERSION}" || { echo "PI_VERSION build arg is required" >&2; exit 1; } \
  && bun install --frozen-lockfile --production --ignore-scripts \
  && rm -rf /root/.bun/install/cache \
  && printf '#!/bin/sh\nexec bun "%s" "$@"\n' "${PI_CLI}" > /usr/local/bin/pi \
  && chmod 0755 /usr/local/bin/pi \
  && installed="$(HOME=/tmp pi --version)" \
  && rm -rf /tmp/.pi \
  && if [ "${installed}" != "${PI_VERSION}" ]; then \
       echo "pi ${installed} installed, but PI_VERSION is ${PI_VERSION}" >&2; exit 1; \
     fi

# The label is checked against the installed pi above, so it cannot drift.
LABEL org.opencontainers.image.title="hearth-box" \
      org.opencontainers.image.source="https://github.com/zerone0x/hearth" \
      dev.hearth.pi.version="${PI_VERSION}"

# 5. box-agent last.
COPY packages/core/src packages/core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/box-agent/src apps/box-agent/src
COPY --chmod=0755 apps/box-agent/image/entrypoint.sh /usr/local/bin/hearth-box-entrypoint

ENV HEARTH_DISPLAY=:1 \
    HEARTH_VNC_PORT=5901 \
    HEARTH_SCREEN=1280x800

# No EXPOSE: the box opens one outbound connection to the hub and accepts none (PRD §8).
# Numeric so runtimes can tell it is not root without reading /etc/passwd (user hearth).
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hearth-box-entrypoint"]
