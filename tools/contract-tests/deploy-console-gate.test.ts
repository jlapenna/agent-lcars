import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  id?: string;
  run?: string;
}
const workflow = parse(
  readFileSync('.github/workflows/deploy-console.yml', 'utf8'),
) as { jobs: { gate: { steps: Step[] } } };
const script = workflow.jobs.gate.steps.find((step) => step.id === 'check')
  ?.run as string;

const SOURCE = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

// Runs the owning gate script against a fake `gh` that serves fixed API
// routes through real jq, so the decision is the workflow's own.
function gate(opts: {
  runConclusion: string;
  verify?: string;
  latest?: string;
  compare?: string;
}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-gate-'));
  try {
    const repo = 'jlapenna/agent-lcars';
    const routes: Record<string, unknown> = {
      [`repos/${repo}/actions/runs/7/jobs`]: {
        jobs:
          opts.verify === undefined
            ? []
            : [{ name: 'Verify', conclusion: opts.verify }],
      },
      [`repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=1`]:
        { workflow_runs: opts.latest ? [{ head_sha: opts.latest }] : [] },
      [`repos/${repo}/compare/${SOURCE}...${opts.latest}`]: {
        status: opts.compare ?? 'ahead',
      },
    };
    writeFileSync(path.join(dir, 'routes.json'), JSON.stringify(routes));
    const gh = path.join(dir, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] && [ "$3" = --jq ] || { echo "unexpected gh $*" >&2; exit 2; }
jq -e --arg r "$2" 'has($r)' "${dir}/routes.json" >/dev/null || { echo "no route $2" >&2; exit 2; }
jq -r --arg r "$2" ".[\\$r] | $4" "${dir}/routes.json"
`,
    );
    chmodSync(gh, 0o755);
    const output = path.join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: repo,
        EVENT_NAME: 'workflow_run',
        RUN_ID: '7',
        RUN_CONCLUSION: opts.runConclusion,
        HEAD_SHA: SOURCE,
      },
    });
    return {
      status: result.status,
      passed: readFileSync(output, 'utf8').trim(),
      log: result.stdout + result.stderr,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('deploy-console Verify gate', () => {
  it('admits a successful Verify', () => {
    expect(gate({ runConclusion: 'success', verify: 'success' })).toMatchObject(
      { status: 0, passed: 'verify_passed=true' },
    );
  });

  it('skips without failing when a newer main CI run superseded the source', () => {
    const result = gate({ runConclusion: 'cancelled', latest: NEWER });
    expect(result).toMatchObject({ status: 0, passed: 'verify_passed=false' });
    expect(result.log).toContain('superseded');
  });

  it.each([
    [
      'a failed Verify',
      { runConclusion: 'failure', verify: 'failure', latest: NEWER },
    ],
    [
      'a cancelled run on the main tip',
      { runConclusion: 'cancelled', latest: SOURCE },
    ],
    ['a cancelled run with no newer CI', { runConclusion: 'cancelled' }],
    [
      'a cancelled run whose newest CI is not a descendant',
      { runConclusion: 'cancelled', latest: NEWER, compare: 'diverged' },
    ],
    [
      'a cancelled run whose Verify failed',
      { runConclusion: 'cancelled', verify: 'failure', latest: NEWER },
    ],
  ])('fails the gate for %s', (_, opts) => {
    const result = gate(opts);
    expect(result).toMatchObject({ status: 1, passed: 'verify_passed=false' });
    expect(result.log).toContain('::error::Verify did not pass');
  });
});
