#!/bin/sh
# Sourced by runner entrypoints to verify the Actions Node runtimes baked into
# each isolated runner image.

node_runtime_runs() {
  "${AGENT_LCARS_EXTERNALS_DIR:-/home/runner/externals}/$1/bin/node" \
    --version >/dev/null 2>&1
}

node20_runs() {
  node_runtime_runs node20
}

node24_runs() {
  node_runtime_runs node24
}

# These are the non-Alpine runtimes proven reachable from actions used by the
# fleet: current first-party actions use node24, while OpenCode's pinned
# composite still calls actions/cache@v4, which declares node20 (#395). Do not
# probe every backup entry on every boot; add another runtime here only when a
# dispatched action demonstrates that dependency.
required_node_runtimes_run() {
  node20_runs && node24_runs
}
