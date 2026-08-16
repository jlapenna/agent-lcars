# syntax=docker/dockerfile:1
# Per-host CLI telemetry watcher daemon (issue #2540). Packaged as a Docker
# image to match the target host's (pike) existing Docker Compose +
# homelab-ansible convention — see the issue body for why this supersedes
# the PRD's original "bundled systemd unit" plan.
#
# Build from the repo root: docker build -f apps/telemetry-watcher/Dockerfile -t agent-lcars-telemetry-watcher .
#
# This is built directly from the live agent-lcars checkout (see homelab's
# agent-lcars-telemetry-watcher/docker-compose.yml for why), which changes on
# essentially every commit — so `COPY . .` below is cache-invalidated on
# every single build regardless of whether package.json/pnpm-lock.yaml
# actually changed. Cache mounts on the install/build steps let the
# expensive part (package downloads, Nx's own task cache) survive that
# invalidation instead of redoing it from scratch every time.

FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable

# pnpm 11 verifies dependency status before `pnpm exec` and reinstalls when it
# judges node_modules stale, so the bundle step below launches a second
# `pnpm install` of its own. That nested install has to be guarded too: it runs
# the `prepare` lifecycle, and tools/setup-git-hooks.sh only stands down when
# CI is set. Declaring both as ENV (rather than inline on the install command,
# where they covered only that one process) is what makes every later layer --
# including the ones pnpm spawns for itself -- inherit the guard.
ENV HUSKY=0 CI=true

COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN --mount=type=cache,target=/repo/.nx/cache \
    ./tools/nx bundle @agent-lcars/telemetry-watcher

FROM node:24-slim AS runtime
WORKDIR /app

RUN adduser --disabled-password --gecos "" watcher
COPY --from=build /repo/dist/apps/telemetry-watcher/sidecar.cjs ./sidecar.cjs
USER watcher

ENV NODE_ENV=production
ENTRYPOINT ["node", "sidecar.cjs"]
