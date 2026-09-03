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

# No loki-url input (or repository variable) supplied: this is the
# fail-soft disabled-shipper state (#1751 removed the fleet-specific
# action.yml default), so it must no-op AND surface an explicit
# ::notice:: rather than silently shipping nowhere.
mkdir -p "$page_dir"
rm -f "$calls"
notice_output="$test_root/notice-output"
RUNNER_ENVIRONMENT=self-hosted \
  JOB_DAEMON_BIN="$stub" \
  CALLS="$calls" \
  AGENT_LCARS_CI_LOG_PAGE_DIR="$page_dir" \
  "$action_dir/lifecycle.sh" start >"$notice_output"
[ ! -e "$calls" ] || fail 'empty Loki URL start called the daemon'
grep -Fq '::notice::ci-log-stream:' "$notice_output" || \
  fail 'empty Loki URL start did not emit an explicit ::notice::'

RUNNER_ENVIRONMENT=self-hosted \
  JOB_DAEMON_BIN="$stub" \
  CALLS="$calls" \
  "$action_dir/lifecycle.sh" invalid

echo 'lifecycle.test.sh: all cases passed'
