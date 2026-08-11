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
# Multi-arch: the fleet's other pools (homelab-autoscale-lcars-ci,
# homelab-autoscale-claude-agent-lcars, ...) span spark (arm64) alongside the
# amd64 hosts, and lcars-e2e is sized/placed the same way (see the homelab
# orchestrator.yml comment on that scale set) -- so both this and the sandbox
# base publish linux/amd64 and linux/arm64.
#
# Build:
#   TAG="df-$(sha256sum tools/e2e/Dockerfile | cut -c1-12)"
#   docker buildx build \
#     --build-arg SANDBOX_IMAGE=<registry>/agent-lcars/e2e:$TAG \
#     -f tools/e2e-runner/Dockerfile tools/e2e-runner

# Digest-pinned mirror, matching apps/runner-autoscaler/runner-image's own
# RUNNER_BASE in this repo. Only the agent payload is copied out of it --
# none of its OS layers -- so the runtime environment stays exactly the
# sandbox's.
ARG RUNNER_BASE=docker-registry.lan.jlapenna.net/mirror/actions-runner@sha256:0cfdcc701ce933c6d243c6b0b2da767366dc9f2e99961d4c3754b0b78084cdda
ARG SANDBOX_IMAGE

FROM ${RUNNER_BASE} AS agent

FROM ${SANDBOX_IMAGE}
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
USER root

# uid 1002, NOT the 1001 both base images already use for their own default
# user (RUNNER_BASE's `runner` and the Playwright base's `pwuser` collide on
# that uid) -- confirmed against both images directly, not assumed. Nothing
# depends on the agent's original uid -- a JIT config carries none -- but
# /home/runner must be owned by whoever executes run.sh, hence --chown on
# the COPY below.
RUN groupadd -g 1002 runner \
  && useradd -m -u 1002 -g 1002 -s /bin/bash runner

# Agent payload only: bin/, externals/, run.sh, config.sh, env.sh. The
# upstream base is JIT-native (honors ACTIONS_RUNNER_INPUT_JITCONFIG), so
# the scaler's container spec needs no change to drive this image.
COPY --from=agent --chown=runner:runner /home/runner /home/runner

# Nothing else is INSTALLED here. tools/e2e/Dockerfile already bakes the JRE
# (Firebase emulators) and `corepack enable`; Node ships in the Playwright
# base underneath it. Unlike sprinkles' own e2e-runner image, this repo's
# sandbox never runs `corepack prepare pnpm@<pinned> --activate` as root --
# it only enables the shims, deferring version resolution to whichever
# repo's packageManager field is read at first `pnpm` invocation (see
# tools/e2e/Dockerfile's own comment) -- so there is no root-owned pinned
# pnpm cache here for the `runner` user to be locked out of, and no
# COREPACK_HOME relocation is needed the way sprinkles' image requires.
#
# gh CLI and git-lfs are also deliberately absent: this repo's console-e2e
# suite does not shell out to either (unlike sprinkles' e2e.yml, which reads
# live PR labels via `gh pr view` and checks out LFS-tracked screenshot
# baselines inside its own container job) -- confirmed by grepping
# apps/console-e2e, tools/e2e, and ci.yml's checkout step before leaving them
# out, not assumed from the sprinkles precedent.
USER runner
WORKDIR /home/runner

# run.sh directly, with no entrypoint wrapper: the shared JIT runner image's
# wrapper (apps/runner-autoscaler/runner-image/entrypoint.sh) exists to
# repair /home/runner/externals from a backup because externals is a shared
# bind mount on socket-mounted scale sets, and to preflight node20/node24 for
# arbitrary Actions runtimes -- neither applies here. runnerBinds only
# creates that bind for mount_docker_socket pools, and this pool is not one;
# externals stays exactly as baked in, container-local and uncontended. No
# telemetry sidecar either -- that is claude.yml's concern on the
# claude-agent pool, not this one's.
ENTRYPOINT ["/home/runner/run.sh"]
