# The single source for this image. It is built and published only by
# publish-runner-autoscaler.yml; jlapenna/homelab pulls the result.
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
# Mirrored into our own registry and pinned by DIGEST, not a floating tag.
#
# This is the base of the image every runner in the fleet executes, so an
# unpinned `:latest` meant its contents could change with no source change
# and no review -- and it made every build depend on an external registry
# being up and not rate-limiting us.
#
# The digest is the multi-arch INDEX digest, so both linux/amd64 and
# linux/arm64 resolve from it. Mirror is a manifest copy, so these are the
# same bytes upstream published.
#
# This writes to the registry, so it needs the publisher credential first:
# the registry enforces Bearer auth on writes again as of homelab#220
# (agent-lcars#112). Anonymous pulls still work, so the `imagetools create`
# below fails at the push with a 401, not at the read -- which reads like a
# broken upstream digest if you do not know to log in.
#
# In the socketless publishing lane the credential arrives as a read-only
# mount and there is no TTY, so use the stdin form -- an interactive prompt
# just hangs there:
#
#   docker login docker-registry.lan.jlapenna.net \
#     --username publisher --password-stdin < /secrets/registry-password
#
# From a workstation without that mount, drop `--password-stdin` and let it
# prompt.
#
#   docker buildx imagetools create \
#     --tag docker-registry.lan.jlapenna.net/mirror/actions-runner:vX.Y.Z \
#     --tag docker-registry.lan.jlapenna.net/mirror/actions-runner:latest \
#     <verified-upstream-actions-runner-index-digest>
#
# To update: re-run that against the new upstream digest, then bump the
# digest below. Deliberately two steps -- mirroring does not silently
# change what gets built.
#
# Currently: upstream v2.336.0, mirrored 2026-07-26.
ARG RUNNER_BASE=docker-registry.lan.jlapenna.net/mirror/actions-runner@sha256:0cfdcc701ce933c6d243c6b0b2da767366dc9f2e99961d4c3754b0b78084cdda

# Keep the Go compiler embedded in the JIT image aligned with the module the
# Verify job tests. toolchain-health.test.sh compares this value with
# apps/runner-autoscaler/go.mod so an update cannot silently leave CI using a
# stale compiler. An exact release tag keeps the toolchain reproducible while
# still letting BuildKit cache its immutable image layers.
ARG GO_VERSION=1.26.3

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
# published image -- deploy_runner_autoscaler.yml pulls and fails loudly if
# it cannot, rather than shipping a broken tool or rebuilding locally.
# --platform=$BUILDPLATFORM pins this stage to the machine doing the
# building instead of letting it be rebuilt once per *target* platform.
# Everything it produces -- sidecar.cjs (a JavaScript bundle) and
# sidecar-lifecycle.sh (a shell script) -- is architecture-independent, so
# the arm64 rebuild recomputed a byte-identical artifact while running the
# whole `pnpm install` + nx dependency chain under QEMU emulation.
#
# That emulated pass was the dominant cost of this image: publish runs were
# landing at 16-24 minutes against a 20-minute job timeout and had started
# failing outright (2026-07-26), leaving the fleet's runner image stale.
# Building it once natively removes the emulated pass entirely.
#
# If this stage ever starts emitting a native binary, this pin becomes
# wrong -- it would bake an amd64 artifact into the arm64 image.
FROM --platform=$BUILDPLATFORM node:24-slim AS telemetry-watcher-build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
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
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    HUSKY=0 CI=true pnpm install --frozen-lockfile
RUN ./tools/nx bundle @agent-lcars/telemetry-watcher

# CI's Verify job runs Go race tests and validates Actions syntax with
# actionlint. On an ephemeral JIT runner actions/setup-go had to fetch and
# unpack Go for every job, then `go install` compiled actionlint from scratch.
# Build both once per runner-image revision instead. Compile actionlint on
# the builder platform for the final target so publishing arm64 does not pay
# an avoidable QEMU compiler pass.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm AS ci-tooling-build
ARG GO_VERSION
ARG TARGETOS
ARG TARGETARCH
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
FROM golang:${GO_VERSION}-bookworm AS go-runtime

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
# NO docker CLI. It was here for the members `e2e-docker` job, which shelled
# out to a host socket bind-mounted into the runner. No scale set mounts
# docker.sock any more (agent-lcars#101, jlapenna/homelab#168 — the e2e lane
# now runs on a runner image that IS the sandbox, so it never needs to
# create a container), which leaves the client with nothing to talk to.
#
# Removing it is the point rather than tidiness: this image backs the
# claude-agent pool, so shipping a Docker client here puts one in front of
# arbitrary agent-authored code. A tool that cannot reach a daemon today is
# still a tool that starts working the moment someone re-adds a socket
# somewhere.
FROM ${RUNNER_BASE}

ARG GO_VERSION
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The whole Go distribution is copied from the exact-version Go image above,
# rather than relying on Ubuntu's older distribution package. Keep its bin
# first on PATH so both CI and actionlint use this compiler consistently.
COPY --from=go-runtime /usr/local/go /usr/local/go
COPY --from=ci-tooling-build /out/actionlint /usr/local/bin/actionlint
COPY actionlint-version /usr/local/share/agent-lcars-tooling/actionlint-version
ENV PATH=/usr/local/go/bin:${PATH}

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
# default; publish-images.yml is what actually sets a real value today --
# `gcc libc6-dev`, so `go test -race` (cgo) can run for
# apps/runner-autoscaler's own test-race target (agent-lcars#410 --
# self-hosting ci.yml's `verify` job surfaced that the image had no C
# toolchain at all, and this Go app has no separate plain `test` target).
ARG EXTRA_APT_PACKAGES=""

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
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    . /etc/os-release; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    # The Firestore emulator requires Java 21+. Baking the JRE makes trusted
    # E2E runners ready without downloading a Temurin distribution per job. \
    apt-get install -y --no-install-recommends nodejs git-lfs gh python3-pip openjdk-21-jre-headless $EXTRA_APT_PACKAGES; \
    node --version; \
    # NodeSource's nodejs package bundles the `corepack` binary but never
    # activates its pnpm/yarn shims -- that needs an explicit `enable`, same
    # as the throwaway telemetry-watcher-build stage above already does for
    # itself. This stage never did it for the image jobs actually run in, so
    # every consuming workflow's bare `pnpm ...` silently depended on each
    # job re-deriving that gap around (sprinkles#4003/#4006 hit it live:
    # "pnpm: command not found" the moment a step tried to call pnpm before
    # the agent's own worktree setup happened to paper over it). Smoke-check
    # it here for the same reason as docker/buildx below: failing the build
    # is recoverable, shipping a runner image that silently can't run pnpm
    # is not.
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
    python3 -m pip --version; \
    test "$(go env GOVERSION)" = "go${GO_VERSION}"; \
    actionlint -version; \
    java --version; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Backup the original externals directory populated by the base image
RUN cp -r /home/runner/externals /home/runner/externals_backup

# Add entrypoint wrapper
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Externals self-heal/health-check functions, shared between entrypoint.sh
# (above) and the control plane's periodic idle-host maintenance sweep
# (scaler.go:sweepHostWorkDir, agent-lcars#392) -- see that file's own
# comment for why both call sites must share one copy of this logic.
COPY externals-health.sh /usr/local/lib/agent-lcars/externals-health.sh
RUN chmod +r /usr/local/lib/agent-lcars/externals-health.sh

# Cheap runtime toolchain probes consumed by entrypoint.sh before the runner
# registers with GitHub. Kept separate from the entrypoint so the predicates
# can be exercised without starting a real JIT runner (#468).
COPY toolchain-health.sh /usr/local/lib/agent-lcars/toolchain-health.sh
RUN chmod +r /usr/local/lib/agent-lcars/toolchain-health.sh

# agent-lcars#30: baked-in telemetry sidecar/finalize tool (built above).
# Consumed via /usr/local/lib/agent-lcars/sidecar-lifecycle.sh
# start|finalize — a thin process-management wrapper (background+PID-file
# for start, kill+bounded-wait+synchronous run for finalize) baked in
# alongside the binary itself, so every consuming claude.yml's telemetry
# step is one line instead of duplicating that ~30-60 lines of bash
# inline. That duplication is exactly how members drifted out of sync
# with agent-lcars for an unknown stretch of time (it was missing the
# finalize half entirely) — see apps/telemetry-watcher's own
# runner-config.ts for the underlying CLI's flags, and
# apps/telemetry-watcher/bin/sidecar-lifecycle.sh for the wrapper's own
# source. No legacy ride-along.cjs fallback here (retired — the
# agent-lcars#49 rename is old enough that every live image has been
# rebuilt with the new name since).
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/dist/apps/telemetry-watcher/sidecar.cjs \
    /usr/local/lib/agent-lcars/sidecar.cjs
COPY --from=telemetry-watcher-build --chown=runner:runner \
    /repo/apps/telemetry-watcher/bin/sidecar-lifecycle.sh \
    /usr/local/lib/agent-lcars/sidecar-lifecycle.sh
RUN chmod +x /usr/local/lib/agent-lcars/sidecar-lifecycle.sh

USER runner

# Corepack's downloaded package-manager cache is per-user. The root-side
# `pnpm --version` smoke above proves installation but warms only /root;
# jobs execute as `runner`, so without this build-time invocation their first
# pnpm command still depends on registry.npmjs.org (#467). Running from the
# copied manifest resolves the exact repo-pinned version, and deliberately
# leaves the cache under /home/runner for offline job startup.
RUN pnpm --version

WORKDIR /home/runner

ENTRYPOINT ["/entrypoint.sh"]
