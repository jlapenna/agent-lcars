#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=nx-native-file-cache.sh
. "$ROOT/tools/nx-native-file-cache.sh"
prepare_agent_lcars_nx_native_file_cache "$ROOT"
