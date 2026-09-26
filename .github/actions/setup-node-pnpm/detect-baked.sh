#!/usr/bin/env bash
# A stale image and every hosted runner keep the setup-action fallback.
set -euo pipefail
ready=false
requested="${REQUESTED_NODE_VERSION#v}"
if [[ "${RUNNER_ENVIRONMENT:-}" == self-hosted ]] &&
  [[ "$requested" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] &&
  actual_node="$(node -p 'process.versions.node' 2>/dev/null)" &&
  [[ "$actual_node" == "$requested" || "$actual_node" == "$requested".* ]] &&
  expected_pnpm="$(node -e '
    const value = require(process.cwd() + "/package.json").packageManager;
    const match = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)(?:\+.+)?$/.exec(value);
    if (!match) process.exit(1);
    process.stdout.write(match[1]);
  ' 2>/dev/null)" &&
  actual_pnpm="$(COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 timeout 5s pnpm --version 2>/dev/null)" &&
  [[ "$actual_pnpm" == "$expected_pnpm" ]]; then
  ready=true
else
  echo '::notice::Baked Node/pnpm is unavailable or does not match the requested versions; using setup actions.'
fi
echo "ready=$ready" >> "$GITHUB_OUTPUT"
