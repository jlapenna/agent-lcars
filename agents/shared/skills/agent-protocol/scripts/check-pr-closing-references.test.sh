#!/usr/bin/env bash
# Execute the published Ready/Arm procedures against the actual scope checker.
# GitHub reads and mutations are owned fixtures; no real PR is accessed.
set -euo pipefail
protocol_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$protocol_root/../../../.." && pwd)"
export AGENT_PROTOCOL_PATH="$protocol_root/reference/agent-protocol.md"
command -v jq >/dev/null || { echo "jq is required (normal runner-image toolchain)" >&2; exit 1; }
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
export pr_number=2324 reviewed_head
reviewed_head=$(printf 'a%.0s' {1..40})
export FAKE_RESPONSE="$temp_dir/response.json"
export MUTATION_WITNESS="$temp_dir/mutation" READBACK_WITNESS="$temp_dir/readback"
export FAKE_GH_CALLS="$temp_dir/read"
mkdir "$temp_dir/bin"
cat > "$temp_dir/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'api graphql')
    if [[ "$*" != *enablePullRequestAutoMerge* ]]; then
      [[ "$*" != *autoMergeRequest* ]] || printf ran > "$READBACK_WITNESS"
      printf read > "$FAKE_GH_CALLS"
      cat "$FAKE_RESPONSE"
      exit
    fi ;;
  'pr view')
    [[ "$*" != *'--json state,'* ]] || printf ran > "$READBACK_WITNESS"
    filter=''
    while (($#)); do
      case "$1" in
        --jq) filter=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    readback=$(jq -cn --arg head "$FAKE_READBACK_HEAD" \
      '{id:"OWNED_PR_NODE",state:"OPEN",isDraft:false,headRefOid:$head,autoMergeRequest:{mergeMethod:"SQUASH"}}')
    if [[ -n "$filter" ]]; then
      jq -er "$filter" <<<"$readback"
    else
      printf '%s\n' "$readback"
    fi
    exit ;;
  'pr ready') printf ran > "$MUTATION_WITNESS"; exit ;;
  'pr merge')
    expected='' auto=false squash=false
    shift 2
    while (($#)); do
      case "$1" in
        --auto) auto=true; shift ;;
        --squash) squash=true; shift ;;
        --match-head-commit) expected=$2; shift 2 ;;
        --admin) echo 'Administrative bypass is not protected arming' >&2; exit 64 ;;
        *) shift ;;
      esac
    done
    if [[ "$auto" != true || "$squash" != true || -z "$expected" ]]; then
      echo 'CLI arming requires auto, squash and the supplied expected head' >&2
      exit 64
    fi
    if [[ "$expected" != "$FAKE_MUTATION_HEAD" ]]; then
      echo 'Head changed at the arming boundary' >&2
      exit 1
    fi
    printf ran > "$MUTATION_WITNESS"
    exit ;;
  *) exit 64 ;;
esac
# Model only the public arming API's expected-head precondition. This is a
# harmless sink, not a replacement checker or a production gh invocation.
expected='' query='' mutation_id=''
while (($#)); do
  case "$1" in
    -f|-F) case "$2" in head=*) expected=${2#head=} ;; query=*) query=${2#query=} ;; id=*) mutation_id=${2#id=} ;; esac; shift 2 ;;
    *) shift ;;
  esac
done
head_binding='expectedHeadOid:[[:space:]]*\$head'
squash_method='mergeMethod:[[:space:]]*SQUASH'
if [[ -z "$expected" || "$mutation_id" != OWNED_PR_NODE ||
      ! "$query" =~ $head_binding || ! "$query" =~ $squash_method ]]; then
  echo 'Queue arming requires the supplied expected head and SQUASH' >&2
  exit 64
fi
if [[ "$expected" != "$FAKE_MUTATION_HEAD" ]]; then
  echo 'Head changed at the arming boundary' >&2
  exit 1
fi
printf ran > "$MUTATION_WITNESS"
GH
chmod +x "$temp_dir/bin/gh"
export PATH="$temp_dir/bin:$PATH"

published_block() {
  # Substitute fixture values only. Preserve the published control flow.
  node --input-type=module - "$1" "$2" "$3" "$reviewed_head" <<'NODE'
import {readFileSync} from 'node:fs';
const [doc, action, declared, head] = process.argv.slice(2);
const text = readFileSync(doc, 'utf8');
const blocks = [...text.matchAll(/^[ \t]*```bash\r?\n([\s\S]*?)^[ \t]*```/gm)].map(m => m[1]);
const candidates = blocks.filter(b => action === 'ready' ? b.includes('gh pr ready') :
  b.includes('gh pr merge') || b.includes('enablePullRequestAutoMerge'));
if(candidates.length !== 1) throw Error(`Expected one published ${action} procedure: ${doc}`);
let block=candidates[0];
for(const [key,value] of Object.entries({
  '<owner/repo>':'jlapenna/agent-lcars','<PR>':'2324','<N>':'2324',
  '<PR_NUMBER>':'2324','<exact-reviewed-pushed-head>':head,
  '<EXACT_REVIEWED_AND_PUSHED_SHA>':head,'<declared-scope>':declared,
})) block=block.replaceAll(key,value);
if(action === 'ready') block=block.replace(/\bnone\b/g,declared);
process.stdout.write(block);
NODE
}

run_published() {
  local document=$1 action=$2 declared=$3 response_head=$4 closing=$5 mutation_head=$6
  export FAKE_MUTATION_HEAD="$mutation_head" FAKE_READBACK_HEAD="${7:-$reviewed_head}"
  rm -f "$MUTATION_WITNESS" "$READBACK_WITNESS" "$FAKE_GH_CALLS"
  local nodes='[]'
  [[ "$closing" = 0 ]] || nodes='[{"number":2407,"repository":{"nameWithOwner":"jlapenna/agent-lcars"}}]'
  printf '{"data":{"repository":{"pullRequest":{"state":"OPEN","isDraft":false,"headRefOid":"%s","closingIssuesReferences":{"nodes":%s,"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}' "$response_head" "$nodes" > "$FAKE_RESPONSE"
  local block status=0
  block=$(published_block "$document" "$action" "$declared")
  # No ambient errexit: a document's separate successful final command must
  # retain its actual masking behavior. The document can set its own options.
  CHAINED_OUT=$(cd "$repo_root" && env -u BASH_ENV bash +e -c "$block" 2>&1) || status=$?
  CHAINED_STATUS=$status
}

failures=0
check() {
  local description=$1; shift
  if "$@"; then echo "ok: $description"; else
    echo "FAILED: $description" >&2; failures=$((failures+1))
  fi
}
mutation_absent() { [[ ! -e "$MUTATION_WITNESS" ]]; }
mutation_present() { [[ -e "$MUTATION_WITNESS" ]]; }
readback_absent() { [[ ! -e "$READBACK_WITNESS" ]]; }
readback_present() { [[ -e "$READBACK_WITNESS" ]]; }
checker_read() { [[ -e "$FAKE_GH_CALLS" ]]; }

for document in "$AGENT_PROTOCOL_PATH" "$repo_root/.agents/skills/agent-lcars-dev/references/pr.md"; do
  for action in ready arm; do
    echo "published procedure: $document $action"
    run_published "$document" "$action" none "$reviewed_head" 2407 "$reviewed_head"
    check 'wrong scope: actual procedure exits nonzero' test "$CHAINED_STATUS" -ne 0
    check 'wrong scope: actual checker rejects unintended reference' grep -q 'Closing scope mismatch: unintended' <<<"$CHAINED_OUT"
    check 'wrong scope: actual checker read GitHub fixture' checker_read
    check 'wrong scope: mutation skipped' mutation_absent
    check 'wrong scope: dependent already-armed readback skipped' readback_absent
    run_published "$document" "$action" none b 0 "$reviewed_head"
    check 'changed head: actual procedure exits nonzero' test "$CHAINED_STATUS" -ne 0
    check 'changed head: actual checker rejects expected head' grep -q 'expected head' <<<"$CHAINED_OUT"
    check 'changed head: mutation skipped' mutation_absent
    check 'changed head: dependent readback skipped' readback_absent
    run_published "$document" "$action" none "$reviewed_head" 0 "$reviewed_head"
    check 'valid scope: actual procedure exits zero' test "$CHAINED_STATUS" -eq 0
    check 'valid scope: published mutation reached owned sink' mutation_present
    if [[ "$action" = arm ]]; then
      run_published "$document" "$action" jlapenna/agent-lcars#2407 "$reviewed_head" 2407 "$reviewed_head"
      check 'intentional closure: accepted scope reaches arming' test "$CHAINED_STATUS" -eq 0
      check 'intentional closure: mutation reached owned sink' mutation_present
      check 'valid scope: published final readback reached owned sink' readback_present
      run_published "$document" "$action" none "$reviewed_head" 0 b
      check 'concurrent push: arming precondition rejects new head' test "$CHAINED_STATUS" -ne 0
      check 'concurrent push: no mutation' mutation_absent
      check 'concurrent push: no dependent readback' readback_absent
      if [[ "$document" = "$AGENT_PROTOCOL_PATH" ]]; then
        run_published "$document" "$action" none "$reviewed_head" 0 "$reviewed_head" b
        check 'wrong readback: published predicate exits nonzero' test "$CHAINED_STATUS" -ne 0
        check 'wrong readback: arming mutation already occurred' mutation_present
        check 'wrong readback: final readback actually evaluated' readback_present
      fi
    fi
  done
done
if ((failures)); then echo "closing-scope gate contract test: $failures failure(s)" >&2; exit 1; fi
echo 'ok: the published closing-scope guard blocks a chained next step; actual shared and interactive Ready/Arm procedures qualify'
