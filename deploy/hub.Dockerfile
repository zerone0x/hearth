# syntax=docker/dockerfile:1
#
# Hearth hub image (decision 0020): the hub (Bun + Hono) and the built web UI.
# Built by deploy/compose.yaml from the repo root:
#
#   docker build -f deploy/hub.Dockerfile -t hearth-hub .

ARG BUN_VERSION=1.4.4

# 1. The web UI, built once; only apps/web/dist reaches the final image.
FROM oven/bun:${BUN_VERSION} AS web
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/hub/package.json apps/hub/
COPY apps/box-agent/package.json apps/box-agent/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/core/src packages/core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/web apps/web
RUN bun run --filter @hearth/web build

# 2. The hub: production dependencies, sources, and the UI from stage 1.
FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /opt/hearth
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/hub/package.json apps/hub/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
RUN bun install --frozen-lockfile --production --ignore-scripts \
  && rm -rf /root/.bun/install/cache
COPY packages/core/src packages/core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/hub/src apps/hub/src
COPY --from=web /src/apps/web/dist apps/web/dist

LABEL org.opencontainers.image.title="hearth-hub" \
      org.opencontainers.image.source="https://github.com/zerone0x/hearth"

# Defaults for the container; compose and .env override them. The public
# listener stays on loopback (PRD §10); compose runs the hub in the host's
# network namespace, so that is the host's loopback (decision 0020).
# The hub's version on trajectories and spans (decision 0021): pass a git
# commit or release tag as a build argument to tell builds apart; empty means
# apps/hub/package.json's version.
ARG HEARTH_VERSION=""
ENV HEARTH_VERSION=${HEARTH_VERSION}
ENV HEARTH_DATA_DIR=/data \
    HEARTH_WEB_DIR=/opt/hearth/apps/web/dist \
    HEARTH_HOST=127.0.0.1 \
    HEARTH_PORT=8787 \
    HEARTH_BOX_PORT=8788
RUN mkdir -p /data

# No USER: the hub runs as the image's default, root. It holds the Docker
# socket, which is root on the host anyway (decision 0020).
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.HEARTH_PORT}/healthz`); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "apps/hub/src/main.ts"]
