#!/usr/bin/env bash
# Runner container teardown loses everything not already durably shipped
# (issue #24) - this is that last chance: stop the long-running sidecar (it
# must not race a doc write against this step's own authoritative one) and
# ship a final `ended` doc with the transcript archived to GCS, since the
# container disappears the moment the job ends. WRITER_CREDENTIALS_FILE,
# RUN_ID, NUM, and INTENT_ID are consumed by sidecar-lifecycle.sh itself,
# not this script directly.
set -euo pipefail

SCRIPT=/usr/local/lib/agent-lcars/sidecar-lifecycle.sh
if [ -x "$SCRIPT" ]; then
  "$SCRIPT" finalize
else
  echo "Sidecar tooling not found at $SCRIPT; skipping telemetry finalize."
fi
