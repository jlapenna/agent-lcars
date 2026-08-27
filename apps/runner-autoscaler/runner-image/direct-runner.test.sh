#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
# Exported: the fake curl/git/gh/claude binaries below run as separate
# processes (found via PATH, not sourced), so they only see `tmp` if it is
# actually in their environment -- an unexported `tmp` would leave every
# `$tmp/...` reference inside those heredocs resolving to an empty prefix
# (e.g. `/complete-calls.log`, which then fails to write for lack of
# permission on `/`) once direct-runner.sh execs them for real.
tmp="$(mktemp -d)"
export tmp
trap 'rm -rf "$tmp"' EXIT

# --- fake curl: serves the console endpoints direct-runner.sh calls,
# routed by the URL's trailing path segment(s). Real curl flags (-s, -H,
# -X, -d) are accepted and ignored beyond finding the URL argument. The
# run id direct-runner.sh embeds in every URL is percent-encoded (its own
# `%2F` for the id's embedded `/`), so matching on the trailing segment
# alone -- not the whole path -- is what keeps this fixture agnostic to
# that encoding.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url=""
for arg in "$@"; do
  case "$arg" in
    http*) url="$arg" ;;
  esac
done
case "$url" in
  */brief)
    cat <<'JSON'
{"id":"01DIRECTRUNNERTESTFIXTURE1","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"octo/example"}},"anchor":{"type":"work","id":"01DIRECTRUNNERTESTFIXTURE1","title":"t","body":"d","target_repo":"octo/example","html_url":"https://lcars.test/work/01DIRECTRUNNERTESTFIXTURE1"},"attemptId":"g1:work:01DIRECTRUNNERTESTFIXTURE1/r1","generation":1,"intentId":"work:01DIRECTRUNNERTESTFIXTURE1/r1"}
JSON
    ;;
  */checkout-token)
    echo '{"token":"fake-checkout-token","expiresAt":"2026-08-27T01:00:00.000Z"}'
    ;;
  */heartbeat)
    echo '{"runId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","expiresAt":"2026-08-27T01:00:00.000Z"}'
    ;;
  */complete)
    echo "$@" >> "$tmp/complete-calls.log"
    echo '{"runId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","state":"finished"}'
    ;;
  *)
    echo "fake curl: unhandled URL $url" >&2
    exit 1
    ;;
esac
FAKE
chmod +x "$tmp/bin/curl"

# --- fake git: direct-runner.sh's `git clone`/`git config --local` calls
# must never touch the network or a real GitHub credential ("no real git
# in unit tests" -- house rule). `clone`'s last argument is the target
# directory; creating it (with a `.git` marker so the "already cloned"
# guard is exercised too) is all the rest of the script needs from it.
cat > "$tmp/bin/git" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  clone)
    target="${@: -1}"
    mkdir -p "$target/.git"
    ;;
  *)
    exit 0
    ;;
esac
FAKE
chmod +x "$tmp/bin/git"

# --- fake gh: verify-deliverable.sh's PR-marker lookup and
# direct-runner.sh's own outcome-derivation both shell out to gh; a
# bot-authored PR carrying the attempt-claim marker is what both need to
# find.
cat > "$tmp/bin/gh" <<'FAKE'
#!/usr/bin/env bash
if [[ "$*" == *"pulls?state=all"* ]]; then
  echo '12'
  exit 0
fi
echo '[]'
FAKE
chmod +x "$tmp/bin/gh"

# --- fake claude: a headless run that "opens" the marked PR (nothing to
# actually push in this fixture -- verify-deliverable.sh's fake gh above
# is what proves the marker, not a real git state). Ignores every flag,
# including the real --dangerously-skip-permissions/--allowedTools/
# --disallowedTools direct-runner.sh passes.
cat > "$tmp/bin/claude" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
chmod +x "$tmp/bin/claude"

export PATH="$tmp/bin:$PATH"
export LCARS_RUN_ID="work:01DIRECTRUNNERTESTFIXTURE1/r1"
export LCARS_RUN_TOKEN="test-token"
export LCARS_CONSOLE_URL="https://lcars.test"
export RUNNER_TEMP="$tmp/runner-temp"
export HOME="$tmp/home"
mkdir -p "$RUNNER_TEMP" "$HOME"

# Bounds the background heartbeat loop's orphaned-sleep lifetime to
# ~1 second instead of the production 300s default: the fake `claude`
# above returns near-instantly, so direct-runner.sh kills (without
# waiting on) the loop well before its first tick in either case, but a
# short interval keeps a not-yet-reaped `sleep` process from lingering
# past this test's own exit.
export HEARTBEAT_INTERVAL_SECONDS=1

# Every baked-tool path is env-overridable (see direct-runner.sh); point
# them at this repo's own checked-in scripts so this test exercises the
# REAL prepare.sh/verify-deliverable.sh/sidecar-lifecycle.sh, not a hedge
# that quietly no-ops when the baked image path is absent. `TARGET_REPO`
# in the fake brief above is `octo/example`, not `jlapenna/agent-lcars`,
# so prepare.sh's own `assert-consumer-boundaries.sh` call takes its
# "any other repository" branch and returns immediately.
export PREPARE_DISPATCH_DIR="$repo_root/.github/actions/prepare-agent-dispatch"
export VERIFY_DELIVERABLE="$repo_root/.github/actions/verify-deliverable/verify-deliverable.sh"
export SIDECAR_LIFECYCLE="$repo_root/apps/telemetry-watcher/bin/sidecar-lifecycle.sh"

bash "$here/direct-runner.sh"

if [ ! -f "$tmp/complete-calls.log" ]; then
  echo "direct-runner.sh never called POST .../complete" >&2
  exit 1
fi
if ! grep -q '"outcome":"pull-request"' "$tmp/complete-calls.log"; then
  echo "complete call did not report outcome: pull-request" >&2
  cat "$tmp/complete-calls.log" >&2
  exit 1
fi

echo "direct-runner.sh: OK"
