#!/usr/bin/env bash
# Read a live (or recent) agent run's real state off the fleet, without
# waiting for GitHub to publish anything.
#
#   run-evidence.sh [issue-number]
#
# With no argument it reports every agent runner container it can find. With
# an issue number it reports only containers whose workspace is working that
# issue, when that is determinable.
#
# Read-only: it runs `git` queries and `docker ps/exec`, never mutates a
# workspace or touches a container's lifecycle.

set -uo pipefail

ISSUE="${1:-}"
BASTION="${DEBUG_RUN_BASTION:-homelab@homelab.lan.jlapenna.net}"
FLEET_KEY="${DEBUG_RUN_FLEET_KEY:-\$HOME/p/homelab/ansible/ssh_key/id_ed25519}"
HOSTS="${DEBUG_RUN_HOSTS:-laforge janeway spark pike oldbook}"
LOKI="${DEBUG_RUN_LOKI:-http://localhost:3100}"

# The inner script runs three hops away (here -> bastion -> fleet host ->
# container). Quoting survives exactly one of those, so everything below is
# base64'd and decoded at the far end. See SKILL.md §1.
probe=$(cat <<'PROBE'
set -uo pipefail
for host in __HOSTS__; do
  names=$(timeout 12 ssh -n -o BatchMode=yes -o ConnectTimeout=6 \
    -i __FLEET_KEY__ "homelab@${host}.lan.jlapenna.net" \
    'docker ps --filter name=runner- --format "{{.Names}}|{{.CreatedAt}}"' 2>/dev/null) || continue
  [ -n "$names" ] || continue
  while IFS='|' read -r name created; do
    case "$name" in *agent*) ;; *) continue ;; esac
    inner='
      for dir in /home/runner/_work/*/*/; do
        [ -d "$dir/.git" ] || continue
        cd "$dir" || continue
        commits=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
        dirty=$(git status --porcelain 2>/dev/null | wc -l)
        branch=$(git branch --show-current 2>/dev/null)
        extra=0
        for wt in $(git worktree list --porcelain 2>/dev/null | sed -n "s/^worktree //p"); do
          [ "$wt" = "${dir%/}" ] && continue
          extra=$((extra + $(git -C "$wt" status --porcelain 2>/dev/null | wc -l)))
        done
        echo "    workspace=$(basename "$dir") branch=$branch commits=$commits dirty=$dirty dirty_in_worktrees=$extra"
        for wt in $(git worktree list --porcelain 2>/dev/null | sed -n "s/^worktree //p"); do
          [ "$wt" = "${dir%/}" ] && continue
          echo "    worktree=$(basename "$wt") dirty=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l)"
        done
        break
      done'
    state=$(timeout 20 ssh -n -o BatchMode=yes -o ConnectTimeout=6 \
      -i __FLEET_KEY__ "homelab@${host}.lan.jlapenna.net" \
      "docker exec $name bash -lc '$inner'" 2>/dev/null)
    echo "  [$host] $name  created=$created"
    [ -n "$state" ] && echo "$state" || echo "    (no checkout readable)"
  done <<< "$names"
done

echo
echo "  --- LiteLLM completions per 5 min (agent pulse; ~1.5/min = one healthy agent) ---"
end=$(date -u +%s)000000000
start=$(date -u -d '35 min ago' +%s)000000000
curl -sG "__LOKI__/loki/api/v1/query_range" \
  --data-urlencode 'query=sum(count_over_time({container="litellm"} |= "chat/completions" [5m]))' \
  --data-urlencode "start=$start" --data-urlencode "end=$end" \
  --data-urlencode "step=300" 2>/dev/null |
  python3 -c '
import json,sys,datetime
try: d=json.load(sys.stdin)
except Exception: print("    (loki query failed)"); raise SystemExit
rows=[(t,v) for s in d.get("data",{}).get("result",[]) for t,v in s["values"]]
if not rows: print("    (no data)")
for t,v in rows:
    print("   ", datetime.datetime.fromtimestamp(float(t),datetime.UTC).strftime("%H:%M"), v)
' 2>/dev/null

echo
echo "  --- capacity/throttle errors in the same window ---"
for q in capacity 503 ServiceUnavailable 429; do
  n=$(curl -sG "__LOKI__/loki/api/v1/query_range" \
    --data-urlencode "query={container=\"litellm\"} |= \"$q\"" \
    --data-urlencode "start=$start" --data-urlencode "end=$end" \
    --data-urlencode "limit=200" 2>/dev/null |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(len(s["values"]) for s in d.get("data",{}).get("result",[])))' 2>/dev/null)
  printf "    %-20s %s\n" "$q:" "${n:-?}"
done
echo "    (a flat all-day rate is background noise, not your run - SKILL.md §3)"
PROBE
)

probe="${probe//__HOSTS__/$HOSTS}"
probe="${probe//__FLEET_KEY__/$FLEET_KEY}"
probe="${probe//__LOKI__/$LOKI}"

echo "agent run evidence @ $(date -u +%H:%M:%SZ)${ISSUE:+  (issue #$ISSUE)}"
echo

encoded=$(printf '%s' "$probe" | base64 -w0)
if ! timeout 180 ssh -o BatchMode=yes -o ConnectTimeout=10 "$BASTION" \
  "echo $encoded | base64 -d | bash"; then
  echo "could not reach the bastion ($BASTION); see SKILL.md §1" >&2
  exit 1
fi

cat <<'HINT'

  Reading it (SKILL.md §2):
    commits=0 dirty=0   still in reconnaissance - check the pulse before calling it stuck
    commits=0 dirty>0   work exists and dies with the runner - this is the urgent one
    commits>0           it is checkpointing; the work will survive
HINT
