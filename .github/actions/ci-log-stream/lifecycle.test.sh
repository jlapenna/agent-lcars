#!/usr/bin/env bash
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

stub="$test_root/job-daemon.sh"
calls="$test_root/calls"
cat >"$stub" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CALLS"
exit 0
STUB
chmod +x "$stub"

page_dir="$test_root/pages"
mkdir -p "$page_dir"

RUNNER_ENVIRONMENT=github-hosted \
  JOB_DAEMON_BIN="$stub" \
  CALLS="$calls" \
  AGENT_LCARS_CI_LOG_PAGE_DIR="$page_dir" \
  AGENT_LCARS_CI_LOG_LOKI_URL=http://loki.invalid/loki/api/v1/push \
  "$action_dir/lifecycle.sh" start
[ ! -e "$calls" ] || fail 'GitHub-hosted start called the daemon'

RUNNER_ENVIRONMENT=self-hosted \
  JOB_DAEMON_BIN="$stub" \
  CALLS="$calls" \
  AGENT_LCARS_CI_LOG_PAGE_DIR="$page_dir" \
  AGENT_LCARS_CI_LOG_LOKI_URL=http://loki.invalid/loki/api/v1/push \
  "$action_dir/lifecycle.sh" start
grep -Fq "start ci-log-stream -- node $action_dir/shipper.mjs" "$calls" || \
  fail 'self-hosted start did not delegate to job-daemon.sh'

rm -rf "$page_dir"
RUNNER_ENVIRONMENT=self-hosted \
  JOB_DAEMON_BIN="$stub" \
  CALLS="$calls" \
  "$action_dir/lifecycle.sh" stop
grep -Fq 'stop ci-log-stream' "$calls" || \
  fail 'stop did not delegate when the page directory was gone'

RUNNER_ENVIRONMENT=self-hosted \
  JOB_DAEMON_BIN="$stub" \
  CALLS="$calls" \
  "$action_dir/lifecycle.sh" invalid

echo 'lifecycle.test.sh: all cases passed'
