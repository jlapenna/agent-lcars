#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
# Exported: the fake curl/git/gh/claude binaries below run as separate
# processes (found via PATH, not sourced), so they only see `tmp` if it is
# actually in their environment -- an unexported `tmp` would leave every
# `$tmp/...` reference inside those heredocs resolving to an empty prefix
# once direct-runner.sh execs them for real.
tmp="$(mktemp -d)"
export tmp
trap 'rm -rf "$tmp"' EXIT

# --- Fake baked image tree -------------------------------------------------
# direct-runner.sh's PREPARE_DISPATCH_DIR default assumes prepare.sh's own
# unmodified `$GITHUB_ACTION_PATH/../../../agents/shared/skills/...` climb
# resolves against a REAL baked filesystem layout: the Dockerfile places
# prepare-agent-dispatch/ at .github/actions/prepare-agent-dispatch under
# /usr/local/lib/agent-lcars/ (treated as a fake "repo root"), with
# agents/shared/skills/ as its sibling at that same fake root -- see the
# Dockerfile's own comment next to those COPY lines. Building that SAME
# relative layout here, from this repo's real checked-in scripts, is what
# actually exercises the climb instead of masking it (fix round 1,
# review-critical): pointing PREPARE_DISPATCH_DIR straight at
# $repo_root/.github/actions/prepare-agent-dispatch, as an earlier version
# of this test did, makes the climb land on the REAL repo root, which also
# happens to have agents/shared/skills -- so that version of this test
# passed even though the real image never baked that directory at all.
baked="$tmp/baked"
mkdir -p "$baked/.github/actions"
cp -R "$repo_root/.github/actions/prepare-agent-dispatch" "$baked/.github/actions/prepare-agent-dispatch"
mkdir -p "$baked/.github/actions/verify-deliverable"
cp "$repo_root/.github/actions/verify-deliverable/verify-deliverable.sh" \
  "$baked/.github/actions/verify-deliverable/verify-deliverable.sh"
mkdir -p "$baked/agents/shared/skills"
cp -R "$repo_root/agents/shared/skills/." "$baked/agents/shared/skills/"

BAKED_PREPARE_DISPATCH_DIR="$baked/.github/actions/prepare-agent-dispatch"
BAKED_VERIFY_DELIVERABLE="$baked/.github/actions/verify-deliverable/verify-deliverable.sh"
BAKED_SIDECAR_LIFECYCLE="$repo_root/apps/telemetry-watcher/bin/sidecar-lifecycle.sh"

# A distinctive value (not a real secret) asserted absent from every place
# a leaked credential could land -- $workspace/.git/config and the fake
# git's recorded clone argv (fix round 1, review-critical #2).
export FAKE_TOKEN="fake-checkout-token-xyz789"

# --- Fake binary factory ----------------------------------------------------
# Installs curl/git/gh/claude fakes into "$1/bin". Every curl call in
# direct-runner.sh sends its bearer/url/timeouts via `--config -` (stdin),
# never `-H`/argv (fix round 1: agent-fallback-finalize.yml's own completion
# callback does the same, to keep a bearer token out of `ps aux`/cmdline),
# so this fake curl parses url/data-binary out of that stdin config block
# instead of scanning argv for a bare "http*" token. Each scenario exports
# its own COMPLETE_LOG/GIT_CLONE_ARGV_LOG so scenarios never share state.
make_fake_bins() {
  bindir="$1"
  mkdir -p "$bindir"

  cat > "$bindir/curl" <<'FAKE'
#!/usr/bin/env bash
url=""
config_stdin=false
prev=""
for arg in "$@"; do
  if [ "$prev" = "--config" ] && [ "$arg" = "-" ]; then
    config_stdin=true
  fi
  case "$arg" in
    http*) url="$arg" ;;
  esac
  prev="$arg"
done

data_binary_file=""
if $config_stdin; then
  config_body="$(cat)"
  cfg_url="$(printf '%s\n' "$config_body" | sed -nE 's/^url = "(.*)"$/\1/p')"
  [ -n "$cfg_url" ] && url="$cfg_url"
  data_binary_file="$(printf '%s\n' "$config_body" | sed -nE 's/^data-binary = "@(.*)"$/\1/p')"
  # Fails closed if a caller ever regresses and puts the raw token back in
  # the URL -- proves this for every call a scenario makes, not just the
  # one a scenario explicitly asserts on afterward.
  case "$url" in
    *"$FAKE_TOKEN"*)
      echo "fake curl: refusing to leak token via URL: $url" >&2
      exit 1
      ;;
  esac
fi

case "$url" in
  */brief)
    if [ "${FAKE_BRIEF_FAIL:-}" = "1" ]; then
      echo "fake curl: simulated brief failure (expired/invalid run token)" >&2
      exit 22
    fi
    cat <<'JSON'
{"id":"01DIRECTRUNNERTESTFIXTURE1","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"octo/example"}},"anchor":{"type":"work","id":"01DIRECTRUNNERTESTFIXTURE1","title":"t","body":"d","target_repo":"octo/example","html_url":"https://lcars.test/work/01DIRECTRUNNERTESTFIXTURE1"},"attemptId":"g1:work:01DIRECTRUNNERTESTFIXTURE1/r1","generation":1,"intentId":"work:01DIRECTRUNNERTESTFIXTURE1/r1"}
JSON
    ;;
  */checkout-token)
    echo "{\"token\":\"$FAKE_TOKEN\",\"expiresAt\":\"2026-08-27T01:00:00.000Z\"}"
    ;;
  */heartbeat)
    echo '{"runId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","expiresAt":"2026-08-27T01:00:00.000Z"}'
    ;;
  */complete)
    {
      echo "URL=$url"
      [ -n "$data_binary_file" ] && cat "$data_binary_file"
    } >> "$COMPLETE_LOG"
    echo '{"runId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","state":"finished"}'
    ;;
  *)
    echo "fake curl: unhandled URL $url" >&2
    exit 1
    ;;
esac
FAKE
  chmod +x "$bindir/curl"

  # `clone`/`config` are matched anywhere in argv, not at $1, because
  # direct-runner.sh's clone now runs as `git -c http.extraheader=... clone
  # ...` (fix round 1 #2) -- `$1` would be `-c`, not `clone`, under simpler
  # positional matching.
  cat > "$bindir/git" <<'FAKE'
#!/usr/bin/env bash
is_clone=false
is_config=false
for arg in "$@"; do
  case "$arg" in
    clone) is_clone=true ;;
    config) is_config=true ;;
  esac
done
if $is_clone; then
  printf '%s\n' "$*" >> "$GIT_CLONE_ARGV_LOG"
  target="${@: -1}"
  mkdir -p "$target/.git"
elif $is_config; then
  printf '%s\n' "$*" >> ".git/config"
fi
exit 0
FAKE
  chmod +x "$bindir/git"

  cat > "$bindir/gh" <<'FAKE'
#!/usr/bin/env bash
if [[ "$*" == *"pulls?state=all"* ]]; then
  if [ "${FAKE_GH_NO_MATCH:-}" = "1" ]; then
    echo ""
  else
    echo '12'
  fi
  exit 0
fi
echo '[]'
FAKE
  chmod +x "$bindir/gh"

  # Ignores every flag, including the real --dangerously-skip-permissions/
  # --allowedTools/--disallowedTools direct-runner.sh passes.
  cat > "$bindir/claude" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
  chmod +x "$bindir/claude"
}

run_scenario() {
  name="$1"
  dir="$tmp/$name"
  mkdir -p "$dir/bin"
  make_fake_bins "$dir/bin"

  export PATH="$dir/bin:$PATH"
  export LCARS_RUN_ID="work:01DIRECTRUNNERTESTFIXTURE1/r1"
  export LCARS_RUN_TOKEN="test-token"
  export LCARS_CONSOLE_URL="https://lcars.test"
  export RUNNER_TEMP="$dir/runner-temp"
  export HOME="$dir/home"
  mkdir -p "$RUNNER_TEMP" "$HOME"

  export COMPLETE_LOG="$dir/complete-calls.log"
  export GIT_CLONE_ARGV_LOG="$dir/git-clone-argv.log"

  # Bounds the background heartbeat loop's orphaned-sleep lifetime to
  # ~1 second instead of the production 300s default: fake `claude` returns
  # near-instantly, so direct-runner.sh kills (without waiting on) the loop
  # well before its first tick either way, but a short interval keeps a
  # not-yet-reaped `sleep` process from lingering past this test's own exit.
  export HEARTBEAT_INTERVAL_SECONDS=1

  # Point every baked-tool env var at the fake baked tree built above (not
  # the live repo -- see its own header comment), so this test exercises
  # the REAL prepare.sh/verify-deliverable.sh/sidecar-lifecycle.sh through
  # the SAME relative layout the Dockerfile actually produces.
  export PREPARE_DISPATCH_DIR="$BAKED_PREPARE_DISPATCH_DIR"
  export VERIFY_DELIVERABLE="$BAKED_VERIFY_DELIVERABLE"
  export SIDECAR_LIFECYCLE="$BAKED_SIDECAR_LIFECYCLE"

  set +e
  bash "$here/direct-runner.sh"
  rc=$?
  set -e
  workspace="$RUNNER_TEMP/checkout"
}

fail() {
  echo "$1" >&2
  exit 1
}

# --- Scenario 1: happy path (pull-request outcome) --------------------------
# `TARGET_REPO` in the fake brief is `octo/example`, not `jlapenna/agent-
# lcars`, so prepare.sh's own `assert-consumer-boundaries.sh` call takes its
# "any other repository" branch and returns immediately.
run_scenario happy-path

[ "$rc" -eq 0 ] || fail "happy path: expected exit 0, got $rc"
[ -f "$COMPLETE_LOG" ] || fail "happy path: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"pull-request"' "$COMPLETE_LOG" ||
  fail "happy path: complete call did not report outcome: pull-request ($(cat "$COMPLETE_LOG"))"

# Fix round 1, review-critical #2: the raw checkout token must never land
# in the persisted git config or in the clone's own recorded argv (only its
# base64-encoded header form, in .git/config, is expected -- that mirrors
# actions/checkout's own persist-credentials shape and does not contain the
# raw token string as a byte-for-byte substring).
if grep -q "$FAKE_TOKEN" "$workspace/.git/config" 2>/dev/null; then
  fail "happy path: raw checkout token leaked into $workspace/.git/config"
fi
if grep -q "$FAKE_TOKEN" "$GIT_CLONE_ARGV_LOG" 2>/dev/null; then
  fail "happy path: raw checkout token leaked into git clone argv ($(cat "$GIT_CLONE_ARGV_LOG"))"
fi

# Final-review fix: direct mode configures its own commit identity (no
# agent-setup/action.yml composite action to do it, unlike GitHub-Actions
# mode) -- assert it actually landed in the checkout's own git config, not
# just that direct-runner.sh ran the config command without erroring.
if ! grep -q "user.email" "$workspace/.git/config" 2>/dev/null; then
  fail "happy path: git commit identity (user.email) was not configured in $workspace/.git/config"
fi

echo "scenario happy-path: OK"

# --- Scenario 2: no-deliverable ---------------------------------------------
# The PR-marker lookup gh api call finds nothing, so verify-deliverable.sh's
# own gate fails closed. direct-runner.sh must still POST /complete (with
# the failure outcome, never silently drop it) and, by this script's own
# exit-code design (a non-pull-request outcome exits non-zero so container-
# level supervision can tell success and failure apart without re-parsing
# stdout), exit non-zero itself.
export FAKE_GH_NO_MATCH=1
run_scenario no-deliverable
unset FAKE_GH_NO_MATCH

[ "$rc" -ne 0 ] || fail "no-deliverable: expected a non-zero exit, got 0"
[ -f "$COMPLETE_LOG" ] || fail "no-deliverable: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"no-deliverable"' "$COMPLETE_LOG" ||
  fail "no-deliverable: complete call did not report outcome: no-deliverable ($(cat "$COMPLETE_LOG"))"

echo "scenario no-deliverable: OK"

# --- Scenario 3: brief 401 (expired/invalid run token) ----------------------
# The very first call (GET .../brief) fails closed. direct-runner.sh must
# abort immediately under `set -e` -- no clone, no claude invocation, and
# critically no completion callback at all (there is no run-token-
# authenticated way to report one: `complete` itself needs the same token
# that just failed brief).
export FAKE_BRIEF_FAIL=1
run_scenario brief-401
unset FAKE_BRIEF_FAIL

[ "$rc" -ne 0 ] || fail "brief-401: expected a non-zero exit, got 0"
[ ! -f "$COMPLETE_LOG" ] || fail "brief-401: direct-runner.sh called POST .../complete after a failed brief fetch"

echo "scenario brief-401: OK"

echo "direct-runner.sh: OK"
