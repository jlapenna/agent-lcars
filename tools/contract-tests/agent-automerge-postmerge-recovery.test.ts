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
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowText = readFileSync(
  path.join(repoRoot, '.github/workflows/agent-automerge-reusable.yml'),
  'utf8',
);
const workflow = parse(workflowText) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};
const restoreScript = workflow.jobs['restore-main-checks'].steps.find(
  (step) => step.name === 'Dispatch missing post-merge CI/deploy runs',
)?.run;
if (!restoreScript) throw new Error('restore-main-checks shell step not found');

function jqAfter(marker: string, assignment: string): string {
  const markerIndex = workflowText.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const assignmentIndex = workflowText.indexOf(assignment, markerIndex);
  expect(assignmentIndex).toBeGreaterThan(markerIndex);
  const open = workflowText.indexOf("'", assignmentIndex);
  const close = workflowText.indexOf("'", open + 1);
  expect(open).toBeGreaterThan(assignmentIndex);
  expect(close).toBeGreaterThan(open);
  return workflowText.slice(open + 1, close);
}

function jq(program: string, input: unknown, args: string[] = []): unknown {
  const result = spawnSync('jq', ['-c', ...args, program], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

const selectCi = jqAfter('CI_RUN_SELECTION_CONTRACT', 'CI_RUN_RECORD=$(jq');
const decideCi = jqAfter('CI_RUN_DECISION_CONTRACT', 'CI_DECISION=$(jq');
const selectDeliverySources = jqAfter(
  'DELIVERY_SOURCE_PROVENANCE_CONTRACT',
  'DELIVERY_RUN_RECORDS=$(jq',
);
const selectDeploys = jqAfter(
  'DEPLOY_RUN_SELECTION_CONTRACT',
  'DEPLOY_RUN_RECORDS=$(jq',
);
const decideDeploy = jqAfter(
  'DEPLOY_RUN_DECISION_CONTRACT',
  'DEPLOY_DECISION=$(jq',
);
const decideMainDispatch = jqAfter(
  'MAIN_DISPATCH_DECISION_CONTRACT',
  'MAIN_DISPATCH_DECISION=$(jq',
);

interface Run {
  id: number;
  head_sha: string;
  event: 'push' | 'workflow_dispatch' | 'workflow_run';
  display_title: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  created_at: string;
  job_count?: number;
}

const sha = 'a'.repeat(40);

function run(overrides: Partial<Run> & Pick<Run, 'id'>): Run {
  return {
    id: overrides.id,
    head_sha: sha,
    display_title: `Delivery [source:${sha}]`,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    created_at: `2026-09-10T13:${String(overrides.id).padStart(2, '0')}:00Z`,
    ...overrides,
  };
}

function selectCiRun(runs: Run[]): Run | Record<string, never> {
  return jq(selectCi, [{ workflow_runs: runs }], ['--arg', 'sha', sha]) as
    Run | Record<string, never>;
}

function ciDecision(selected: Run | Record<string, never>): string {
  return jq(decideCi, selected) as string;
}

function deployDecision(runs: Run[]): string {
  const sourced = jq(selectDeliverySources, [{ workflow_runs: runs }]);
  const selected = jq(selectDeploys, sourced, ['--arg', 'sha', sha]);
  return jq(decideDeploy, selected) as string;
}

interface ShellScenario {
  ciRuns: Run[];
  deployRuns: Run[];
  postCiRuns?: Run[];
  postCiWorkflows?: string[];
  postCiWorkflowsRaw?: string;
  postSubmitEnabled?: string;
  currentMain?: string;
  deployCurrentMain?: string;
  cancelledDeployJobCount?: number;
  cancelledPostCiJobCount?: number;
}

const greenRollup = {
  statusCheckRollup: [
    {
      name: 'Verify',
      conclusion: 'SUCCESS',
      startedAt: '2026-09-10T13:00:00Z',
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/1',
    },
    {
      name: 'E2E Tests',
      conclusion: 'SUCCESS',
      startedAt: '2026-09-10T13:00:01Z',
      detailsUrl: 'https://github.com/o/r/actions/runs/2/job/1',
    },
  ],
};

function executeRestoreStep(scenario: ShellScenario): {
  status: number | null;
  output: string;
  calls: string[];
} {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'postmerge-recovery-'));
  const callsPath = path.join(temp, 'calls');
  const refCountPath = path.join(temp, 'ref-count');
  const fakeGh = path.join(temp, 'gh');
  const fakeSleep = path.join(temp, 'sleep');
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
echo "$args" >> "$CALLS_PATH"
case "$args" in
  *"pulls/1 --jq .user.login"*) echo 'agent-lcars[bot]' ;;
  "pr view 1"*"headRefOid"*) echo "$HEAD_SHA" ;;
  "pr view 1"*"statusCheckRollup"*) printf '%s\\n' "$GREEN_ROLLUP" ;;
  "pr view 1"*"state,mergeCommit"*) echo "$SAFETY_SHA" ;;
  "api graphql"*) exit 0 ;;
  *"git/ref/heads/main"*)
    count=0
    [ ! -f "$REF_COUNT_PATH" ] || count=$(cat "$REF_COUNT_PATH")
    count=$((count + 1)); echo "$count" > "$REF_COUNT_PATH"
    if [ "$count" -eq 1 ]; then
      echo "$SAFETY_SHA"
    elif [ "$count" -eq 2 ]; then
      echo "$CURRENT_MAIN_SHA"
    else
      echo "$DEPLOY_CURRENT_MAIN_SHA"
    fi
    ;;
  *"compare/"*) echo identical ;;
  *"actions/workflows/ci.yml/runs?"*) printf '[%s]\\n' "$CI_RUNS_JSON" ;;
  *"actions/workflows/post-ci.yml/runs?"*) printf '[%s]\\n' "$POST_CI_RUNS_JSON" ;;
  *"actions/workflows/deploy.yml/runs?"*) printf '[%s]\\n' "$DEPLOY_RUNS_JSON" ;;
  *"actions/runs/4/jobs"*) echo "$CANCELLED_POST_CI_JOB_COUNT" ;;
  *"/jobs"*) echo "$CANCELLED_DEPLOY_JOB_COUNT" ;;
  "run view "*) printf 'completed\\tsuccess\\n' ;;
  "workflow run "*)
    workflow="$3"
    echo "dispatch:$workflow" >> "$CALLS_PATH"
    [ "$workflow" != deploy.yml ] || echo 'https://github.com/o/r/actions/runs/900'
    ;;
  "issue close "*) ;;
  *) echo "unhandled fake gh call: $args" >&2; exit 97 ;;
esac
`,
  );
  writeFileSync(fakeSleep, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeGh, 0o755);
  chmodSync(fakeSleep, 0o755);
  writeFileSync(callsPath, '');
  writeFileSync(refCountPath, '0');

  const result = spawnSync('bash', ['-c', restoreScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${temp}:${process.env['PATH'] ?? ''}`,
      CALLS_PATH: callsPath,
      REF_COUNT_PATH: refCountPath,
      HEAD_SHA: 'h'.repeat(40),
      EVENT_NAME: 'workflow_dispatch',
      EVENT_PR: '1',
      REPO: 'o/r',
      AGENT_BOT_LOGINS: '["agent-lcars[bot]"]',
      REQUIRED_CHECKS: '["Verify","E2E Tests"]',
      CI_WORKFLOW: 'ci.yml',
      EXTRA_MAIN_WORKFLOWS: '[]',
      POST_CI_WORKFLOWS:
        scenario.postCiWorkflowsRaw ??
        JSON.stringify(scenario.postCiWorkflows ?? []),
      DEPLOY_WORKFLOW: 'deploy.yml',
      POST_DEPLOY_VERIFY_WORKFLOW: 'post-deploy.yml',
      POST_SUBMIT_ENABLED: scenario.postSubmitEnabled ?? 'true',
      CHECK_WAIT_MINUTES: '1',
      SAFETY_SHA: sha,
      CURRENT_MAIN_SHA: scenario.currentMain ?? sha,
      DEPLOY_CURRENT_MAIN_SHA:
        scenario.deployCurrentMain ?? scenario.currentMain ?? sha,
      CI_RUNS_JSON: JSON.stringify({ workflow_runs: scenario.ciRuns }),
      DEPLOY_RUNS_JSON: JSON.stringify({
        workflow_runs: scenario.deployRuns,
      }),
      POST_CI_RUNS_JSON: JSON.stringify({
        workflow_runs: scenario.postCiRuns ?? [],
      }),
      CANCELLED_DEPLOY_JOB_COUNT: String(scenario.cancelledDeployJobCount ?? 0),
      CANCELLED_POST_CI_JOB_COUNT: String(
        scenario.cancelledPostCiJobCount ?? 0,
      ),
      GREEN_ROLLUP: JSON.stringify(greenRollup),
    },
  });
  const calls = readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  rmSync(temp, { recursive: true, force: true });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls,
  };
}

describe('agent automerge post-merge recovery admission', () => {
  it('uses the configured recovery wait budget for checks, CI, and deploy', () => {
    expect(
      workflowText.match(/seq 1 \$\(\(CHECK_WAIT_MINUTES \* 12\)\)/g),
    ).toHaveLength(3);
    expect(workflowText).not.toContain('seq 1 180');
    expect(workflowText).not.toContain('seq 1 360');
  });

  it('reuses the restored CI after it replaces a pending push CI', () => {
    const selected = selectCiRun([
      run({ id: 1, status: 'completed', conclusion: 'cancelled' }),
      run({
        id: 2,
        event: 'workflow_dispatch',
        status: 'in_progress',
        conclusion: null,
      }),
    ]);

    expect(selected).toMatchObject({ id: 2, event: 'workflow_dispatch' });
    expect(ciDecision(selected)).toBe('wait');
    expect(
      deployDecision([
        run({
          id: 3,
          event: 'workflow_dispatch',
          conclusion: 'skipped',
        }),
      ]),
    ).toBe('dispatch');
  });

  it.each([
    ['queued', null],
    ['in_progress', null],
    ['completed', 'success'],
  ] as const)(
    'leaves a natural push run that is %s/%s in charge',
    (status, conclusion) => {
      expect(
        ciDecision(selectCiRun([run({ id: 1, status, conclusion })])),
      ).toBe('natural');
    },
  );

  it.each(['failure', 'timed_out', 'cancelled'])(
    'fails closed for a completed push CI with conclusion %s',
    (conclusion) => {
      expect(
        ciDecision(
          selectCiRun([run({ id: 1, status: 'completed', conclusion })]),
        ),
      ).toBe('fail');
    },
  );

  it('dispatches CI only when the exact safety SHA has no run', () => {
    const selected = selectCiRun([run({ id: 1, head_sha: 'b'.repeat(40) })]);
    expect(selected).toEqual({});
    expect(ciDecision(selected)).toBe('dispatch');
  });

  it.each([
    ['failed', run({ id: 1, conclusion: 'failure' })],
    [
      'partially cancelled',
      run({ id: 1, conclusion: 'cancelled', job_count: 1 }),
    ],
    ['successful', run({ id: 1, conclusion: 'success' })],
    ['active', run({ id: 1, status: 'in_progress', conclusion: null })],
  ])('does not duplicate a %s deploy', (_label, existing) => {
    expect(deployDecision([existing])).toBe('owned');
  });

  it.each([
    ['skipped', run({ id: 1, conclusion: 'skipped' })],
    [
      'zero-job cancelled',
      run({ id: 1, conclusion: 'cancelled', job_count: 0 }),
    ],
  ])('replaces a %s deploy that proved no work ran', (_label, existing) => {
    expect(deployDecision([existing])).toBe('dispatch');
  });

  it('does not let an ancestor workflow_run displayed at B own B', () => {
    const ancestor = 'b'.repeat(40);
    expect(
      deployDecision([
        run({
          id: 1,
          event: 'workflow_run',
          head_sha: sha,
          display_title: `Deploy [source:${ancestor}]`,
        }),
      ]),
    ).toBe('dispatch');
  });

  it('retains a B owner even when its displayed head has advanced to C', () => {
    expect(
      deployDecision([
        run({
          id: 1,
          event: 'workflow_run',
          head_sha: 'c'.repeat(40),
          display_title: `Deploy [source:${sha}]`,
        }),
      ]),
    ).toBe('owned');
  });

  it('retains an older paginated partial deployment even when a newer run was skipped', () => {
    const selected = jq(
      selectDeploys,
      jq(selectDeliverySources, [
        { workflow_runs: [run({ id: 2, conclusion: 'skipped' })] },
        { workflow_runs: [run({ id: 1, conclusion: 'failure' })] },
      ]),
      ['--arg', 'sha', sha],
    );
    expect(jq(decideDeploy, selected)).toBe('owned');
  });

  it('permits an explicit deploy only while main still equals the validated safety SHA', () => {
    expect(
      jq(decideMainDispatch, null, [
        '--arg',
        'safety',
        sha,
        '--arg',
        'current',
        sha,
      ]),
    ).toBe('dispatch');
    expect(
      jq(decideMainDispatch, null, [
        '--arg',
        'safety',
        sha,
        '--arg',
        'current',
        'b'.repeat(40),
      ]),
    ).toBe('refuse');
  });

  it('executes the observed cancellation race through one recovered deploy', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({ id: 1, status: 'completed', conclusion: 'cancelled' }),
        run({
          id: 2,
          event: 'workflow_dispatch',
          status: 'completed',
          conclusion: 'success',
        }),
      ],
      deployRuns: [run({ id: 3, conclusion: 'skipped' })],
    });

    expect(result.output).not.toContain('unhandled fake gh call');
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call === 'dispatch:ci.yml')).toEqual(
      [],
    );
    expect(
      result.calls.filter((call) => call === 'dispatch:deploy.yml'),
    ).toHaveLength(1);
    expect(result.calls).toContain(
      `workflow run deploy.yml --repo o/r --ref main -f source_sha=${sha} -f delivery_mode=recovered-ci`,
    );
    expect(
      result.calls.filter((call) => call === 'dispatch:post-deploy.yml'),
    ).toHaveLength(1);
  });

  it('dispatches a missing post-CI workflow with exact source and recovery provenance', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [run({ id: 3, conclusion: 'success' })],
      postCiRuns: [],
      postCiWorkflows: ['post-ci.yml'],
    });

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('unhandled fake gh call');
    expect(result.calls).toContain(
      `workflow run post-ci.yml --repo o/r --ref main -f source_sha=${sha} -f delivery_mode=recovered-ci`,
    );
    expect(
      result.calls.filter((call) => call === 'dispatch:post-ci.yml'),
    ).toHaveLength(1);
  });

  it.each([
    ['successful', run({ id: 4, conclusion: 'success' }), 0],
    ['partially cancelled', run({ id: 4, conclusion: 'cancelled' }), 2],
  ])(
    'does not duplicate a %s post-CI workflow',
    (_label, existing, jobCount) => {
      const result = executeRestoreStep({
        ciRuns: [
          run({
            id: 2,
            event: 'workflow_dispatch',
            conclusion: 'success',
          }),
        ],
        deployRuns: [run({ id: 3, conclusion: 'success' })],
        postCiRuns: [existing],
        postCiWorkflows: ['post-ci.yml'],
        cancelledPostCiJobCount: jobCount,
      });

      expect(result.status).toBe(0);
      expect(
        result.calls.filter((call) => call === 'dispatch:post-ci.yml'),
      ).toEqual([]);
    },
  );

  it('replaces a cancelled zero-job post-CI run', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [run({ id: 3, conclusion: 'success' })],
      postCiRuns: [run({ id: 4, conclusion: 'cancelled' })],
      postCiWorkflows: ['post-ci.yml'],
      cancelledPostCiJobCount: 0,
    });

    expect(result.status).toBe(0);
    expect(
      result.calls.filter((call) => call === 'dispatch:post-ci.yml'),
    ).toHaveLength(1);
  });

  it('does not let an ancestor post-CI run displayed at B own B', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [run({ id: 3, conclusion: 'success' })],
      postCiRuns: [
        run({
          id: 4,
          event: 'workflow_run',
          head_sha: sha,
          display_title: `Deploy rules [source:${'b'.repeat(40)}]`,
        }),
      ],
      postCiWorkflows: ['post-ci.yml'],
    });

    expect(result.status).toBe(0);
    expect(
      result.calls.filter((call) => call === 'dispatch:post-ci.yml'),
    ).toHaveLength(1);
  });

  it('fails closed for a completed unproven legacy deploy with work', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [
        run({ id: 3, head_sha: sha, display_title: 'Deploy (legacy)' }),
      ],
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'completed legacy run(s) with work for displayed head',
    );
    expect(
      result.calls.filter((call) => call === 'dispatch:deploy.yml'),
    ).toEqual([]);
  });

  it('does not inspect jobs for an unrelated historical cancellation', () => {
    const unrelated = 'b'.repeat(40);
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [
        run({
          id: 99,
          head_sha: unrelated,
          conclusion: 'cancelled',
          display_title: `Deploy [source:${unrelated}]`,
        }),
      ],
    });

    expect(result.status).toBe(0);
    expect(
      result.calls.some((call) => call.includes('actions/runs/99/jobs')),
    ).toBe(false);
    expect(
      result.calls.filter((call) => call === 'dispatch:deploy.yml'),
    ).toHaveLength(1);
  });

  it('waits boundedly rather than overlapping an active wrong-source deploy', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [
        run({
          id: 3,
          head_sha: sha,
          status: 'in_progress',
          conclusion: null,
          display_title: `Deploy [source:${'b'.repeat(40)}]`,
        }),
      ],
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain('recovery will not overlap it');
    expect(
      result.calls.filter((call) => call === 'dispatch:deploy.yml'),
    ).toEqual([]);
  });

  it('keeps every post-CI workflow paused when post-submit is disabled', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [],
      postCiWorkflows: ['post-ci.yml'],
      postSubmitEnabled: 'false',
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('Post-submit disabled');
    expect(result.calls.filter((call) => call.startsWith('dispatch:'))).toEqual(
      [],
    );
  });

  it('rejects malformed post-CI workflow configuration before dispatch', () => {
    const result = executeRestoreStep({
      ciRuns: [],
      deployRuns: [],
      postCiWorkflowsRaw: '{"workflow":"post-ci.yml"}',
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'post-ci-workflows must contain unique non-empty workflow file names',
    );
    expect(result.calls.filter((call) => call.startsWith('dispatch:'))).toEqual(
      [],
    );
  });

  it.each([
    ['duplicate names', '["post-ci.yml","post-ci.yml"]'],
    ['deploy overlap', '["deploy.yml"]'],
  ])('rejects post-CI workflow configuration with %s', (_label, raw) => {
    const result = executeRestoreStep({
      ciRuns: [],
      deployRuns: [],
      postCiWorkflowsRaw: raw,
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'post-ci-workflows must contain unique non-empty workflow file names',
    );
    expect(result.calls.filter((call) => call.startsWith('dispatch:'))).toEqual(
      [],
    );
  });

  it('executes a successful natural push without dispatching anything', () => {
    const result = executeRestoreStep({
      ciRuns: [run({ id: 1 })],
      deployRuns: [],
    });

    expect(result.output).not.toContain('unhandled fake gh call');
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('dispatch:'))).toEqual(
      [],
    );
  });

  it.each([
    ['failed', run({ id: 3, conclusion: 'failure' }), 0, false],
    ['partially cancelled', run({ id: 3, conclusion: 'cancelled' }), 2, true],
  ])(
    'executes a %s deploy as terminal without retrying',
    (_label, deployRun, jobCount, expectJobsLookup) => {
      const result = executeRestoreStep({
        ciRuns: [
          run({
            id: 2,
            event: 'workflow_dispatch',
            conclusion: 'success',
          }),
        ],
        deployRuns: [deployRun],
        cancelledDeployJobCount: jobCount,
      });

      expect(result.output).not.toContain('unhandled fake gh call');
      expect(result.status).toBe(0);
      expect(
        result.calls.filter((call) => call.startsWith('dispatch:')),
      ).toEqual([]);
      expect(result.calls.some((call) => call.includes('/jobs'))).toBe(
        expectJobsLookup,
      );
    },
  );

  it('refuses deployment when main advances while the restored CI runs', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [run({ id: 3, conclusion: 'skipped' })],
      currentMain: 'b'.repeat(40),
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain('Main advanced from CI-validated');
    expect(result.calls.filter((call) => call.startsWith('dispatch:'))).toEqual(
      [],
    );
  });

  it('does not fail an already-owned delivery merely because main advanced', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [run({ id: 3, conclusion: 'success' })],
      currentMain: 'b'.repeat(40),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain(
      'already has a run that owns safety target',
    );
    expect(result.calls.filter((call) => call.startsWith('dispatch:'))).toEqual(
      [],
    );
  });

  it('keeps both recovered deliveries bound when main advances after admission', () => {
    const result = executeRestoreStep({
      ciRuns: [
        run({
          id: 2,
          event: 'workflow_dispatch',
          conclusion: 'success',
        }),
      ],
      deployRuns: [run({ id: 3, conclusion: 'skipped' })],
      postCiRuns: [],
      postCiWorkflows: ['post-ci.yml'],
      deployCurrentMain: 'b'.repeat(40),
    });

    expect(result.status).toBe(0);
    expect(
      result.calls.filter((call) => call === 'dispatch:post-ci.yml'),
    ).toHaveLength(1);
    expect(result.calls).toContain(
      `workflow run deploy.yml --repo o/r --ref main -f source_sha=${sha} -f delivery_mode=recovered-ci`,
    );
  });
});
