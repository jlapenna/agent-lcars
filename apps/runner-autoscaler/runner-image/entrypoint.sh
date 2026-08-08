#!/bin/bash
set -e

# See externals-health.sh for required_node_runtimes_run and why the
# populate/repair check must actually invoke each required Node runtime rather
# than just stat it. Shared with the control plane's periodic idle-host
# maintenance sweep (scaler.go:sweepHostWorkDir, agent-lcars#392) so both call
# sites use identical logic instead of two copies that can drift apart.
# shellcheck source=externals-health.sh
source /usr/local/lib/agent-lcars/externals-health.sh
# shellcheck source=toolchain-health.sh
source /usr/local/lib/agent-lcars/toolchain-health.sh

repair_externals_if_needed

# Preflight: fail the boot loudly if node24 STILL doesn't run after that
# repair attempt (e.g. externals_backup itself is broken), rather than
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

# Execute the runner's standard run script with passed arguments
exec /home/runner/run.sh "$@"
