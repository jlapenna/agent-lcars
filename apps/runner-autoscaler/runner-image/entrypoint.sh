#!/bin/bash
set -e

# agent-lcars (native-work-items sub-project 4): a container the
# runner-autoscaler launched directly for one claimed queue-executor run,
# not a registered GitHub Actions runner at all. Checked first so a
# preflight failure in the GitHub-runner path below never gates it.
if [ "${RUNNER_MODE:-}" = "direct" ]; then
  exec /usr/local/lib/agent-lcars/direct-runner.sh
fi

# Invoke each required Actions Node runtime rather than merely checking that
# its binary exists.
# shellcheck source=externals-health.sh
source /usr/local/lib/agent-lcars/externals-health.sh
# shellcheck source=toolchain-health.sh
source /usr/local/lib/agent-lcars/toolchain-health.sh

# Preflight: fail the boot loudly if a required runtime does not run, rather than
# silently proceeding to run.sh, which registers with GitHub and can accept
# a real job doomed to fail before checkout even starts. A container that
# exits here without registering is swept by the scaler's existing
# crash-loop/orphan cleanup (see deregisterRunner), the same path already
# used for a dead host or a crash-looping image.
if ! required_node_runtimes_run; then
  echo "FATAL: required Actions runtimes node20/node24 failed a preflight invocation" >&2
  exit 1
fi

# Corepack/pnpm is smoke-checked and warmed for this user while the image is
# built, but runner registration is the last safe point to catch a damaged or
# missing shim in the filesystem that actually reached a host (#468). Keep the
# probe to a version invocation: it exercises shim resolution and the cached
# package-manager binary without performing an install or touching a repo.
if ! pnpm_runs; then
  echo "FATAL: pnpm/corepack failed a preflight invocation" >&2
  exit 1
fi

if ! java_21_runs; then
  echo "FATAL: Java 21+ failed a preflight invocation" >&2
  exit 1
fi

if ! trusted_opencode_runs /usr/local/bin/opencode; then
  echo "FATAL: trusted OpenCode CLI failed a preflight invocation" >&2
  exit 1
fi

# agent-lcars#1330: point the runner at the baked action-archive cache so
# `uses:` tarballs resolve locally instead of from codeload (outage
# resilience). Guarded: a runner image built before the bake simply skips it.
if [ -d /opt/actions-archive-cache ]; then
  export ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/opt/actions-archive-cache
fi

# Execute the runner's standard run script with passed arguments
exec /home/runner/run.sh "$@"
