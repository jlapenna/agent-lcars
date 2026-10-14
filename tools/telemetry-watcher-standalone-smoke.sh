#!/usr/bin/env bash
# Verify the telemetry-watcher sidecar artifact runs without an ambient
# node_modules tree. The runner image executes this bundle (runner finalize
# and resume), so a successful image build alone is not sufficient evidence.
# The probe below runs `runner finalize` over a one-session fixture with no
# credentials: the bundle falls back to its log-only store, so the run loads
# every inlined dependency and exercises discovery, reduction, and the
# session write end to end without touching GCP.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

./tools/nx bundle @agent-lcars/telemetry-watcher

smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
cp dist/apps/telemetry-watcher/sidecar.cjs "$smoke_dir/"
projects_dir="$smoke_dir/home/.claude/projects"
mkdir -p "$projects_dir/-work-repo" "$smoke_dir/codex" "$smoke_dir/workspace"
cat >"$projects_dir/-work-repo/smoke-session.jsonl" <<'JSONL'
{"type":"user","sessionId":"smoke-session","cwd":"/work/repo","timestamp":"2026-10-13T00:00:00.000Z","message":{"role":"user","content":"hello"}}
{"type":"assistant","sessionId":"smoke-session","cwd":"/work/repo","timestamp":"2026-10-13T00:00:01.000Z","message":{"role":"assistant","model":"smoke-model","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1,"output_tokens":1}}}
JSONL

# A clean environment (no AGENT_TELEMETRY_*, GOOGLE_APPLICATION_CREDENTIALS,
# or FIRESTORE_EMULATOR_HOST) forces the log-only store. finalize exits 0 by
# contract and is one-shot, so require both a clean exit (a timeout's 124
# means the bundle left work pending and never terminated) and the log line
# (finalize fails soft, so exit 0 alone does not prove it wrote a session).
status=0
(
  cd "$smoke_dir"
  env -i PATH="$PATH" HOME="$smoke_dir/home" \
    GITHUB_WORKSPACE="$smoke_dir/workspace" \
    timeout 60s node sidecar.cjs runner finalize \
    --run-id smoke --repo smoke/repo \
    --projects-dir "$projects_dir" --codex-sessions-dir "$smoke_dir/codex"
) >"$smoke_dir/out.log" 2>&1 || status=$?

if [ "$status" -ne 0 ]; then
  if [ "$status" -eq 124 ]; then
    echo 'telemetry-watcher bundle finalize did not terminate within 60s' >&2
  else
    echo "telemetry-watcher bundle finalize exited $status" >&2
  fi
  cat "$smoke_dir/out.log" >&2
  exit 1
fi

if ! grep -q 'finalized session smoke-session (run smoke)' "$smoke_dir/out.log"; then
  echo 'telemetry-watcher bundle did not finalize standalone' >&2
  cat "$smoke_dir/out.log" >&2
  exit 1
fi

grep 'finalized session smoke-session' "$smoke_dir/out.log"
