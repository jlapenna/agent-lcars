#!/bin/bash
set -e

# agent-lcars (native-work-items sub-project 4): a container the
# runner-autoscaler launched directly for one claimed queue-executor run,
# not a registered GitHub Actions runner at all.
if [ "${RUNNER_MODE:-}" = "direct" ]; then
  exec /usr/local/lib/agent-lcars/direct-runner.sh
fi

# The image-owned toolchain (Actions Node runtimes, Corepack pnpm, Java 21+,
# the trusted OpenCode CLI and its --auto contract, the action-archive cache)
# is proven once by verify-image-invariants.sh while the image is built
# (#2033). Every container starts from that verified, content-addressed
# filesystem and nothing mounts over those paths, so boot no longer re-runs
# the same probes before registering (#468's preflight moved to the build).

# agent-lcars#1330: point the runner at the baked action-archive cache so
# `uses:` tarballs resolve locally instead of from codeload (outage
# resilience).
export ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/opt/actions-archive-cache

# Execute the runner's standard run script with passed arguments
exec /home/runner/run.sh "$@"
