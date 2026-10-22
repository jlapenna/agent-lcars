# JIT runner image for the lcars-e2e pool (#920): the sandbox IS the runner.
#
# The autoscaler already spawns a fresh ephemeral runner container per job,
# so ci.yml's `e2e` job running tools/e2e-docker.sh's Docker-in-a-container
# wrapper would be a second containerization INSIDE a container that already
# existed -- and the only reason that job ever needed a host Docker socket
# was to create that redundant inner layer. Collapsing the two removes the
# socket requirement outright (homelab#168's hardening stays intact -- this
# pool never re-adds a docker.sock).
#
# Ported from supersprinklesracing/sprinkles' tools/e2e-runner/Dockerfile,
# the precedent this issue's plan names directly: same "derive from the
# published sandbox, copy only the JIT agent payload" shape, adapted to this
# repo's own (simpler) sandbox and runner-base images.
#
# SANDBOX_IMAGE, not a second `FROM mcr.microsoft.com/playwright:...`:
# tools/e2e/Dockerfile stays the single definition of the test environment,
# and this image is only that image plus the runner agent. Two Dockerfiles
# naming the same Playwright tag would be two things to keep in lockstep,
# and the failure mode is silent -- tools/e2e-docker.sh's local runs and this
# pool's CI runs would quietly diverge in fonts/browser build the moment one
# was bumped and not the other. Deriving from it means there is nothing to
# keep in sync.
#
# Multi-arch: CI and QueueExecutor workloads span spark (arm64) alongside the
# amd64 hosts, and lcars-e2e is sized/placed the same way (see the homelab
# orchestrator.yml comment on that scale set) -- so both this and the sandbox
# base publish linux/amd64 and linux/arm64.
#
# Build (context is the REPO ROOT, not tools/e2e-runner -- see the
# externals-health.sh COPY below, which reaches outside this directory):
#   TAG="df-$(sha256sum tools/e2e/Dockerfile | cut -c1-12)"
#   docker buildx build \
#     --build-arg SANDBOX_IMAGE=<registry>/agent-lcars/e2e:$TAG \
#     -f tools/e2e-runner/Dockerfile .

# Digest-pinned, matching apps/runner-autoscaler/runner-image's own
# RUNNER_BASE in this repo -- defaults to the upstream registry; a fleet
# publish overrides it with the private-registry mirror (issue #1729, see
# docs/image-publish-routing.md). Only the agent payload is copied out of it
# -- none of its OS layers -- so the runtime environment stays exactly the
# sandbox's.
ARG RUNNER_BASE=ghcr.io/actions/actions-runner@sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690
ARG SANDBOX_IMAGE

FROM ${RUNNER_BASE} AS agent

# pnpm content store for this repository's own lockfile (#2082). Without it
# every E2E job started from an empty store, downloaded all ~1,730 packages
# and wrote about 1.5-1.9 GiB, the largest single write in the job. The seed
# is the weekly-refreshed lockfile snapshot the JIT runner image already
# fetches (apps/runner-autoscaler/runner-image, #2076/#2077), so this image
# adds no new lockfile input. `pnpm fetch` downloads package content only and
# `--ignore-scripts` keeps lifecycle output out of the seed; the final stage
# copies only the store and pnpm's registry-metadata cache, which pnpm 11's
# supply-chain check otherwise rewrites on every install. The sandbox base
# already carries Node, Corepack and git (for `type: git` resolutions).
FROM ${SANDBOX_IMAGE} AS pnpm-store-seed
USER root
WORKDIR /seed
COPY apps/runner-autoscaler/runner-image/pnpm-seed/fleet/jlapenna__agent-lcars/ ./
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm fetch --frozen-lockfile --ignore-scripts \
      --config.minimum-release-age=0 --store-dir /pnpm-store \
      --config.cache-dir=/pnpm-cache \
    && rm -f /pnpm-cache/lockfile-verified.jsonl \
    && ls -d /pnpm-cache/v*/metadata

FROM ${SANDBOX_IMAGE}
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
USER root

# uid 1002, NOT the 1001 both base images already use for their own default
# user (RUNNER_BASE's `runner` and the Playwright base's `pwuser` collide on
# that uid) -- confirmed against both images directly, not assumed. Nothing
# depends on the agent's original uid -- a JIT config carries none -- but
# /home/runner must be owned by whoever executes run.sh, hence --chown on
# the COPY below.
#
# 1002 also matches Sprinkles' independently built E2E image, but runner
# filesystems are isolated per container; no host checkout ownership contract
# couples the two images anymore.
RUN groupadd -g 1002 runner \
  && useradd -m -u 1002 -g 1002 -s /bin/bash runner

# Agent payload only: bin/, externals/, run.sh, config.sh, env.sh. The
# upstream base is JIT-native (honors ACTIONS_RUNNER_INPUT_JITCONFIG), so
# the scaler's container spec needs no change to drive this image.
COPY --from=agent --chown=runner:runner /home/runner /home/runner

# The seeded pnpm store and metadata cache, pinned in pnpm's global config the
# same way as the JIT runner image (see its Dockerfile for why neither
# PNPM_STORE_DIR nor a project .npmrc is honored). pnpm hard-links from this
# lower layer only when the checkout is on the same filesystem, so the
# agent-lcars-e2e lane keeps /home/runner/_work in the container's writable
# layer rather than a separate emptyDir (homelab deploy_k3s.yml); with
# overlayfs metacopy those links copy up metadata only. On a separate mount
# pnpm still reuses the seed but copies package files.
#
# These layers sit before every step that changes with package.json, and the
# destination's ancestors get fixed mtimes, because BuildKit writes ancestor
# directory headers into each COPY layer: otherwise an unchanged ~1.6 GiB seed
# gets a new digest and is stored again on every publish (the JIT image's
# 2026-10-15 registry churn).
RUN install -d -o runner -g runner /home/runner/.local/share/pnpm/store \
      /home/runner/.cache/pnpm /home/runner/.config/pnpm \
    && chown runner:runner /home/runner/.local /home/runner/.local/share \
      /home/runner/.cache /home/runner/.config \
    && printf 'storeDir: /home/runner/.local/share/pnpm/store\ncacheDir: /home/runner/.cache/pnpm\npackageImportMethod: hardlink\n' \
      > /home/runner/.config/pnpm/config.yaml \
    && chown runner:runner /home/runner/.config/pnpm/config.yaml \
    && touch -d @0 /home/runner /home/runner/.local /home/runner/.local/share \
      /home/runner/.local/share/pnpm /home/runner/.cache /home/runner/.config \
      /home/runner/.config/pnpm /home/runner/.config/pnpm/config.yaml
COPY --from=pnpm-store-seed --chown=runner:runner \
    /pnpm-store/ /home/runner/.local/share/pnpm/store/
COPY --from=pnpm-store-seed --chown=runner:runner \
    /pnpm-cache/ /home/runner/.cache/pnpm/

# The sandbox supplies system npm and the runner payload supplies two more npm
# copies under its Actions Node runtimes. Repair every inherited node-tar copy
# so the dedicated Playwright image does not retain CVE-2026-59873.
COPY apps/runner-autoscaler/runner-image/repair-node-tar.sh /tmp/repair-node-tar.sh
RUN bash /tmp/repair-node-tar.sh && rm /tmp/repair-node-tar.sh

# Runtime checks for the Actions Node runtimes copied into this image.
COPY apps/runner-autoscaler/runner-image/externals-health.sh /usr/local/lib/agent-lcars/externals-health.sh
RUN chmod +r /usr/local/lib/agent-lcars/externals-health.sh

# Nothing else is INSTALLED here apart from the pnpm seed above.
# tools/e2e/Dockerfile already bakes the JRE
# (Firebase emulators) and `corepack enable`; Node ships in the Playwright
# base underneath it. The sandbox deliberately leaves pnpm's version to
# whichever repo is mounted, so this pool's own image warms the runner user's
# Corepack cache below with this repo's pinned pnpm. Without it,
# setup-node-pnpm's offline probe failed and every E2E job downloaded pnpm
# through pnpm/action-setup and actions/setup-node.
#
# gh CLI and Git LFS remain deliberately absent because this repo's
# console-e2e suite reads neither live PR state nor committed pixel goldens.
# A minimal entrypoint wrapper verifies the baked Actions runtimes before the
# runner registers with GitHub. Everything else the generic JIT worker image's
# wrapper does remains out of scope.
COPY tools/e2e-runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Read the pin from package.json rather than restating it here.
COPY package.json /usr/local/share/agent-lcars-corepack/package.json

USER runner
# The default COREPACK_HOME (~/.cache/node/corepack) is the runner user's, so
# no root-owned cache can lock that user out. The offline smoke runs where
# setup-node-pnpm's detect-baked.sh probes: a checkout with the same pin.
RUN cd /usr/local/share/agent-lcars-corepack \
  && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install --global \
    "$(node -p 'require("./package.json").packageManager')" \
  && COREPACK_ENABLE_NETWORK=0 pnpm --version
WORKDIR /home/runner

ENTRYPOINT ["/entrypoint.sh"]
