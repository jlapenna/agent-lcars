#!/usr/bin/env bash
# Fail if a shell script under tools/, .github/, or apps/ contains a bare
# `return` after `||`. `[[ cond ]] || return` returns the FAILED test's own
# exit status, not a deliberate one -- under `set -e` (used throughout this
# repo's shell scripts) that silently kills the function, and its caller,
# right there, with no message. jlapenna/homelab#1074 was exactly this
# shape in bin/publish-agent-lcars-images.sh's
# validate_base_mirror_contract: it silently killed merge-to-live's image
# publisher for hours. See jlapenna/homelab#1087.
#
# Scans every git-tracked *.sh file under tools/, .github/, and apps/, plus
# any tracked file in those trees whose first line is a bash shebang (e.g.
# tools/nx). A line ending in `|| return`, optionally followed by trailing
# whitespace and/or a trailing `#` comment, fails -- unless it carries a
# trailing `# bare-return-ok` annotation for a deliberate, reviewed
# exception. A whole-line comment (the line's first non-blank character is
# `#`) is skipped: it is prose about the pattern, not the pattern itself.
#
# Usage: ./tools/check-shell-bare-return.sh [FILE...]
#   With no arguments, scans the whole tools/, .github/, apps/ tree above.
#   Given explicit paths, scans only those -- used by
#   tools/check-shell-bare-return.test.sh so fixtures never have to live
#   under a real git checkout.
set -euo pipefail

# A file counts as a shell script if it is named *.sh, or its first line is
# a bash shebang (`#!/bin/bash`, `#!/usr/bin/env bash`, etc.). The `grep -I`
# binary guard runs before any `head`/command-substitution read: apps/ and
# .github/ carry real binary fixtures (favicon.ico, .woff2 fonts), and
# capturing binary content through `$(...)` makes bash print a spurious
# "ignored null byte" warning even though the read result is discarded.
is_bash_script() {
  local f=$1
  case "$f" in
    *.sh) return 0 ;;
  esac
  grep -qI '' "$f" 2>/dev/null || return 1
  local first_line
  first_line=$(head -n1 "$f" 2>/dev/null || true)
  [[ "$first_line" == '#!'*bash* ]]
}

if (($# > 0)); then
  files=("$@")
else
  cd "$(git rev-parse --show-toplevel)"
  mapfile -t tracked < <(git ls-files 'tools/*' '.github/*' 'apps/*')
  files=()
  for f in "${tracked[@]}"; do
    [[ -f "$f" ]] || continue
    is_bash_script "$f" && files+=("$f")
  done
fi

# Matches a line ending in `|| return`, allowing trailing whitespace and/or
# a trailing `# ...` comment before end-of-line. `|| return 0`, `|| return
# 1`, `|| return "$rc"`, etc. all have a non-whitespace, non-`#` token right
# after `return`, so none of them match.
readonly BARE_RETURN_RE='\|\|[[:space:]]*return[[:space:]]*(#.*)?$'

fail=0
for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  hits=$(grep -nE "$BARE_RETURN_RE" "$f" 2>/dev/null |
    grep -vE '^[0-9]+:[[:space:]]*#' |
    grep -v 'bare-return-ok' || true)
  [[ -n "$hits" ]] || continue
  fail=1
  while IFS= read -r hit; do
    lineno="${hit%%:*}"
    echo "${f}:${lineno}: bare \`return\` after \`||\` under set -e" >&2
  done <<<"$hits"
done

if ((fail)); then
  cat >&2 <<'EOF'

Bare `return` after `||` propagates the FAILED test's own exit status, so a
function running under `set -e` -- and its caller -- dies right there,
silently (jlapenna/homelab#1074). Use `|| return 0` (or another explicit
code) so the exit status is a decision, not an accident.

If a bare `return` here is genuinely intentional (the caller must observe
the test's own failure status), annotate the line with a trailing
`# bare-return-ok: <reason>` comment.
EOF
  exit 1
fi
echo "ok: no bare \`return\` after \`||\` in tools/, .github/, or apps/ shell scripts"
