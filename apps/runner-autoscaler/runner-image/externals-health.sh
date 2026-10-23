#!/bin/sh
# Sourced by verify-image-invariants.sh at image build to prove the Actions
# Node runtimes baked into each isolated runner image (#2033).

node_runtime_runs() {
  "${AGENT_LCARS_EXTERNALS_DIR:-/home/runner/externals}/$1/bin/node" \
    --version >/dev/null 2>&1
}

node24_runs() {
  node_runtime_runs node24
}

# GitHub's supported migration flag routes older action metadata (including
# OpenCode's actions/cache@v4) through the patched Node 24 runtime. Refuse an
# image that would fall back to the retired Node 20 runtime.
required_node_runtimes_run() {
  [ "${FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:-}" = true ] && node24_runs
}
