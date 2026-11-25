import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// Runs reconcile-automerge's real arm script against a fake `gh` to pin who
// the App arms: agent-authored PRs, and any other same-repository PR once it
// is approved (jlapenna/homelab#3800 sat approved and unarmed because it was
// opened under the maintainer's login).

interface Step {
  name?: string;
  run?: string;
}

const workflow = parseYaml(
  readFileSync('.github/workflows/agent-automerge-reusable.yml', 'utf8'),
) as { jobs: Record<string, { steps?: Step[] }> };
const armScript = workflow.jobs['reconcile-automerge'].steps?.find((step) =>
  step.name?.startsWith('Arm ready open agent PRs'),
)?.run;
if (armScript === undefined) throw new Error('arm step not found');

// Answers exactly the gh calls the arm step makes, from fixtures in $STATE.
const FAKE_GH = String.raw`#!/usr/bin/env bash
set -euo pipefail
args="$*"
jq_prog=""
prev=""
for a in "$@"; do
  if [ "$prev" = --jq ]; then jq_prog="$a"; fi
  prev="$a"
done
case "$args" in
  "api --paginate repos/o/r/pulls?"*)
    jq -r "$jq_prog" "$STATE/pulls.json" ;;
  "pr merge "*)
    pr="$3"; echo "$pr" >>"$STATE/armed" ;;
  "pr view "*"--json reviewDecision"*)
    jq -r --arg pr "$3" '.[$pr] // ""' "$STATE/decisions.json" ;;
  "pr view "*"--json state,autoMergeRequest"*)
    if grep -qx "$3" "$STATE/armed" 2>/dev/null; then
      out='{"state":"OPEN","autoMergeRequest":{"enabledBy":{"login":"app/agent-lcars"}}}'
    else
      out='{"state":"OPEN","autoMergeRequest":null}'
    fi
    if [ -n "$jq_prog" ]; then jq -e "$jq_prog" <<<"$out"; else echo "$out"; fi ;;
  "api repos/o/r/pulls/"*"/requested_reviewers"*)
    pr="$(sed -E 's#.*/pulls/([0-9]+)/.*#\1#' <<<"$2")"
    echo "$pr" >>"$STATE/cleared"
    out='{"users":[],"teams":[]}'
    if [ -n "$jq_prog" ]; then jq -e "$jq_prog" <<<"$out" >/dev/null; else echo "$out"; fi ;;
  *) echo "unexpected gh call: $args" >&2; exit 99 ;;
esac
`;

const pull = (
  number: number,
  login: string,
  { draft = false, parked = false, fork = false } = {},
) => ({
  number,
  user: { login },
  draft,
  labels: parked ? [{ name: 'status:needs-human' }] : [],
  head: { repo: { full_name: fork ? 'someone/r' : 'o/r' } },
  base: { repo: { full_name: 'o/r' } },
});

function runArm(pulls: unknown[], decisions: Record<string, string>) {
  const state = mkdtempSync(path.join(tmpdir(), 'automerge-arm-'));
  const bin = path.join(state, 'bin');
  spawnSync('mkdir', [bin]);
  writeFileSync(path.join(bin, 'gh'), FAKE_GH);
  chmodSync(path.join(bin, 'gh'), 0o755);
  writeFileSync(path.join(state, 'pulls.json'), JSON.stringify(pulls));
  writeFileSync(path.join(state, 'decisions.json'), JSON.stringify(decisions));
  const result = spawnSync('bash', ['-e', '-c', armScript ?? ''], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STATE: state,
      RUNNER_TEMP: state,
      REPO: 'o/r',
      APP_LOGIN: 'app/agent-lcars',
      AGENT_BOT_LOGINS: '["claude[bot]","agent-lcars[bot]"]',
    },
    encoding: 'utf8',
  });
  const lines = (file: string) => {
    try {
      return readFileSync(path.join(state, file), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return { result, armed: lines('armed'), cleared: lines('cleared') };
}

describe('reconcile-automerge arm admission', () => {
  it('arms agent PRs and approved same-repository PRs, nothing else', () => {
    const { result, armed, cleared } = runArm(
      [
        pull(1, 'claude[bot]'),
        pull(2, 'jlapenna'), // approved: homelab#3800's shape
        pull(3, 'jlapenna'), // review required
        pull(4, 'jlapenna', { fork: true }),
        pull(5, 'renovate[bot]'),
        pull(6, 'jlapenna', { draft: true }),
        pull(7, 'jlapenna', { parked: true }),
        pull(8, 'jlapenna'), // changes requested
      ],
      {
        '2': 'APPROVED',
        '3': 'REVIEW_REQUIRED',
        '4': 'APPROVED',
        '5': 'APPROVED',
        '6': 'APPROVED',
        '7': 'APPROVED',
        '8': 'CHANGES_REQUESTED',
      },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(armed).toEqual(['1', '2']);
    // Review requests are an agent-PR concern; a human PR's stay untouched.
    expect(new Set(cleared)).toEqual(new Set(['1']));
    expect(result.stdout).toContain(
      'Reconciliation checked=2 armed=2 failed=0',
    );
  });
});
