#!/bin/sh
# Publish only after the evaluator exits; a report written before a crash is not success.
set -eu

work="${TMPDIR:-/tmp}/skill-evals"
state="$work/invocation"
result="$state/report/result.json"
mkdir -p "$work"
if mkdir "$state" 2>/dev/null; then
  set -- --root .agents/skills --root agents/shared/skills --evals-root agents/shared/skill-evals --json --out "$work/run" --report "$state/report"
  if [ -f "$work/baseline.json" ]; then
    set -- "$@" --baseline "$work/baseline.json"
  fi
  # Skill lift: every case is also answered without the skill under the same rubric.
  set -- "$@" -- --ablation with-without --max-cost-usd 12 -j 2
  if command -v repo-skill-evals >/dev/null 2>&1; then
    if EVAL_HISTORY_REMOTE=garage:eval-history EVAL_HISTORY_RCLONE_CONFIG="$LCARS_JOB_SECRET_FILES_DIR/garage-rclone" repo-skill-evals "$@" >"$state/output.log" 2>&1; then status=0; else status=$?; fi
  else
    if EVAL_HISTORY_REMOTE=garage:eval-history EVAL_HISTORY_RCLONE_CONFIG="$LCARS_JOB_SECRET_FILES_DIR/garage-rclone" node /opt/repo-tools/bin/skill-evals.mjs "$@" >"$state/output.log" 2>&1; then status=0; else status=$?; fi
  fi
  printf '%s\n' "$status" >"$state/exit"
else
  if [ ! -f "$state/exit" ]; then
    echo 'Evaluator already started; wait for its existing command. An interrupted run must not restart.' >&2
    exit 75
  fi
  status="$(cat "$state/exit")"
  result="$work/report/result.json"
  if [ ! -f "$result" ]; then
    echo 'Original invocation has not published a report; do not restart evaluation.' >&2
    case "$status" in 0|1|2) exit 75 ;; *) exit "$status" ;; esac
  fi
fi

# Keep signals and unexpected command failures visible. Their staged output is diagnostic only.
case "$status" in
  0|1|2) ;;
  *) tail -n 40 "$state/output.log" >&2; exit "$status" ;;
esac
if ! node --input-type=module - "$result" "$status" <<'JS'
import {readFileSync, statSync} from 'node:fs';
const [file, status] = process.argv.slice(2);
const result = JSON.parse(readFileSync(file, 'utf8'));
if (!statSync(file).isFile() || typeof result.report !== 'string' || typeof result.complete !== 'boolean' || !result.data || Array.isArray(result.data) || result.data.exit !== Number(status) || (Number(status) !== 0 && result.complete)) {
  throw new Error('Evaluator did not produce a valid report matching its exit status');
}
JS
then
  tail -n 40 "$state/output.log" >&2
  exit 1
fi
if [ "$result" != "$work/report/result.json" ]; then
  mkdir -p "$work/report"
  if [ -f "$state/report/report.md" ]; then cp "$state/report/report.md" "$work/report/report.md"; fi
  mv "$result" "$work/report/result.json"
fi
printf 'Evaluator exited %s. Exact report saved at %s/report/result.json; evaluation will not run again.\n' "$status" "$work"
