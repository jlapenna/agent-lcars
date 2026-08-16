#!/usr/bin/env bash
set -euo pipefail
action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT

src="$root/src"; dest="$root/dest"
mkdir -p "$src/agent-protocol" "$src/lcars-session-updates" "$src/agent-lcars-dev"
echo "protocol" > "$src/agent-protocol/SKILL.md"
echo "updates"  > "$src/lcars-session-updates/SKILL.md"
echo "devonly"  > "$src/agent-lcars-dev/SKILL.md"

digest="$(bash "$action_dir/install-skills.sh" "$src" "$dest")"

test -f "$dest/agent-protocol/SKILL.md"        || { echo "FAIL: agent-protocol not installed"; exit 1; }
test -f "$dest/lcars-session-updates/SKILL.md" || { echo "FAIL: lcars-session-updates not installed"; exit 1; }
test ! -e "$dest/agent-lcars-dev"              || { echo "FAIL: layer 3 leaked into the install"; exit 1; }
test -n "$digest"                              || { echo "FAIL: no digest printed"; exit 1; }
echo "install-skills.test.sh: case 1 ok (installs layer 1 only)"

# missing source skill: warns, still exits 0, installs the others
mkdir -p "$root/src2/agent-protocol"; echo x > "$root/src2/agent-protocol/SKILL.md"
if ! bash "$action_dir/install-skills.sh" "$root/src2" "$root/dest2" >/dev/null 2>&1; then
  echo "FAIL: non-zero exit when a listed skill is absent"; exit 1
fi
test -f "$root/dest2/agent-protocol/SKILL.md" || { echo "FAIL: sibling not installed"; exit 1; }
echo "install-skills.test.sh: case 2 ok (absent skill fails soft)"

# rerun is idempotent and yields a stable digest
d1="$(bash "$action_dir/install-skills.sh" "$src" "$root/dest3")"
d2="$(bash "$action_dir/install-skills.sh" "$src" "$root/dest3")"
test "$d1" = "$d2" || { echo "FAIL: digest not stable across reruns"; exit 1; }
echo "install-skills.test.sh: case 3 ok (idempotent, stable digest)"

# Case 3 is narrower than its name suggests, and this is worth stating so
# nobody later reads it as protecting the digest invariant. A digest computed
# purely from layer1-skills.conf is perfectly deterministic, so it sails
# through "stable across reruns" while recording nothing about what was
# actually installed. Verified against two mutants -- a source-list hash, and
# a walk of only the just-installed subdirectories -- and BOTH passed case 3.
# Case 4 below is the one that caught them. Keep case 3 for what it does test
# (reruns do not churn), but do not weaken case 4 on the theory that case 3
# already covers it.

# a stale skill removed from the list is not left behind on reinstall
mkdir -p "$root/dest3/stale"; echo old > "$root/dest3/stale/SKILL.md"
d3="$(bash "$action_dir/install-skills.sh" "$src" "$root/dest3")"
test "$d3" != "$d1" || { echo "FAIL: digest ignored unmanaged content"; exit 1; }
echo "install-skills.test.sh: case 4 ok (digest reflects real directory state)"
