#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
export AUTH_TEST_DIR="$scratch"
cat > "$scratch/bin/curl" <<'FAKE'
#!/usr/bin/env bash
cat > "$AUTH_TEST_DIR/request"
[ "${REFUSE_TOKEN:-0}" = 0 ] || exit 22
printf '{"token":"fresh-token"}\n'
FAKE
cat > "$scratch/bin/command" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$GH_TOKEN" > "$AUTH_TEST_DIR/token"
printf '%s\n' "$@" > "$AUTH_TEST_DIR/argv"
if [ -n "${GIT_CONFIG_COUNT:-}" ]; then
  printf '%s\n' "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" "$GIT_CONFIG_KEY_1" "$GIT_CONFIG_VALUE_1" > "$AUTH_TEST_DIR/git-config"
fi
FAKE
chmod +x "$scratch/bin/"*
ln -s "$here/runtime/run-github-command.sh" "$scratch/bin/gh"
ln -s "$here/runtime/run-github-command.sh" "$scratch/bin/git"
export PATH="$scratch/bin:$PATH" GH_TOKEN=expired-token
export LCARS_REAL_GH="$scratch/bin/command" LCARS_REAL_GIT="$scratch/bin/command"
export LCARS_CONSOLE_URL=https://lcars.test LCARS_RUN_ID='octo/repo#1/r2' LCARS_RUN_TOKEN=run-sentinel

gh api repos/octo/repo
[ "$(cat "$scratch/token")" = fresh-token ]
grep -q 'octo%2Frepo%231%2Fr2/checkout-token' "$scratch/request"
if grep -q 'fresh-token\|expired-token\|run-sentinel' "$scratch/argv"; then exit 1; fi
git push origin branch
[ "$(cat "$scratch/token")" = fresh-token ]
grep -q 'AUTHORIZATION: basic' "$scratch/git-config"
[ "$(head -n1 "$scratch/git-config")" = 2 ]
if grep -q 'fresh-token\|expired-token\|run-sentinel\|AUTHORIZATION' "$scratch/argv"; then exit 1; fi

rm "$scratch/token" "$scratch/request"
export REFUSE_TOKEN=1
if gh api repos/octo/repo 2>/dev/null; then echo 'refresh refusal succeeded' >&2; exit 1; fi
[ ! -e "$scratch/token" ]
rm "$scratch/request"
git status
[ ! -e "$scratch/request" ]
[ "$(cat "$scratch/token")" = expired-token ]
echo 'run-github-command: OK'
