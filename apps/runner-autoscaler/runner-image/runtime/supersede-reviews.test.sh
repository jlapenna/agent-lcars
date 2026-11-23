#!/usr/bin/env bash
# supersede_prior_reviews: a verified pass of the current head dismisses only
# the same reviewer's earlier requested-changes reviews.
set -euo pipefail
runtime_dir=$(cd "$(dirname "$0")" && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir "$fixture_dir/bin"
cat > "$fixture_dir/bin/gh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'--method PUT'*'/dismissals'*) printf '%s\n' "$*" | grep -o 'reviews/[0-9]*' >> "$FIXTURE_DIR/dismissed" ;;
  *'reviews?per_page=100'*) cat "$FIXTURE_DIR/reviews.json" ;;
  *'pulls/42 --jq .head.sha') echo head-sha ;;
  *) echo "unexpected gh $*" >&2; exit 13 ;;
esac
FAKE
chmod +x "$fixture_dir/bin/gh"
export PATH="$fixture_dir/bin:$PATH" FIXTURE_DIR="$fixture_dir"
# shellcheck source=worker-completion.sh
source "$runtime_dir/worker-completion.sh"
fail() { echo "supersede-reviews: $*" >&2; exit 1; }
bot='{"login":"agent-lcars[bot]"}'
run() { : > "$fixture_dir/dismissed"; supersede_prior_reviews octo/example 42 "$1" > /dev/null; }
reviews() { jq -cn --argjson bot "$bot" "[[$1]]" > "$fixture_dir/reviews.json"; }

# Same-commit rereview: the pass dismisses the bot's older block, not a human's.
reviews '{id:1,user:$bot,state:"CHANGES_REQUESTED",commit_id:"head-sha"},
  {id:2,user:{login:"maintainer"},state:"CHANGES_REQUESTED",commit_id:"head-sha"},
  {id:3,user:$bot,state:"COMMENTED",commit_id:"head-sha",body:"ok\n<!-- lcars-review:pass -->\n",html_url:"u"}'
run 3
[ "$(cat "$fixture_dir/dismissed")" = 'reviews/1' ] || fail "same-commit pass: $(cat "$fixture_dir/dismissed")"

# An approval of the head dismisses a block left on an older commit.
reviews '{id:1,user:$bot,state:"CHANGES_REQUESTED",commit_id:"old"},{id:4,user:$bot,state:"APPROVED",commit_id:"head-sha",html_url:"u"}'
run 4
[ "$(cat "$fixture_dir/dismissed")" = 'reviews/1' ] || fail "approval did not dismiss"

# A blocking comment, a pass of a stale commit, and a newer block are left alone.
reviews '{id:1,user:$bot,state:"CHANGES_REQUESTED",commit_id:"old"},
  {id:5,user:$bot,state:"COMMENTED",commit_id:"head-sha",body:"<!-- lcars-review:block -->"},
  {id:6,user:$bot,state:"COMMENTED",commit_id:"old",body:"<!-- lcars-review:pass -->"},
  {id:7,user:$bot,state:"CHANGES_REQUESTED",commit_id:"head-sha"}'
for id in 5 6; do run "$id"; [ ! -s "$fixture_dir/dismissed" ] || fail "review $id dismissed something"; done
reviews '{id:3,user:$bot,state:"COMMENTED",commit_id:"head-sha",body:"<!-- lcars-review:pass -->"},{id:7,user:$bot,state:"CHANGES_REQUESTED",commit_id:"head-sha"}'
run 3; [ ! -s "$fixture_dir/dismissed" ] || fail "dismissed a newer block"
echo "supersede-reviews: OK"
