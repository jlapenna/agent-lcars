#!/usr/bin/env bash
# Exercises job-daemon.sh directly against real backgrounded processes (not a
# fake) -- the behaviour under test IS process lifecycle (does the right pid
# survive, does the right pid die, do two names share nothing), so a fake
# process would test nothing real. AGENT_LCARS_JOB_DAEMON_STATE_ROOT keeps
# every case under this run's own temp dir, never the real
# /tmp/agent-lcars-job-daemon.
set -uo pipefail

bin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$bin_dir/job-daemon.sh"
test_root="$(mktemp -d)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Reaps anything any case below left running (by pid file, wherever it
# landed under test_root) before removing the temp root -- belt-and-braces
# on top of each case's own explicit stop, so a failed assertion mid-case
# can never leak a live `sleep` process past this script's own exit.
cleanup() {
  local pid_file pid
  if [ -d "$test_root" ]; then
    while IFS= read -r -d '' pid_file; do
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      case "$pid" in
        '' | *[!0-9]*) ;;
        *) kill "$pid" 2>/dev/null || true ;;
      esac
    done < <(find "$test_root" -name daemon.pid -print0 2>/dev/null)
  fi
  rm -rf "$test_root"
}
trap cleanup EXIT

alive() { kill -0 "$1" 2>/dev/null; }

wait_gone() {
  # Bounded poll for a pid to disappear, for assertions only -- the
  # production bounded-wait lives inside job-daemon.sh's own `stop`; this
  # is just so a test doesn't race a background exit.
  local pid="$1"
  for _ in $(seq 1 25); do
    alive "$pid" || return 0
    sleep 0.2
  done
  return 1
}

# --- Case 1: two named daemons run concurrently, independently, without
# colliding or sharing PID state --------------------------------------------
root1="$test_root/two-daemons"
mkdir -p "$root1"
AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root1" "$script" start alpha -- sleep 60 \
  >/dev/null || fail "starting alpha failed"
AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root1" "$script" start beta -- sleep 60 \
  >/dev/null || fail "starting beta failed"

alpha_pid_file="$root1/alpha/daemon.pid"
beta_pid_file="$root1/beta/daemon.pid"
[ -f "$alpha_pid_file" ] || fail "alpha's pid file was not created"
[ -f "$beta_pid_file" ] || fail "beta's pid file was not created"
test "$alpha_pid_file" != "$beta_pid_file" || fail "alpha and beta share a pid file path"

alpha_pid="$(cat "$alpha_pid_file")"
beta_pid="$(cat "$beta_pid_file")"
test -n "$alpha_pid" || fail "alpha's pid file is empty"
test -n "$beta_pid" || fail "beta's pid file is empty"
test "$alpha_pid" != "$beta_pid" || fail "alpha and beta recorded the same pid"
alive "$alpha_pid" || fail "alpha is not running right after start"
alive "$beta_pid" || fail "beta is not running right after start"

AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root1" "$script" stop alpha >/dev/null \
  || fail "stopping alpha failed"
wait_gone "$alpha_pid" || fail "alpha is still running after stop"
alive "$beta_pid" || fail "stopping alpha also killed beta"
[ ! -f "$alpha_pid_file" ] || fail "alpha's pid file survived stop"
[ -f "$beta_pid_file" ] || fail "beta's pid file was removed by alpha's stop"

AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root1" "$script" stop beta >/dev/null \
  || fail "stopping beta failed"
wait_gone "$beta_pid" || fail "beta is still running after stop"
[ ! -f "$beta_pid_file" ] || fail "beta's pid file survived stop"

echo "job-daemon.test.sh: case 1 ok (two independent daemons)"

# --- Case 2: stop on a never-started daemon exits 0 -------------------------
root2="$test_root/never-started"
mkdir -p "$root2"
out="$(AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root2" "$script" stop ghost 2>&1)"
status=$?
test "$status" -eq 0 || fail "stop on a never-started daemon must exit 0 (got $status): $out"
echo "$out" | grep -qi "never started" || fail "stop on a never-started daemon should say so: $out"

echo "job-daemon.test.sh: case 2 ok (stop on never-started exits 0)"

# --- Case 3: stop on a daemon whose process already exited exits 0 ---------
root3="$test_root/already-exited"
mkdir -p "$root3"
AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root3" "$script" start done-quick -- true \
  >/dev/null || fail "starting done-quick failed"
done_pid_file="$root3/done-quick/daemon.pid"
done_pid="$(cat "$done_pid_file")"
wait_gone "$done_pid" || fail "done-quick's process never exited on its own"

out="$(AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root3" "$script" stop done-quick 2>&1)"
status=$?
test "$status" -eq 0 || fail "stop on an already-exited daemon must exit 0 (got $status): $out"
[ ! -f "$done_pid_file" ] || fail "pid file for an already-exited daemon survived stop"

echo "job-daemon.test.sh: case 3 ok (stop on already-exited process exits 0)"

# --- Case 4: start with no --log creates no file beyond the pid file -------
root4="$test_root/no-log"
mkdir -p "$root4"
AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root4" "$script" start quiet -- sleep 5 \
  >/dev/null || fail "starting quiet failed"
quiet_pid_file="$root4/quiet/daemon.pid"
[ -f "$quiet_pid_file" ] || fail "quiet's pid file was not created"
extra_files="$(find "$root4/quiet" -type f ! -name daemon.pid)"
[ -z "$extra_files" ] || fail "start with no --log created unexpected file(s): $extra_files"
quiet_pid="$(cat "$quiet_pid_file")"
AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root4" "$script" stop quiet >/dev/null \
  || fail "stopping quiet failed"
wait_gone "$quiet_pid" || fail "quiet is still running after stop"

echo "job-daemon.test.sh: case 4 ok (no --log means no extra file)"

# --- Case 5: --log writes where told ----------------------------------------
root5="$test_root/with-log"
mkdir -p "$root5"
log_path="$test_root/nested/dir/daemon.log"
AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root5" "$script" start logger \
  --log "$log_path" -- bash -c 'printf "hello-from-daemon\n"; sleep 5' \
  >/dev/null || fail "starting logger failed"
logger_pid_file="$root5/logger/daemon.pid"
logger_pid="$(cat "$logger_pid_file")"

logged=0
for _ in $(seq 1 25); do
  if [ -s "$log_path" ] && grep -Fq "hello-from-daemon" "$log_path"; then
    logged=1
    break
  fi
  sleep 0.2
done
test "$logged" -eq 1 || fail "--log <path> never received the daemon's output"
extra_files="$(find "$root5/logger" -type f ! -name daemon.pid)"
[ -z "$extra_files" ] || fail "--log wrote into the state dir instead of the given path: $extra_files"

AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root5" "$script" stop logger >/dev/null \
  || fail "stopping logger failed"
wait_gone "$logger_pid" || fail "logger is still running after stop"

echo "job-daemon.test.sh: case 5 ok (--log writes to the given path)"

# --- Case 6: an unsafe <name> is rejected without touching anything -------
root6="$test_root/unsafe-name"
mkdir -p "$root6"
before="$(find "$root6" | sort)"

for bad_name in '../escape' 'nested/name' '..' '.' '/etc/passwd' '' '-x' '--evil'; do
  out="$(AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root6" "$script" start "$bad_name" -- sleep 5 2>&1)"
  status=$?
  test "$status" -eq 0 || fail "an unsafe name ('$bad_name') on start must still exit 0 (got $status): $out"
  echo "$out" | grep -qi "invalid" || fail "an unsafe name ('$bad_name') on start should be reported as invalid: $out"

  out="$(AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root6" "$script" stop "$bad_name" 2>&1)"
  status=$?
  test "$status" -eq 0 || fail "an unsafe name ('$bad_name') on stop must still exit 0 (got $status): $out"
  echo "$out" | grep -qi "invalid" || fail "an unsafe name ('$bad_name') on stop should be reported as invalid: $out"
done

after="$(find "$root6" | sort)"
test "$before" = "$after" || fail "an unsafe name touched the state root:
before: $before
after:  $after"

# '..' as the name is the one that could plausibly escape upward if a caller
# ever built the path with something less strict than a slice/exact-match
# rejection -- confirm nothing appeared next to the state root either.
outside_root="$(dirname "$root6")"
outside_before_count="$(find "$outside_root" -maxdepth 1 | wc -l)"
AGENT_LCARS_JOB_DAEMON_STATE_ROOT="$root6" "$script" stop '..' >/dev/null 2>&1 || true
outside_after_count="$(find "$outside_root" -maxdepth 1 | wc -l)"
test "$outside_before_count" -eq "$outside_after_count" \
  || fail "a '..' name changed the contents of the state root's parent directory"

echo "job-daemon.test.sh: case 6 ok (unsafe names rejected, nothing touched)"

echo "job-daemon.test.sh: all cases passed"
