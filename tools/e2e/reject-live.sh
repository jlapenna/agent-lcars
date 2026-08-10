#!/usr/bin/env bash

set -euo pipefail

echo "live E2E is disabled: real Firebase configuration cannot cross the dummy-only hermetic boundary" >&2
echo "use the emulator configuration" >&2
exit 2
