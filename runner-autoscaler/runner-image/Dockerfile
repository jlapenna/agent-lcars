# Intentionally also duplicated at jlapenna/homelab's
# github-runner-autoscaler/runner-image/Dockerfile. This copy here is the
# primary, CI-published one (publish-runner-autoscaler.yml); homelab keeps
# its own copy only as a fallback-build source for when a registry pull
# fails on a fleet worker host, so that fallback doesn't also need those
# hosts to reach GitHub. Keep both copies in sync by hand until/unless that
# changes.
#
# Declared before any FROM so it stays usable in the second stage's FROM
# below (a build ARG used in a FROM line must be declared "globally", i.e.
# ahead of the first FROM in the whole file - a stage-scoped declaration
# only reaches instructions inside that same stage).
ARG RUNNER_BASE=ghcr.io/actions/actions-runner:latest

# Builds jlapenna/agent-lcars's telemetry sidecar/finalize tool
# (apps/telemetry-watcher's `bundle` target) from source, baked into the
# runner image below rather than published to GCS and curl-downloaded by
# every job (agent-lcars#30) — this image is the fleet's own, so there's no
# ephemeral-runner reason left to re-fetch the tool per job the way a stock
# GitHub-hosted runner would need to. Always builds from agent-lcars's
# `main` (no version pin): a stale pin was exactly the failure mode this
# replaces (agent-lcars#29 — claude.yml silently pointed at a frozen,
# never-republished GCS bundle for months). If this stage fails, the whole
# image build fails and the fleet keeps running the last successfully
# published image (see deploy_runner_autoscaler.yml's pull-first,
# build-as-fallback logic) rather than shipping a broken tool.
FROM node:24-slim AS telemetry-watcher-build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ARG AGENT_LCARS_REF=main
RUN git clone --depth 1 --single-branch --branch "${AGENT_LCARS_REF}" \
    https://github.com/jlapenna/agent-lcars.git .
# pnpm's version comes from the cloned repo's own package.json
# ("packageManager" field) via corepack, not hardcoded here, so this stays
# correct as agent-lcars bumps it.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    HUSKY=0 CI=true pnpm install --frozen-lockfile
RUN ./tools/nx bundle @agent-lcars/telemetry-watcher

# Phase-2 JIT runner image for the autoscaler.
#
# Base: ghcr.io/actions/actions-runner — JIT-native (honors
# ACTIONS_RUNNER_INPUT_JITCONFIG, user `runner`, /home/runner/run.sh), so the
# scaler's container spec needs no change to use it.
#
# Adds, mirroring the existing static-runner image (github-runner/docker/):
#   - Node 24: the base image's system Node is too old for pnpm/action-setup's
#     self-installer (members#2004).
#   - docker CLI: the members `e2e-docker` job shells out to docker; in the
#     autoscaler this talks to a host socket mounted into the runner (a
#     scaler.go change, tracked as phase-2 work — the CLI belongs in the image
#     regardless).
FROM ${RUNNER_BASE}

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Forward-looking hook (homelab#97): lets a future registration-specific
# build add extra tooling (e.g. a language toolchain only agent-lcars jobs
# need) without forking this Dockerfile. Empty by default -- neither members
# nor agent-lcars needs anything here today.
ARG EXTRA_APT_PACKAGES=""

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    . /etc/os-release; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs docker-ce-cli git-lfs gh python3-pip $EXTRA_APT_PACKAGES; \
    node --version; \
    docker --version; \
    git-lfs --version; \
    gh --version; \
    python3 -m pip --version; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Backup the original externals directory populated by the base image
RUN cp -r /home/runner/externals /home/runner/externals_backup

# Add entrypoint wrapper
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# agent-lcars#30: baked-in telemetry sidecar/finalize tool (built above).
# Consumed as `node /usr/local/lib/agent-lcars/sidecar.cjs runner
# <sidecar|finalize> ...` by claude.yml's telemetry steps — see that
# repo's runner-config.ts for the CLI's own flags. Renamed from
# ride-along to sidecar (agent-lcars#49); claude.yml keeps a temporary
# legacy fallback to the old filename for any runner still running an
# image built before this rename.
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/dist/apps/telemetry-watcher/sidecar.cjs \
    /usr/local/lib/agent-lcars/sidecar.cjs

USER runner

ENTRYPOINT ["/entrypoint.sh"]
