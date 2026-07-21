# syntax=docker/dockerfile:1
# Per-host CLI telemetry watcher daemon (issue #2540). Packaged as a Docker
# image to match the target host's (pike) existing Docker Compose +
# homelab-ansible convention — see the issue body for why this supersedes
# the PRD's original "bundled systemd unit" plan.
#
# Build from the repo root: docker build -f apps/telemetry-watcher/Dockerfile -t agent-telemetry-watcher .
#
# This is built directly from the live agent-lcars checkout (see homelab's
# agent-telemetry-watcher/docker-compose.yml for why), which changes on
# essentially every commit — so `COPY . .` below is cache-invalidated on
# every single build regardless of whether package.json/pnpm-lock.yaml
# actually changed. Cache mounts on the install/build steps let the
# expensive part (package downloads, Nx's own task cache) survive that
# invalidation instead of redoing it from scratch every time.

FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.34.4 --activate

COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    HUSKY=0 CI=true pnpm install --frozen-lockfile
RUN --mount=type=cache,target=/repo/.nx/cache \
    ./tools/nx build @agent-lcars/telemetry-watcher --configuration=production

FROM node:24-slim AS runtime
WORKDIR /app

RUN adduser --disabled-password --gecos "" watcher
COPY --from=build /repo/apps/telemetry-watcher/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
USER watcher

ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/main.js"]
