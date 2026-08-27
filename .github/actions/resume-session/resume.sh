#!/usr/bin/env bash
# .github/actions/resume-session/resume.sh
#
# Downloads a prior session's transcript into Claude Code's local session
# store when the dispatched work carries a resume request. Fail-soft: any
# missing input or failed download prints nothing, and this always exits
# 0 -- a broken resume degrades to a fresh run (native work items
# sub-project 6).
#
# Reads WORK_JSON (the `work` workflow_dispatch input, JSON) and
# GOOGLE_APPLICATION_CREDENTIALS from the environment -- passed via the
# composite action's own `env:` block, never interpolated into a `run:`
# script's text. work-json carries untrusted work-item title/description
# content, and inline-interpolating it into a quoted shell argument (as
# opposed to passing it through env:) would let a stray `'` in that text
# break out of the quoting -- the same convention
# prepare-agent-dispatch/action.yml's `work` input already follows for the
# identical reason.
#
# SIDECAR_BIN defaults to the runner image's baked location and is
# env-overridable for tests, matching direct-runner.sh's baked-tool-path
# convention.
set -uo pipefail

WORK_JSON="${WORK_JSON:-}"
SIDECAR_BIN="${SIDECAR_BIN:-/usr/local/lib/agent-lcars/sidecar.cjs}"

session_id="$(jq -r '.resume.sessionId // empty' <<<"$WORK_JSON" 2>/dev/null || true)"
transcript_uri="$(jq -r '.resume.transcriptGcsUri // empty' <<<"$WORK_JSON" 2>/dev/null || true)"

if [ -z "$session_id" ] || [ -z "$transcript_uri" ] || \
   [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] || [ ! -s "$SIDECAR_BIN" ]; then
  exit 0
fi

# AGENT_TELEMETRY_PROJECT_ID is exported inline exactly as
# sidecar-lifecycle.sh already does for `runner sidecar`/`runner
# finalize` -- the same GCS project the transcript was uploaded to.
# `runner resume`'s own `--project-id` flag falls back to this same env
# var (apps/telemetry-watcher/src/main.ts), so no extra flag is needed
# here.
resumed_path="$(AGENT_TELEMETRY_PROJECT_ID=agent-lcars node "$SIDECAR_BIN" runner resume \
  --session-id "$session_id" --transcript-uri "$transcript_uri" --cwd "$PWD" \
  2>/dev/null || true)"

if [ -n "$resumed_path" ]; then
  echo "session-id=$session_id"
fi
exit 0
