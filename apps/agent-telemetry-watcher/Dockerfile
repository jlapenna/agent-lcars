# Per-host CLI telemetry watcher daemon (issue #2540). Packaged as a Docker
# image to match the target host's (pike) existing Docker Compose +
# homelab-ansible convention — see the issue body for why this supersedes
# the PRD's original "bundled systemd unit" plan.
#
# Build from the repo root: docker build -f apps/agent-telemetry-watcher/Dockerfile -t agent-telemetry-watcher .

FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.34.4 --activate

COPY . .
RUN HUSKY=0 CI=true pnpm install --frozen-lockfile
RUN ./tools/nx build @repo/agent-telemetry-watcher --configuration=production

FROM node:24-slim AS runtime
WORKDIR /app

RUN adduser --disabled-password --gecos "" watcher
COPY --from=build /repo/apps/agent-telemetry-watcher/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
USER watcher

ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/main.js"]
