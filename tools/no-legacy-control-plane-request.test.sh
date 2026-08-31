#!/usr/bin/env bash
# Contract: executable and current source must not restore the retired
# GitHub-automation admission endpoint or its OIDC audience. Historical design
# records under docs/superpowers are intentionally excluded: they document the
# completed migration rather than a supported runtime surface.
set -euo pipefail

retired_path='/api/control-plane/'"request"
retired_audience='agent-lcars-dispatch-'"request"

matches="$(
  rg -n --hidden --glob '!node_modules' --glob '!.git' \
    --glob '!docs/superpowers/**' \
    -e "$retired_path" -e "$retired_audience" \
    apps libs .github tools docs agents .agents || true
)"

if [[ -n "$matches" ]]; then
  printf '%s\n' 'retired control-plane dispatch admission remains in current source:' >&2
  printf '%s\n' "$matches" >&2
  exit 1
fi

printf '%s\n' 'ok - retired control-plane dispatch admission is absent'
