#!/bin/sh
# A graded or partial report is an outcome to publish, never a reason to rerun.
set -eu

work="${TMPDIR:-/tmp}/skill-evals"
state="$work/invocation"
mkdir -p "$work"
if mkdir "$state" 2>/dev/null; then
  set -- --root .agents/skills --root agents/shared/skills --evals-root agents/shared/skill-evals --json --out "$work/run" --report "$work/report"
  if [ -f "$work/baseline.json" ]; then
    set -- "$@" --baseline "$work/baseline.json"
  fi
  set -- "$@" -- --ablation none --max-cost-usd 12 -j 2
  if command -v repo-skill-evals >/dev/null 2>&1; then
    if repo-skill-evals "$@" >"$state/output.log" 2>&1; then status=0; else status=$?; fi
  else
    if node /opt/repo-tools/bin/skill-evals.mjs "$@" >"$state/output.log" 2>&1; then status=0; else status=$?; fi
  fi
  printf '%s\n' "$status" >"$state/exit"
else
  if [ ! -f "$state/exit" ]; then
    echo 'Evaluator already started; wait for its existing command. An interrupted run must not restart.' >&2
    exit 75
  fi
  status="$(cat "$state/exit")"
fi

# Keep signals and unexpected command failures visible, even if a file exists.
case "$status" in
  0|1|2) ;;
  *) tail -n 40 "$state/output.log" >&2; exit "$status" ;;
esac
if ! node --input-type=module - "$work/report/result.json" "$status" <<'JS'
import {readFileSync, statSync} from 'node:fs';
const [file, status] = process.argv.slice(2);
const result = JSON.parse(readFileSync(file, 'utf8'));
if (!statSync(file).isFile() || typeof result.report !== 'string' || typeof result.complete !== 'boolean' || !result.data || Array.isArray(result.data) || result.data.exit !== Number(status) || (Number(status) !== 0 && result.complete)) {
  throw new Error('Evaluator did not produce a valid report matching its exit status');
}
console.log(`Evaluator exited ${status}. Exact report saved at ${file}; evaluation will not run again.`);
JS
then
  tail -n 40 "$state/output.log" >&2
  exit 1
fi
