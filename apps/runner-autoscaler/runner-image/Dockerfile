# The single source for this image. The canonical `jlapenna/homelab` checkout
# is the only publisher (see docs/image-publish-routing.md); it pulls the
# result.
#
# There is no longer a duplicate copy in jlapenna/homelab. That copy existed
# solely as a local-build fallback for when a registry pull failed on a
# fleet worker host, and both the fallback and the copy were removed
# (jlapenna/homelab#164): rebuilding locally on a failed pull masks the
# outage and silently diverges hosts onto their own unreviewed builds. A
# failed pull is now a hard failure.
#
# Declared before any FROM so it stays usable in the second stage's FROM
# below (a build ARG used in a FROM line must be declared "globally", i.e.
# ahead of the first FROM in the whole file - a stage-scoped declaration
# only reaches instructions inside that same stage).
#
# Defaults to the upstream project's own registry, pinned by DIGEST rather
# than a floating tag, so `docker build` with no build args works from any
# network. This is the base of the image every runner in the fleet executes,
# so an unpinned `:latest` meant its contents could change with no source
# change and no review.
#
# A fleet publish overrides this with `--build-arg RUNNER_BASE=...` to build
# from a pre-pulled private-registry mirror instead (issue #1729) -- that is
# an operational choice of the publisher (avoiding an external registry
# dependency and rate limits during a fleet build), not a property of this
# image. See docs/image-publish-routing.md for the homelab example: the
# mirror-update procedure, the registry login, and why the digest below must
# still match whatever the mirror is pinned to.
#
# The digest is the multi-arch INDEX digest, so both linux/amd64 and
# linux/arm64 resolve from it.
#
# Currently: upstream v2.336.0.
ARG RUNNER_BASE=ghcr.io/actions/actions-runner@sha256:759a1d94a15b05941aba5196974ff43fe15b4cbba29b694b35cbc32a1166b232

# Keep the Go compiler embedded in the JIT image aligned with the module the
# Verify job tests. toolchain-health.test.sh compares this value with
# apps/runner-autoscaler/go.mod so an update cannot silently leave CI using a
# stale compiler. An exact release tag keeps the toolchain reproducible while
# still letting BuildKit cache its immutable image layers.
ARG GO_VERSION=1.27.3
# The canonical publisher can freeze these indexes across semantic build jobs.
# Defaults keep ordinary builds and Renovate version ownership unchanged.
ARG NODE_BUILD_BASE=node:26.13.0-slim
# Node 25+ no longer bundles Corepack (neither the node image nor NodeSource's
# nodejs package), and every pnpm here resolves through it from packageManager.
ARG COREPACK_VERSION=0.36.0
ARG GO_BUILD_BASE=golang:${GO_VERSION}-bookworm

# One pin feeds the source image and both runtime-user build assertions.
ARG TERRAFORM_VERSION=1.17.1

# Builds jlapenna/agent-lcars's telemetry sidecar/finalize tool AND the
# `lcars` session-title/status CLI (apps/telemetry-watcher's `bundle` and
# `session-title-cli` targets, respectively -- agent-lcars#1289 added the
# second) from source, baked into the runner image below rather than
# published to GCS and curl-downloaded by every job (agent-lcars#30) — this
# image is the fleet's own, so there's no ephemeral-runner reason left to
# re-fetch either tool per job the way a stock GitHub-hosted runner would
# need to. Both bundles are built from the exact same checkout, so they can
# never drift to different agent-lcars revisions the way two separately
# published artifacts could. Always builds from agent-lcars's
# `main` (no version pin): a stale pin was exactly the failure mode this
# replaces (agent-lcars#29 — an earlier worker silently pointed at a frozen,
# never-republished GCS bundle for months). If this stage fails, the whole
# image build fails and the fleet keeps running the last successfully
# published image -- deploy_runner_autoscaler.yml pulls and fails loudly if
# it cannot, rather than shipping a broken tool or rebuilding locally.
# --platform=$BUILDPLATFORM pins this stage to the machine doing the
# building instead of letting it be rebuilt once per *target* platform.
# Everything it produces -- sidecar.cjs and lcars-session-title.cjs (both
# JavaScript bundles) and the sidecar-lifecycle.sh shell script -- is
# architecture-independent, so the arm64 rebuild recomputed a
# byte-identical artifact while running the whole `pnpm install` + nx
# dependency chain under QEMU emulation.
#
# That emulated pass was the dominant cost of this image: publish runs were
# landing at 16-24 minutes against a 20-minute job timeout and had started
# failing outright (2026-07-26), leaving the fleet's runner image stale.
# Building it once natively removes the emulated pass entirely.
#
# If this stage ever starts emitting a native binary, this pin becomes
# wrong -- it would bake an amd64 artifact into the arm64 image.
FROM --platform=$BUILDPLATFORM ${NODE_BUILD_BASE} AS node-build
ARG COREPACK_VERSION
RUN npm install --global "corepack@${COREPACK_VERSION}" && corepack enable

FROM node-build AS telemetry-watcher-build
# Build-time only: one bounded worker must cover the daemon and this vertex.
# ARG reaches RUN children without constraining jobs in the shipped image.
ARG NODE_OPTIONS=--max-old-space-size=1024
ARG npm_config_network_concurrency=4
ARG npm_config_child_concurrency=1
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# CACHE_BUST (build-arg, set to the publishing commit's SHA by the CI
# workflow) forces this RUN's cache key to change on every real publish.
# Without it, `docker/build-push-action`'s cache-from/to: type=registry
# (mode=max) can restore a cached layer for this instruction from a PRIOR
# build even though the instruction text (a clone of the moving `main`
# branch) never changes -- silently pinning /repo to whatever agent-lcars
# commit happened to be current the last time this exact layer was built,
# defeating the entire "always build from fresh main, no version pin"
# point of this stage (agent-lcars#29) via the cache mechanism itself. A
# CI-triggered build always sets a real, unique CACHE_BUST; a bare local
# `docker build` with no --build-arg is the one case this still risks a
# stale cache hit, matching the accepted risk on that manual path already.
ARG AGENT_LCARS_REF=main
ARG CACHE_BUST=unset
RUN echo "cache-bust: ${CACHE_BUST}" && \
    git init . && \
    git remote add origin https://github.com/jlapenna/agent-lcars.git && \
    git fetch --depth 1 origin "${AGENT_LCARS_REF}" && \
    git checkout --detach FETCH_HEAD
# pnpm's version comes from the cloned repo's own package.json
# ("packageManager" field) via corepack, not hardcoded here, so this stays
# correct as agent-lcars bumps it.
# pnpm 11 verifies dependency status before `pnpm exec` and reinstalls when it
# judges node_modules stale, so the bundle step below launches a second
# `pnpm install` of its own. That nested install has to be guarded too: it runs
# the `prepare` lifecycle, and tools/setup-git-hooks.sh only stands down when
# CI is set. Declaring both as ENV (rather than inline on the install command,
# where they covered only that one process) is what makes every later layer --
# including the ones pnpm spawns for itself -- inherit the guard.
ENV HUSKY=0 CI=true
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# Build the telemetry sidecar and the three CLI entry points from one checkout.
# session-title-cli is the full operator CLI, including session, Work and
# integration commands. hook-cli imports the shared hook handler directly so
# frequent hook calls avoid initializing those operator command dependencies.
# hook-flush-cli handles asynchronous delivery from beside either CLI bundle.
# Keep these builds in one RUN to avoid unnecessary image layers.
RUN ./tools/nx bundle @agent-lcars/telemetry-watcher && \
    ./tools/nx session-title-cli @agent-lcars/telemetry-watcher && \
    ./tools/nx hook-cli @agent-lcars/telemetry-watcher && \
    ./tools/nx hook-flush-cli @agent-lcars/telemetry-watcher

# Action archives are immutable repository tarballs, never extracted or executed
# during preparation. Download them on the existing builder-platform stage;
# target-specific native dependencies remain in their original stages.
FROM telemetry-watcher-build AS action-archive-cache-build
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY populate-action-archive-cache.sh /usr/local/lib/agent-lcars/populate-action-archive-cache.sh
RUN bash /usr/local/lib/agent-lcars/populate-action-archive-cache.sh /repo /out/actions-archive-cache

# Architecture-specific pnpm content store for the JIT runner, seeded with the
# union of every fleet JavaScript repository's lockfile (agent-lcars#2076).
# pnpm-seed/fleet/ is data refreshed weekly by
# .github/workflows/refresh-runner-pnpm-seed.yml: each directory holds one
# repository's pnpm-lock.yaml (without its patch map), a manifest carrying
# only its packageManager, and its supportedArchitectures. No source, script,
# patch, or build context from another repository enters this image. `pnpm fetch`
# downloads package content only; `--ignore-scripts` keeps lifecycle output
# out of the seed. The final stage copies only /pnpm-store and pnpm's metadata
# cache, so manifests,
# lockfiles, build cache, and any credentials cannot reach a job image.
#
# Corepack resolves each directory's own pnpm version. Every fleet consumer
# uses pnpm 11, whose content-store layout is v11 (layouts are major-version
# specific). Its registry-metadata mirror is not: pnpm 11.28.5 moved it from
# <cacheDir>/v11/metadata to <cacheDir>/v12/metadata (pnpm/pnpm#13512), and
# pnpm >= 11.28.5 never reads v11/metadata again. The release-age policy is each consumer's to enforce on its own
# installs; the seed only pre-fetches lockfiles those repositories already
# accepted, so a package published hours before a refresh must not fail the
# image build. Keep the copy below as a distinct final-image layer to make
# its size and churn visible.
# Fetching runs no lifecycle scripts or target binaries. Keep the Node work
# native and project `current` CPU settings onto TARGETARCH through pnpm's CLI.
# Seed proofs are image-build gates, consumed by the final image below.
# Keep real CLI CPU selection ahead of the production fetch and fixture proof.
FROM node-build AS pnpm-cpu-regression
ARG NODE_OPTIONS=--max-old-space-size=512
WORKDIR /proof
COPY fetch-pnpm-seed.mjs fetch-pnpm-seed.test.mjs ./
COPY pnpm-seed/fleet/jlapenna__agent-lcars/package.json ./pnpm-seed/fleet/jlapenna__agent-lcars/package.json
RUN corepack install --global "$(node -p 'require("./pnpm-seed/fleet/jlapenna__agent-lcars/package.json").packageManager')"
RUN --network=none node --test fetch-pnpm-seed.test.mjs && printf 'passed\n' > /proof/cpu-selection.ok

FROM node-build AS pnpm-store-seed
COPY --from=pnpm-cpu-regression /proof/cpu-selection.ok /proof/cpu-selection.ok
ARG TARGETARCH
# Build-time only: one bounded worker must cover the daemon and this vertex.
# ARG reaches RUN children without constraining jobs in the shipped image.
ARG NODE_OPTIONS=--max-old-space-size=1024
ARG npm_config_network_concurrency=4
ARG npm_config_child_concurrency=1
# A consumer may lock a git-hosted dependency as a `type: git` resolution
# (Sprinkles locks `@jlapenna/fleet-runtime` and `@jlapenna/repo-tools` from
# `git+https://` specifiers); pnpm clones those with the git CLI, which the
# slim base omits. Without it every publication failed with
# ERR_PNPM_GIT_FETCHER_GIT_NOT_FOUND after the #2136 refresh.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /seed
COPY pnpm-seed/fleet/ ./
COPY fetch-pnpm-seed.mjs /usr/local/lib/agent-lcars/fetch-pnpm-seed.mjs
# Each fetch also runs pnpm 11's supply-chain verification, which caches the
# registry metadata of every locked package (~590 MiB for Sprinkles). Jobs run
# the same verification on every install; without this cache in the image each
# job re-downloaded and re-wrote that metadata (#2082). Keep only the metadata:
# lockfile-verified.jsonl records verifications of these seed lockfiles, not a
# job's own, so it is dropped. store/v11/tmp is pnpm's scratch for git
# dependencies (hard-linked clones), not store content, so it is dropped too.
RUN set -eu; \
    for repository in */; do \
      grep -q '^packages:' "$repository/pnpm-lock.yaml" || { \
        echo "fleet seed $repository has an empty lockfile; re-run tools/sync-runner-pnpm-seed.py (#2084 rewrote them)" >&2; \
        exit 1; }; \
      (cd "$repository" && \
        node /usr/local/lib/agent-lcars/fetch-pnpm-seed.mjs "$TARGETARCH"); \
    done; \
    rm -f /pnpm-cache/lockfile-verified.jsonl; \
    rm -rf /pnpm-store/v11/tmp
# The fetches above made Corepack download every fleet-pinned pnpm into
# /root/.cache/node/corepack. Record which ones, so the final image can ship
# that cache to the runner user and prove each pin resolves offline: a job's
# own `pnpm` (Corepack, or the setup actions' baked-toolchain detection) then
# never re-downloads its pinned release from the registry.
RUN node -e 'for (const f of process.argv.slice(1)) console.log(require(`/seed/${f}`).packageManager)' \
      */package.json | sort -u > /fleet-pnpm-pins; \
    test -s /fleet-pnpm-pins
# Each fetch mirrors registry metadata under the directory its own pnpm reads
# back: v12/metadata from pnpm >= 11.28.5, v11/metadata from earlier pnpm 11
# (#2902). Require the mirror of every fleet pin, so a seed that would make a
# job re-download its ~590 MiB of metadata fails here instead of shipping. The
# whole cache is copied below, so v11/metadata ships only while a fleet pin
# below 11.28.5 still writes it.
RUN set -eu; \
    while read -r pin; do \
      version="${pin#pnpm@}"; version="${version%%+*}"; \
      mirror=v11; \
      [ "$(printf '%s\n' 11.28.5 "$version" | sort -V | head -n 1)" = 11.28.5 ] && mirror=v12; \
      test -d "/pnpm-cache/$mirror/metadata" || { \
        echo "fleet pin $pin wrote no registry-metadata mirror at /pnpm-cache/$mirror/metadata" >&2; \
        exit 1; }; \
    done < /fleet-pnpm-pins; \
    test -d /pnpm-cache/v12/metadata

# A small fixture preserves the lower-image-layer TypeScript hit and normal
# is-number writable miss. Depend on the real production fetch as well; none
# of these phases may run in parallel or bypass a rejected fleet lockfile.
FROM node-build AS pnpm-regression-seed
ARG NODE_OPTIONS=--max-old-space-size=512
WORKDIR /seed
COPY --from=pnpm-store-seed /fleet-pnpm-pins /proof/production-pnpm-pins
COPY pnpm-seed-regression/seed/package.json package.json
COPY pnpm-seed-regression/seed/pnpm-lock.yaml pnpm-lock.yaml
RUN pnpm fetch --frozen-lockfile --ignore-scripts --store-dir /pnpm-store

FROM node-build AS pnpm-regression-base
ARG NODE_OPTIONS=--max-old-space-size=512
RUN useradd --create-home --uid 1001 runner
COPY --from=pnpm-regression-seed --chown=runner:runner /pnpm-store/ /home/runner/.local/share/pnpm/store/
COPY --chown=runner:runner pnpm-seed-regression/hit /opt/pnpm-hit
COPY --chown=runner:runner pnpm-seed-regression/miss /opt/pnpm-miss
COPY pnpm-seed-regression/prove-store.sh /usr/local/lib/pnpm-seed-proof.sh
USER runner
RUN install -d -m 0755 /home/runner/.config/pnpm && \
    printf 'storeDir: /home/runner/.local/share/pnpm/store\ncacheDir: /home/runner/.cache/pnpm\npackageImportMethod: hardlink\n' \
      > /home/runner/.config/pnpm/config.yaml
WORKDIR /opt/pnpm-hit
RUN pnpm --version

FROM pnpm-regression-base AS pnpm-store-layer-proof
RUN bash /usr/local/lib/pnpm-seed-proof.sh layer

# A separate child of the pristine base keeps the mount case independent.
# Copy only the prior success marker to serialize the phases. BuildKit tmpfs
# does not accept uid/gid options; set ownership before returning to UID1001.
FROM pnpm-regression-base AS pnpm-store-work-proof
COPY --from=pnpm-store-layer-proof /home/runner/.cache/pnpm-proof/layer.ok /proof/layer.ok
USER root
RUN --mount=type=tmpfs,target=/home/runner/_work,size=268435456 \
    chown 1001:1001 /home/runner/_work && \
    su -s /bin/bash runner -c 'exec bash /usr/local/lib/pnpm-seed-proof.sh work-mount'

FROM scratch AS pnpm-store-proof
COPY --from=pnpm-cpu-regression /proof/cpu-selection.ok /proof/cpu-selection.ok
COPY --from=pnpm-store-seed /fleet-pnpm-pins /proof/production-pnpm-pins
COPY --from=pnpm-store-layer-proof /home/runner/.cache/pnpm-proof/layer.ok /proof/layer.ok
COPY --from=pnpm-store-work-proof /home/runner/.cache/pnpm-proof/work-mount.ok /proof/work-mount.ok
COPY --from=pnpm-regression-base /home/runner/.config/pnpm/config.yaml /proof/config.yaml

# Measurement-only targets: `FROM scratch` ensures their OCI output contains
# only the compressed store payload, not the Node base or fetch-stage virtual
# node_modules. Homelab's canonical image publisher measures these targets on
# its remote BuildKit builder and blocks promotion above the 1.5 GiB budget.
FROM scratch AS pnpm-store-content
COPY --from=pnpm-store-seed /pnpm-store/ /pnpm-store/
COPY --from=pnpm-store-seed /pnpm-cache/ /pnpm-cache/

# CI's Verify job runs Go race tests and validates Actions syntax with
# actionlint. On an ephemeral JIT runner actions/setup-go had to fetch and
# unpack Go for every job, then `go install` compiled actionlint from scratch.
# Build both once per runner-image revision instead. Compile actionlint on
# the builder platform for the final target so publishing arm64 does not pay
# an avoidable QEMU compiler pass.
FROM --platform=$BUILDPLATFORM ${GO_BUILD_BASE} AS ci-tooling-build
# One compiler at a time; bound Go heap growth inside the builder cgroup.
ARG GOMAXPROCS=1
ARG GOFLAGS=-p=1
ARG GOMEMLIMIT=1GiB
ARG GO_VERSION
ARG TARGETOS
ARG TARGETARCH
COPY repo-checks.env install-repo-checks.sh /tmp/repo-checks/
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
    && bash /tmp/repo-checks/install-repo-checks.sh \
    && rm -rf /var/lib/apt/lists/*
COPY actionlint-version /tmp/actionlint-version
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eux; \
    ACTIONLINT_VERSION="$(tr -d '\r\n' < /tmp/actionlint-version)"; \
    test "$GO_VERSION" = "$(go env GOVERSION | sed -nE 's/^go([0-9]+\.[0-9]+\.[0-9]+)$/\1/p')"; \
    printf '%s\n' "$ACTIONLINT_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; \
    GOOS="$TARGETOS" GOARCH="$TARGETARCH" CGO_ENABLED=0 \
      go install "github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}"; \
    mkdir -p /out; \
    if [ -f /go/bin/actionlint ]; then \
      install -m 0755 /go/bin/actionlint /out/actionlint; \
    else \
      install -m 0755 "/go/bin/${TARGETOS}_${TARGETARCH}/actionlint" /out/actionlint; \
    fi

# This stage deliberately follows the target platform. It has no RUN
# instruction, so BuildKit only pulls the matching distribution; the final
# image gets a runnable Go runtime for its own architecture without emulating
# a compiler.
FROM ${GO_BUILD_BASE} AS go-runtime

# Phase-2 JIT runner image for the autoscaler.
#
# Base: the internal mirror of Actions Runner — JIT-native (honors
# ACTIONS_RUNNER_INPUT_JITCONFIG, user `runner`, /home/runner/run.sh), so the
# scaler's container spec needs no change to use it.
#
# Adds, mirroring the existing static-runner image (github-runner/docker/):
#   - Node 24: the base image's system Node is too old for pnpm/action-setup's
#     self-installer (members#2004).
#
# The Docker client supports remote BuildKit and static Compose validation;
# the worker has no local Docker daemon or mounted host socket.
FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv-runtime

# Exact multi-platform Terraform artifact; only its static CLI is copied.
FROM hashicorp/terraform:${TERRAFORM_VERSION}@sha256:a5d5a5a892c98f60fcbfa81eac2a40fc19e7b3fa7719bccae10ff6111d22524a AS terraform-runtime

FROM ${RUNNER_BASE}
# BuildKit must finish every seed proof before constructing a publishable image.
COPY --from=pnpm-store-proof /proof/ /usr/local/share/agent-lcars-tooling/pnpm-store-proof/
# Build-time only: one bounded worker must cover the daemon and this vertex.
# ARG reaches RUN children without constraining jobs in the shipped image.
ARG NODE_OPTIONS=--max-old-space-size=1024
ARG npm_config_network_concurrency=4
ARG npm_config_child_concurrency=1

ARG GO_VERSION
ARG TERRAFORM_VERSION
ARG TARGETARCH
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The JIT worker needs Docker client + Buildx to submit remote BuildKit
# sessions, but no scale set mounts a Docker socket or needs a local engine.
# Keep that client surface and remove the bundled daemon/containerd payload,
# which otherwise carries CVE-2026-33186 through an unused gRPC server.
RUN rm -f \
    /usr/bin/containerd \
    /usr/bin/containerd-shim-runc-v2 \
    /usr/bin/ctr \
    /usr/bin/docker-init \
    /usr/bin/docker-proxy \
    /usr/bin/dockerd

# The whole Go distribution is copied from the exact-version Go image above,
# rather than relying on Ubuntu's older distribution package. Keep its bin
# first on PATH so both CI and actionlint use this compiler consistently.
COPY --from=go-runtime /usr/local/go /usr/local/go
COPY --from=ci-tooling-build /out/ /usr/local/bin/
COPY actionlint-version /usr/local/share/agent-lcars-tooling/actionlint-version
ENV PATH=/usr/local/go/bin:${PATH}

# The root-owned OpenCode binary must not come from OpenCode's mutable
# installer. Fetch the exact GitHub release artifact selected for TARGETARCH
# and verify its reviewed SHA-256 before extraction. The consumer setup action
# remains separately nonprivileged and may use OpenCode's supported installer.
COPY opencode-version /usr/local/share/agent-lcars-tooling/opencode-version
COPY install-opencode-release.sh /usr/local/lib/agent-lcars/install-opencode-release.sh
RUN set -eux; \
    OPENCODE_VERSION="$(tr -d '\r\n' < /usr/local/share/agent-lcars-tooling/opencode-version)"; \
    printf '%s\n' "$OPENCODE_VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; \
    OPENCODE_VERSION="$OPENCODE_VERSION" TARGETARCH="$TARGETARCH" \
      bash /usr/local/lib/agent-lcars/install-opencode-release.sh

# Goose is a supported runtime in the same image and publication lifecycle.
COPY goose-version /usr/local/share/agent-lcars-tooling/goose-version
COPY install-goose-release.sh /usr/local/lib/agent-lcars/install-goose-release.sh
RUN GOOSE_VERSION="$(cat /usr/local/share/agent-lcars-tooling/goose-version)" \
    TARGETARCH="$TARGETARCH" bash /usr/local/lib/agent-lcars/install-goose-release.sh

# Keep Corepack's selected pnpm version tied to this repo's one
# packageManager declaration instead of introducing a Dockerfile pin that can
# drift. The build stage already checked out the exact publishing revision,
# so use its manifest for both the root smoke below and the runner-user cache
# warm-up near the end of the image.
COPY --from=telemetry-watcher-build /repo/package.json \
    /usr/local/share/agent-lcars-corepack/package.json
WORKDIR /usr/local/share/agent-lcars-corepack

# Forward-looking hook (homelab#97): lets a future registration-specific
# build add extra tooling without forking this Dockerfile. Empty by
# default; canonical homelab publication sets a real value today --
# `gcc libc6-dev`, so `go test -race` (cgo) can run for
# apps/runner-autoscaler's own test-race target (agent-lcars#410 --
# self-hosting ci.yml's `verify` job surfaced that the image had no C
# toolchain at all, and this Go app has no separate plain `test` target).
ARG EXTRA_APT_PACKAGES=""
ARG NODE_VERSION=26.13.0
ARG COREPACK_VERSION

# Playwright's browser stack is deliberately NOT baked here (reverted per
# agent-lcars#920): E2E no longer runs on this generic JIT image -- the
# trusted path runs on the dedicated lcars-e2e pool, whose runner image IS
# the pinned Playwright sandbox, and fork PRs run on GitHub-hosted
# ubuntu-latest. The #905 bake cost ~1.1GB of image for a job class this
# image no longer serves.

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION%%.*}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    . /etc/os-release; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    # Pull fixed OS packages from the base's security pocket before installing.
    apt-get upgrade -y --no-install-recommends; \
    # The Firestore emulator requires Java 21+. Baking the JRE makes trusted
    # E2E runners ready without downloading a Temurin distribution per job. \
    # python3-yaml: GitHub-hosted ubuntu-latest ships PyYAML, and consumer
    # workflows (sprinkles deploy.py) assume it; with PEP 668 a job cannot
    # pip-install it at run time without --break-system-packages.
    # nmap: repository-owned Goose audit recipes (jclaw weekly-security-audit)
    # run bounded, unprivileged report-only scans with the standard package
    # instead of host-only tools; it is present in every lane like gh and jq. \
    apt-get install -y --no-install-recommends "nodejs=${NODE_VERSION}-1nodesource1" git-lfs gh jq nmap xz-utils python3-pip python3-yaml openjdk-21-jre-headless $EXTRA_APT_PACKAGES; \
    test "$(node -p 'process.versions.node')" = "$NODE_VERSION"; \
    # Actions execute with their bundled Node, independently of PATH.
    cp /usr/bin/node /home/runner/externals/node24/bin/node; \
    test "$(/home/runner/externals/node24/bin/node -p 'process.versions.node')" = "$NODE_VERSION"; \
    # The runner itself still evaluates hashFiles() with externals/node20, so
    # replace that binary with the patched one instead of deleting it.
    cp /usr/bin/node /home/runner/externals/node20/bin/node; \
    rm -rf /home/runner/externals/node20_alpine; \
    # NodeSource's nodejs package no longer ships Corepack (Node 25+), so
    # install the pinned release, then activate its pnpm/yarn shims -- that
    # needs an explicit `enable`, same as the node-build stage above does.
    # This stage once skipped the `enable` for the image jobs actually run in, so
    # every consuming workflow's bare `pnpm ...` silently depended on each
    # job re-deriving that gap around (sprinkles#4003/#4006 hit it live:
    # "pnpm: command not found" the moment a step tried to call pnpm before
    # the agent's own worktree setup happened to paper over it). Smoke-check
    # it here for the same reason as docker/buildx below: failing the build
    # is recoverable, shipping a runner image that silently can't run pnpm
    # is not.
    npm install --global "corepack@${COREPACK_VERSION}"; \
    corepack enable; \
    pnpm --version; \
    # docker + buildx come from the upstream base, not from apt. They are
    # smoke-checked here because the PUBLISH job runs on this very image and
    # drives `docker buildx inspect --bootstrap`: if a future RUNNER_BASE
    # refresh drops either, the build would still succeed, roll out, and
    # then no subsequent run could publish a corrected image through the
    # normal path. Failing the build is recoverable; shipping that is not.
    docker --version; \
    docker buildx version; \
    git-lfs --version; \
    gh --version; \
    jq --version; \
    xz --version; \
    python3 -m pip --version; \
    test "$(go env GOVERSION)" = "go${GO_VERSION}"; \
    actionlint -version; \
    java --version; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Add entrypoint wrapper
# Repository worktree initializers require Python hook tooling. Keep the
# binaries image-owned and the Python packages isolated from Ubuntu's
# externally managed Python; the runner writes only its own hook caches.
COPY --from=uv-runtime /uv /uvx /usr/local/bin/
COPY --from=terraform-runtime /bin/terraform /usr/local/bin/terraform
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
ENV TF_PLUGIN_CACHE_DIR=/opt/terraform-plugin-cache
COPY --from=telemetry-watcher-build /repo/infra/terraform/.terraform.lock.hcl /tmp/ci-providers/terraform.lock.hcl
COPY --from=telemetry-watcher-build /repo/infra/github-ruleset/.terraform.lock.hcl /tmp/ci-providers/github-ruleset.lock.hcl
COPY cache-terraform-providers.py /usr/local/lib/agent-lcars/cache-terraform-providers.py
# uv's archive extractor fails under the QEMU emulation that builds this
# image's linux/arm64 variant (Homelab has no native arm64 builder,
# docs/buildkit-builder.md): "failed to inspect python/lib/libpython3.14.so:
# Invalid argument (os error 22)" for every CPython release and uv setting
# tried, which is why the 3.14.7 pin (#2522) did not help. On arm64, unpack
# the same python-build-standalone archive with GNU tar into uv's managed
# layout instead; `uv python find --managed-python 3.14` (asserted below)
# resolves it exactly as if uv had installed it. The checksum is the
# release's published SHA256SUMS entry. amd64 builds natively and keeps uv.
# uv installs packages into this interpreter, never pip, so its bundled pip is
# removed: it only ships pip's vendored certifi/urllib3/msgpack CVEs.
ARG UV_PYTHON_ARM64_ARCHIVE=cpython-3.14.7%2B20260929-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz
ARG UV_PYTHON_ARM64_SHA256=9b8bd45d06fc3fcdc56f2713a62535fe1c019816461ae87c170dd56184dd3f4d
RUN test "$(terraform version -json | jq -r .terraform_version)" = "$TERRAFORM_VERSION" && \
    if [ "$TARGETARCH" = arm64 ]; then \
      archive="$(mktemp)" && unpacked="$(mktemp -d)" && \
      curl -fsSL --retry 3 -o "$archive" \
        "https://releases.astral.sh/github/python-build-standalone/releases/download/20260929/$UV_PYTHON_ARM64_ARCHIVE" && \
      echo "$UV_PYTHON_ARM64_SHA256  $archive" | sha256sum -c - && \
      tar -xzf "$archive" -C "$unpacked" && \
      mkdir -p "$UV_PYTHON_INSTALL_DIR/cpython-3.14.7-linux-aarch64-gnu" && \
      cp -a "$unpacked/python/." "$UV_PYTHON_INSTALL_DIR/cpython-3.14.7-linux-aarch64-gnu/" && \
      rm -rf "$archive" "$unpacked" && \
      "$UV_PYTHON_INSTALL_DIR/cpython-3.14.7-linux-aarch64-gnu/bin/python3" --version; \
    else \
      uv python install 3.14.7; \
    fi && \
    managed_python="$(uv python find --managed-python 3.14)" && test -x "$managed_python" && \
    managed_site="$("$managed_python" -c 'import sysconfig; print(sysconfig.get_path("purelib"))')" && \
    test -d "$managed_site" && \
    rm -rf "$managed_site"/pip "$managed_site"/pip-*.dist-info "$(dirname "$managed_python")"/pip* && \
    ! "$managed_python" -c 'import pip' 2>/dev/null && \
    python3 /usr/local/lib/agent-lcars/cache-terraform-providers.py /tmp/ci-providers/*.lock.hcl && \
    chown -R runner:runner /opt/terraform-plugin-cache /opt/uv-python && \
    rm -rf /tmp/ci-providers

COPY repo-checks.env /usr/local/share/agent-lcars-tooling/repo-checks.env
COPY requirements-precommit.txt /usr/local/share/agent-lcars-tooling/requirements-precommit.txt
RUN source /usr/local/share/agent-lcars-tooling/repo-checks.env && \
    uv venv --python /usr/bin/python3 /opt/runner-python-tools && \
    uv pip install --python /opt/runner-python-tools/bin/python --no-cache \
      -r /usr/local/share/agent-lcars-tooling/requirements-precommit.txt "pyflakes==$PYFLAKES_VERSION" && \
    ln -s /opt/runner-python-tools/bin/pre-commit /usr/local/bin/pre-commit && \
    ln -s /opt/runner-python-tools/bin/pyflakes /usr/local/bin/pyflakes
COPY python-hooks.test.sh /usr/local/lib/agent-lcars/python-hooks.test.sh

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Actions runtime health-check functions consumed by entrypoint.sh.
# agent-lcars#1330: pre-populate the runner's action-archive cache so job
# setup survives codeload.github.com outages on the trusted path. The list
# derives from the fresh-main checkout in the telemetry stage (SHA pins
# cached directly; tag refs resolved at build time), so it tracks main with
# no hand-kept pin list. ~90MB. entrypoint.sh exports
# ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE at this path; a cache miss falls back
# to the normal codeload download. Owned by runner: the variable requires a
# writable directory, and job-time downloads then warm it for the container's
# lifetime.
COPY populate-action-archive-cache.sh /usr/local/lib/agent-lcars/populate-action-archive-cache.sh
COPY --from=action-archive-cache-build --chown=runner:runner /out/actions-archive-cache/ /opt/actions-archive-cache/

COPY externals-health.sh /usr/local/lib/agent-lcars/externals-health.sh
RUN chmod +r /usr/local/lib/agent-lcars/externals-health.sh

# Toolchain predicates (#468) plus the build-time gate that runs them once,
# as the job user, at the end of this Dockerfile (#2033). Kept as separate
# files so the predicates can be exercised without building the image.
COPY toolchain-health.sh /usr/local/lib/agent-lcars/toolchain-health.sh
COPY verify-image-invariants.sh /usr/local/lib/agent-lcars/verify-image-invariants.sh
COPY repo-tools-bins.mjs /usr/local/lib/agent-lcars/repo-tools-bins.mjs
COPY repo-tools-bins.test.mjs /usr/local/lib/agent-lcars/repo-tools-bins.test.mjs
RUN chmod +r /usr/local/lib/agent-lcars/toolchain-health.sh \
    /usr/local/lib/agent-lcars/verify-image-invariants.sh

# agent-lcars#30: baked-in telemetry finalize/resume tool (built above).
# Consumed via /usr/local/lib/agent-lcars/sidecar-lifecycle.sh finalize — a
# thin telemetry-specific wrapper (credential/RUN_ID guards, sidecar.cjs
# argument assembly) baked in alongside the binary itself, so QueueExecutor
# invokes the telemetry lifecycle directly instead of duplicating that bash
# inline. That duplication is exactly how members drifted out of sync with
# agent-lcars for an unknown stretch of time (it was missing the finalize
# half entirely) — see apps/telemetry-watcher's own runner-config.ts for the
# underlying CLI's flags, and apps/telemetry-watcher/bin/sidecar-lifecycle.sh
# for the wrapper's own source. direct-runner.sh also calls sidecar.cjs's
# `runner resume` directly. Live mid-run telemetry comes from provider hooks
# (lcars-session-title.cjs + lcars-hook-flush.cjs below); the polling
# `runner sidecar` mode and its job-daemon.sh wrapper are retired
# (docs/hooks-telemetry-design.md, phase 3).
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/dist/apps/telemetry-watcher/sidecar.cjs \
    /usr/local/lib/agent-lcars/sidecar.cjs
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/apps/telemetry-watcher/bin/sidecar-lifecycle.sh \
    /usr/local/lib/agent-lcars/sidecar-lifecycle.sh
RUN chmod +x /usr/local/lib/agent-lcars/sidecar-lifecycle.sh

# QueueExecutor's native runtime helpers are baked beside direct-runner.sh.
# Same fresh-`main`-checkout stage as sidecar.cjs/sidecar-lifecycle.sh above.
# The separate action-archive stage copies only its tarball cache into the
# final image; native helpers still come from this exact source checkout.
#
# The helpers resolve the trusted shared protocol relative to this exact
# native location. direct-runner.test.sh mirrors it, proving the image
# cannot accidentally rely on a source checkout or GitHub Actions layout.
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/apps/runner-autoscaler/runner-image/runtime \
    /usr/local/lib/agent-lcars/runtime
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/agents/shared/skills \
    /usr/local/lib/agent-lcars/agents/shared/skills
RUN chmod +x /usr/local/lib/agent-lcars/runtime/*.sh
COPY direct-runner.sh /usr/local/lib/agent-lcars/direct-runner.sh
RUN chmod +x /usr/local/lib/agent-lcars/direct-runner.sh

# agent-lcars#1289: the `lcars` CLI (`lcars session title "..."`/`lcars
# session status "..."`), built above as a second, independent bundle
# (session-title-cli target). This closes the gap #1289 exists for: the
# `agents/shared/skills/lcars-session-updates` layer-1 skill surface has been
# installed into every dispatched agent's $HOME/.claude/skills since #1269,
# and that skill already teaches `lcars session status "..."` -- but until
# now this image shipped no `lcars` binary at all, so every dispatched
# agent's attempt silently no-op'd (the skill degrades via `command -v
# lcars` on purpose, so nothing broke, but nothing worked either; see
# #1282's live verification of that degrade path).
#
# Installed the same way as sidecar.cjs just above: copied to
# /usr/local/lib/agent-lcars/, owned by runner:runner. The bundle itself
# needs no execute bit -- like sidecar.cjs, it is only ever invoked as
# `node <path>`, never executed directly -- but the launcher below does,
# since that's what a dispatched agent actually types.
#
# The full operator CLI serves interactive commands and integration setup.
# The launcher routes hook calls to the dedicated bundle below, preserving
# the same handler while avoiding the operator CLI's broader startup work.
# Keep the flusher beside both entry points for sibling-path resolution.
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/dist/apps/telemetry-watcher-session-title-cli/lcars-session-title.cjs \
    /usr/local/lib/agent-lcars/lcars-session-title.cjs
# Hook calls avoid initializing the operator CLI; the flusher stays adjacent.
COPY --from=telemetry-watcher-build \
    /repo/dist/apps/telemetry-watcher-hook/lcars-hook.cjs \
    /usr/local/lib/agent-lcars/lcars-hook.cjs
# The hook flusher bundle: `lcars hook` spawns it from beside the CLI bundle
# so hook invocations never load the Firestore client.
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/dist/apps/telemetry-watcher-hook-flush/lcars-hook-flush.cjs \
    /usr/local/lib/agent-lcars/lcars-hook-flush.cjs

# Agent-runtime commands are single-sourced from packages/fleet-tools and
# installed globally from the same fresh-`main` checkout the telemetry stage
# already builds from. General repository-management commands are installed
# separately from the public repo-tools artifact: they are not an agent-tools
# dependency and can evolve on their own cadence.
COPY --from=telemetry-watcher-build /repo/packages/fleet-tools /opt/agent-tools
# npm's global installer resolves a local package and a Git package through
# one shared staging tree. repo-tools carries Nx as a runtime dependency, and
# that combined transaction can race the pnpm-linked tree while npm packs it.
# Keep the two independent tool systems independently installed as well.
RUN npm install -g /opt/agent-tools
# repo-tools has three consumers in this image: its public CLI commands plus
# the Codex and Claude plugin managers. Keep one shallow checkout as their
# shared source of truth. The plugin managers retain their required,
# provider-specific installed snapshots, but neither performs another Git
# fetch; CLI entrypoints link to this checkout's declared package binaries.
# Installing only its dependencies does not create its own node_modules/.bin
# shims. Resolve package.json's bin map, then exercise the installed worktree
# guard as the job user in the final build-time invariant gate.
# REPO_TOOLS_REF (build-arg, set to repo-tools' current main SHA by the
# publishing script) forces this RUN's cache key to change whenever
# repo-tools/main advances -- the same registry cache-from/to: type=registry
# (mode=max) hazard the telemetry-watcher-build stage's AGENT_LCARS_REF /
# CACHE_BUST pair guards against above, applied to this independent clone.
# Without it, a rebuild of an *unchanged* agent-lcars commit could restore a
# cached layer for this instruction from a PRIOR build even though repo-tools
# has since released new content, silently pinning /opt/repo-tools to a stale
# checkout. A publish always sets a real, unique REPO_TOOLS_REF; a bare local
# `docker build` with no --build-arg risks a stale cache hit here too,
# matching the accepted risk on that manual path already.
ARG REPO_TOOLS_REF=main
# Installed from INSIDE /opt/repo-tools, not via `pnpm --dir`: corepack picks
# the pnpm version from the current directory's package.json, so `--dir` from
# this checkout ran Agent LCARS's pnpm against repo-tools' own
# "packageManager" declaration, and pnpm 11 refuses that mismatch outright
# ("configured to use 11.24.0 ... current pnpm is v11.25.0"). It surfaced the
# first time the two repos' pins drifted (#1838 bumped ours), and broke every
# runner-image publish -- and with it merge-to-live's whole cycle -- until
# fixed. Each repo's pnpm now follows its own declaration, which is the
# contract the pnpm-store comment above already states.
RUN node --test /usr/local/lib/agent-lcars/repo-tools-bins.test.mjs && \
    echo "repo-tools ref: ${REPO_TOOLS_REF}" && \
    git init /opt/repo-tools && \
    git -C /opt/repo-tools remote add origin https://github.com/jlapenna/repo-tools.git && \
    git -C /opt/repo-tools fetch --depth 1 origin "${REPO_TOOLS_REF}" && \
    git -C /opt/repo-tools checkout --detach FETCH_HEAD && \
    (cd /opt/repo-tools && pnpm install --prod --frozen-lockfile --ignore-scripts) && \
    node /usr/local/lib/agent-lcars/repo-tools-bins.mjs install /opt/repo-tools /usr/local/bin
# The launcher itself lives on PATH at /usr/local/bin (standard on this
# Debian-derived base for every user, root or `runner` -- no ENV PATH
# change needed), named literally `lcars` rather than
# /usr/local/lib/agent-lcars/lcars -- see lcars.sh's own header for why the
# name is load-bearing and the "lib" scripts above are not: those are only
# ever invoked by their full path from workflow YAML/other scripts, this
# one is meant to be typed.
COPY lcars.sh /usr/local/bin/lcars
RUN chmod +x /usr/local/bin/lcars

# The public repository-tools skill is a Codex plugin. Install the Codex CLI
# before switching to the unprivileged runner user, then install the plugin
# into that user's state below. This deliberately tracks the current CLI: the
# runner is an integrated first-party delivery surface, not a pinned artifact.
ENV FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true
RUN npm install -g @openai/codex && codex --version

# QueueExecutor direct mode invokes `claude` itself instead of the GitHub
# Action that normally provisions that CLI. Keep it in the shared runner image
# and execute its version command while building: a package that no longer
# provides the expected executable must fail publication, not a claimed run.
RUN npm install -g @anthropic-ai/claude-code && claude --version

# The retained Actions Node runtime carries npm independently of NodeSource.
# Repair both node-tar copies after the image's global npm installs so CVE-2026-59873
# cannot survive in a job-visible npm tree.
COPY repair-node-tar.sh /usr/local/lib/agent-lcars/repair-node-tar.sh
RUN bash /usr/local/lib/agent-lcars/repair-node-tar.sh && \
    rm /usr/local/lib/agent-lcars/repair-node-tar.sh

# OpenCode reads this runner user's global configuration before any optional
# project-level config. Keep the fleet-wide provider, safe defaults, and
# standing instructions here rather than copying them into every Actions
# workspace via OPENCODE_CONFIG. A repository can still add its own project
# opencode.json when it has an actual local requirement; OpenCode loads that
# later in its documented precedence order.
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/agents/opencode/opencode.json \
    /home/runner/.config/opencode/opencode.json
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/agents/opencode/instructions.md \
    /home/runner/.config/opencode/instructions.md
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/agents/opencode/lcars-session.js \
    /home/runner/.config/opencode/lcars-session.js
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/agents/opencode/lcars-telemetry.js \
    /home/runner/.config/opencode/lcars-telemetry.js
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/agents/opencode/context-lifecycle.js \
    /home/runner/.config/opencode/context-lifecycle.js
COPY --from=telemetry-watcher-build \
    /repo/apps/runner-autoscaler/runner-image/opencode-litellm-proxy.mjs \
    /usr/local/lib/agent-lcars/opencode-litellm-proxy.mjs
COPY --from=telemetry-watcher-build \
    /repo/apps/runner-autoscaler/runner-image/opencode-litellm-proxy.test.mjs \
    /usr/local/lib/agent-lcars/opencode-litellm-proxy.test.mjs
RUN node --test /usr/local/lib/agent-lcars/opencode-litellm-proxy.test.mjs && \
    rm /usr/local/lib/agent-lcars/opencode-litellm-proxy.test.mjs
COPY prepare-opencode-store.sh check-opencode-store.sh check-opencode-concurrent-readers.sh \
    /usr/local/lib/agent-lcars/
COPY --from=telemetry-watcher-build \
    /repo/apps/runner-autoscaler/runner-image/drain-hook-test-clients.py \
    /repo/apps/runner-autoscaler/runner-image/opencode-continuation.test.sh \
    /repo/apps/runner-autoscaler/runner-image/opencode-continuation.test.py \
    /repo/apps/runner-autoscaler/runner-image/opencode-version \
    /usr/local/lib/agent-lcars/
COPY --from=telemetry-watcher-build \
    /repo/apps/runner-autoscaler/runner-image/drain-hook-test-clients.py \
    /repo/apps/runner-autoscaler/runner-image/drain-hook-test-clients.test.py \
    /repo/apps/runner-autoscaler/runner-image/hook-telemetry.test.sh \
    /repo/apps/runner-autoscaler/runner-image/hook-telemetry-assertions.sh \
    /usr/local/lib/agent-lcars/

USER runner

# Even --version creates /tmp/opencode. Execute the CLI only as the job user
# so image construction does not leave a root-owned, unwritable scratch path.
RUN /usr/local/bin/opencode --version && \
    test "$(id -u)" -ne 0 && \
    probe="$(mktemp /tmp/opencode/runner-write.XXXXXX)" && rm -- "$probe"

# Prove the installed binaries and real hook enforcement as the job user.
RUN uv --version && \
    "$(uv python find --managed-python 3.14)" --version && \
    probe="$(mktemp -d "$UV_PYTHON_INSTALL_DIR/runner-write.XXXXXX")" && rmdir "$probe" && \
    terraform version -json | jq -e --arg expected "$TERRAFORM_VERSION" '.terraform_version == $expected'
RUN bash /usr/local/lib/agent-lcars/python-hooks.test.sh

# OpenCode installs its plugin SDK in each configuration directory on cold
# startup. Bake the version matching the reviewed CLI here; direct-runner's
# existing configuration copy then carries package.json, lock, and modules
# into the attempt configuration without doing an installation during work.
RUN OPENCODE_VERSION="$(tr -d '\r\n' < /usr/local/share/agent-lcars-tooling/opencode-version)" && \
    npm install --prefix /home/runner/.config/opencode --ignore-scripts --save-exact \
      "@opencode-ai/plugin@${OPENCODE_VERSION#v}"

# The store is image-owned, version-bound, and contains no sessions. Keep this
# in its own layer so the next command exercises copy-up from the baked layer.
RUN --network=none bash /usr/local/lib/agent-lcars/prepare-opencode-store.sh
# A cold OpenCode reader, then concurrent readers beside a held connection.
# The script documents why bare concurrent startups are a lock race (#2071).
RUN --network=none bash /usr/local/lib/agent-lcars/check-opencode-concurrent-readers.sh

# The hook fixture runs the real Claude/Codex clients, then one real OpenCode
# run that proves both telemetry and automatic compaction/continuation with the
# global instructions/plugins. Every assertion gates publication; no registry
# connection may hide an unprepared dependency during this proof.
# The arm64 variant is built under QEMU, where the full contract takes ~520s
# against ~20s natively and flakes at its deadline (#3070). The amd64 build and
# CI's hook-telemetry-runtime-smoke run the identical contract, so arm64 only
# proves that its binaries and hook clients execute at all.
RUN --network=none python3 /usr/local/lib/agent-lcars/drain-hook-test-clients.test.py && \
    case "$(uname -m)" in \
      aarch64 | arm64) claude --version && codex --version && opencode --version ;; \
      *) bash /usr/local/lib/agent-lcars/hook-telemetry.test.sh ;; \
    esac

# Register the shared source checkout in each provider's own runner-user
# plugin state. Both providers require their own installed plugin snapshot;
# using the local marketplace avoids fetching repo-tools again.
RUN codex plugin marketplace add /opt/repo-tools && \
    codex plugin add repo-tools@repo-tools
RUN claude plugin marketplace add /opt/repo-tools && \
    claude plugin install repo-tools@repo-tools

# Corepack's downloaded package-manager cache is per-user. The root-side
# `pnpm --version` smoke above proves installation but warms only /root;
# jobs execute as `runner`, so without this build-time invocation their first
# pnpm command still depends on registry.npmjs.org (#467). Running from the
# copied manifest resolves the exact repo-pinned version, and deliberately
# leaves the cache under /home/runner for offline job startup.
#
# The other fleet repositories pin their own pnpm (Sprinkles lags a patch
# release behind, for one), so ship the seed stage's Corepack downloads too:
# each pin recorded in fleet-pnpm-pins then resolves from this cache instead
# of costing every job a registry download. Outside any project Corepack
# would otherwise resolve `pnpm` to the registry's latest release (12.x
# today); making this repo's pin the global default, with
# COREPACK_DEFAULT_TO_LATEST=0, keeps that offline and on the fleet's line.
COPY --from=pnpm-store-seed --chown=runner:runner \
    /root/.cache/node/corepack/v1/pnpm/ /home/runner/.cache/node/corepack/v1/pnpm/
COPY --from=pnpm-store-seed /fleet-pnpm-pins \
    /usr/local/share/agent-lcars-corepack/fleet-pnpm-pins
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack install --global "$(node -p 'require("./package.json").packageManager')"
RUN pnpm --version

# Layer-1 skills (#1269) are image content: install them into the job user's
# own skills directory once, failing the build if the list names a skill the
# image does not carry, instead of copying them on every dispatch (#2033).
RUN bash /usr/local/lib/agent-lcars/runtime/install-skills.sh \
    /usr/local/lib/agent-lcars/agents/shared/skills /home/runner/.claude/skills

# The single gate for every image-owned invariant (#2033). It replaces the
# per-boot entrypoint preflight and the per-dispatch OpenCode probes: an image
# that fails here is never published, so no container ever starts from it.
RUN bash /usr/local/lib/agent-lcars/verify-image-invariants.sh

# Keep each curated seed in a dedicated final-image layer. The runner owns its
# normal pnpm store, so overlayfs shares these immutable lower-layer files on
# a host while a job can add a cache miss only to that runner container's
# private writable layer. No host mount or shared mutable cache is involved.
# The regression test exercises a pnpm 11 lower-layer content hit followed by
# a writable miss, including the no-whole-store-copy property.
#
# Pin the destination's ancestor mtimes first. BuildKit writes every ancestor
# directory into a layer's tar with its current mtime, and the steps above
# rebuild on every Agent LCARS commit (CACHE_BUST), so without this the ~2 GiB
# of unchanged seed got a new digest on every publish and was re-stored in
# full although only ancestor directory headers differed (homelab registry churn,
# 2026-10-15). With the ancestors fixed, an unchanged seed reproduces the
# same blobs. touch only changes times, so /home/runner keeps its mode.
# The copies then land in existing directories and take the source
# directories' times, so their own parents stay pinned too.
RUN mkdir -p /home/runner/.local/share/pnpm/store /home/runner/.cache/pnpm && \
    touch -d @0 /home/runner /home/runner/.local /home/runner/.local/share \
      /home/runner/.local/share/pnpm /home/runner/.cache
COPY --from=pnpm-store-seed --chown=runner:runner \
    /pnpm-store/ /home/runner/.local/share/pnpm/store/
# pnpm's registry-metadata cache from the same fetch, so a job's supply-chain
# verification reads it from this lower layer instead of rewriting it.
COPY --from=pnpm-store-seed --chown=runner:runner \
    /pnpm-cache/ /home/runner/.cache/pnpm/

# Pin pnpm's content-addressable store and metadata cache to the exact paths
# seeded above, in pnpm's own global config file (XDG:
# ~/.config/pnpm/config.yaml), rather than leaving pnpm to pick its default
# per job. pnpm's default store-dir is chosen on the SAME FILESYSTEM as the
# project being installed, for hardlinking -- a property the k3s runner pods
# (homelab#1623) broke: /home/runner/_work is its own mount there (hostPath
# before, emptyDir now), so a job installing from under _work silently
# created and populated a fresh, empty store there instead, re-downloading
# every package on every run and discarding this seed entirely (#2077,
# #2083; measured live as "Content-addressable store is at:
# /home/runner/_work/.pnpm-store/v11" with "reused 0, downloaded 1743").
# Neither `PNPM_STORE_DIR` nor `npm_config_store_dir` changes pnpm 11's
# resolved store-dir (verified empirically -- this file is the mechanism it
# actually honors), and this global config wins over a project's own
# `.npmrc` `store-dir` (also verified empirically), so no fleet repository's
# own config can accidentally un-pin it. With the store on a different
# filesystem than the project, pnpm falls back from hardlinking to copying
# package content (`package-import-method=copy`) -- more I/O per file than a
# hardlink, but the content is still `reused`, never re-downloaded, which is
# the whole point of the seed. the mandatory separate-mount proof above
# proves both the `reused`/`downloaded` accounting and the resolved path.
# `packageImportMethod: hardlink`: pnpm's default (`auto`) tries clone first,
# and on the runners' ext4 a "clone" silently falls back to a full copy, so
# it never hard-links even with _work beside the store. Measured on homelab
# k3s: 2,512 MiB written per Sprinkles install with `auto`, 529 MiB with
# `hardlink` (homelab#849). Across filesystems `hardlink` still copies.
RUN install -d -m 0755 /home/runner/.config/pnpm
# Ship the exact configuration exercised by both pristine proof branches.
COPY --from=pnpm-store-proof --chown=runner:runner /proof/config.yaml /home/runner/.config/pnpm/config.yaml

WORKDIR /home/runner

ENTRYPOINT ["/entrypoint.sh"]
