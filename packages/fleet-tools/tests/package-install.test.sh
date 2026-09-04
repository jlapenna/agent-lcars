#!/usr/bin/env bash
# The package's real consumption path: a global install (workstations run
# `pnpm add -g "github:jlapenna/agent-lcars#main&path:packages/fleet-tools"`,
# the runner image installs from its own fresh-main checkout). Assert the
# bin map materializes every fleet-* command and that the node guardrail's
# sibling module travels with the package.
set -euo pipefail
pkg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# resume-archive must compute the exact same Claude Code project-directory
# slug as claudeProjectSlugFor() in libs/telemetry/src/lib/runner-capture.ts
# for every absolute path. Source the real script (its main() is guarded by
# a `[[ "${BASH_SOURCE[0]}" == "$0" ]]` check, so sourcing it here only
# defines its functions, without downloading anything) and pin its
# claude_project_slug_for() helper against a table copied verbatim from that
# function's own spec (runner-capture.spec.ts), plus one extra case with the
# `_`/`+` characters from #1758's actual bug report, so the two
# implementations cannot drift silently again.
# shellcheck source=../bin/claude-agent-session.sh
source "$pkg_dir/bin/claude-agent-session.sh"
slug_failures=0
check_slug() {
  local cwd="$1" expected="$2" actual
  actual="$(claude_project_slug_for "$cwd")"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: claude_project_slug_for($cwd) = $actual, want $expected" >&2
    slug_failures=$((slug_failures + 1))
  fi
}
check_slug '/home/jlapenna/p/agent-lcars' '-home-jlapenna-p-agent-lcars'
check_slug '/tmp/agent-lcars-direct/checkout' '-tmp-agent-lcars-direct-checkout'
check_slug '/' '-'
check_slug '/home/jlapenna/p/agent-lcars/' '-home-jlapenna-p-agent-lcars-'
check_slug '/home/runner/work/agent-lcars.git/repo' '-home-runner-work-agent-lcars-git-repo'
check_slug '/home/jlapenna/.openclaw' '-home-jlapenna--openclaw'
check_slug '/home/jlapenna/p/agent-lcars_worktree+test' '-home-jlapenna-p-agent-lcars-worktree-test'
if [ "$slug_failures" -ne 0 ]; then
  echo "FAIL: $slug_failures claude_project_slug_for case(s) diverged from runner-capture.spec.ts" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

npm install -g --prefix "$tmp" "$pkg_dir" >/dev/null 2>&1

for cmd in fleet-claude-agent-session fleet-codex-issue-guardrail fleet-identity; do
  if [ ! -x "$tmp/bin/$cmd" ]; then
    echo "FAIL: $cmd not installed or not executable" >&2
    exit 1
  fi
done

real="$(readlink -f "$tmp/bin/fleet-codex-issue-guardrail")"
if [ ! -f "$(dirname "$real")/fleet-identity.cjs" ]; then
  echo "FAIL: fleet-identity.cjs did not travel with the package" >&2
  exit 1
fi

# QueueExecutor run IDs for GitHub anchors include `#` (for example,
# octo/example#42/r1). The installed session-recovery command must accept
# those IDs and use them unchanged for a Claude-only archive lookup, never
# choosing a Codex/OpenCode JSONL from the same run.
mkdir -p "$tmp/fake-bin" "$tmp/checkout" "$tmp/home"
cat > "$tmp/fake-bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${2:-}" in
  ls)
    [ "${3:-}" = 'gs://agent-lcars-session-transcripts/runs/octo/example#42/r1/claude-code/*.jsonl' ] || {
      echo "unexpected archive lookup: ${3:-}" >&2
      exit 1
    }
    printf '%s\n' 'gs://agent-lcars-session-transcripts/runs/octo/example#42/r1/claude-code/session-42.jsonl'
    ;;
  cp)
    printf 'transcript\n' > "$4"
    ;;
  *)
    echo "unexpected gcloud invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$tmp/fake-bin/gcloud"
(
  cd "$tmp/checkout"
  PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
    "$tmp/bin/fleet-claude-agent-session" resume-archive 'octo/example#42/r1' >/dev/null
)
if ! find "$tmp/home/.claude/projects" -name session-42.jsonl -type f | grep -q .; then
  echo "FAIL: GitHub-anchored QueueExecutor run ID did not restore its transcript" >&2
  exit 1
fi

echo "agent-tools package install: OK"
