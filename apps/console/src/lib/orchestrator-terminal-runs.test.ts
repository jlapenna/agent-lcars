import {
  type Clock,
  MemoryStore,
  Orchestrator,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import type { DispatchTokenProvider } from './github-app-tokens';
import {
  isTerminalWorkflowRun,
  settleTerminalRuns,
} from './orchestrator-terminal-runs';

const TASK: TaskId = { repo: 'octo/example', issue: 7 };
const T0 = '2026-08-15T12:00:00.000Z';
const tokens: DispatchTokenProvider = { tokenFor: async () => 'gh-test-token' };

class TestClock implements Clock {
  constructor(private value = T0) {}
  now(): string {
    return this.value;
  }
  advanceMinutes(minutes: number): void {
    this.value = new Date(
      Date.parse(this.value) + minutes * 60_000,
    ).toISOString();
  }
}

interface FakeWorkflowRun {
  display_title?: string | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
}

/** Serves the workflow-runs listing this module reads. The listing is
 *  mutable so a test can mint its live run first (the runId is only known
 *  after the request) and then arm the listing with that run's marker,
 *  recording the URLs asked for so the request shape stays assertable. */
function fixture(options: { status?: number } = {}) {
  const clock = new TestClock();
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, clock);
  const urls: string[] = [];
  let listing: FakeWorkflowRun[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ workflow_runs: listing }), {
      status: options.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    clock,
    store,
    orchestrator,
    urls,
    deps: { store, orchestrator, tokens, fetchImpl },
    arm(runs: FakeWorkflowRun[]): void {
      listing = runs;
    },
  };
}

/** A live, dispatch-confirmed run for TASK, as the drain would leave it. */
async function liveRun(orchestrator: Orchestrator): Promise<string> {
  const outcome = await orchestrator.request({
    taskId: TASK,
    requestId: 'req-1',
    pipeline: 'claude',
  });
  if ('refused' in outcome) throw new Error('unexpected refusal');
  await orchestrator.confirmDispatch(outcome.run.runId);
  return outcome.run.runId;
}

function workflowRun(
  runId: string,
  conclusion: string | null,
  status = 'completed',
): FakeWorkflowRun {
  return {
    display_title: `#7: Claude issue agent [dispatch:g1:${runId}]`,
    status,
    conclusion,
  };
}

describe('isTerminalWorkflowRun', () => {
  it.each([
    ['startup_failure', true],
    ['cancelled', true],
    ['failure', true],
    ['timed_out', true],
    // Not unambiguously "over with nothing left to report" -- these keep
    // the lease backstop rather than being force-settled as lost.
    ['success', false],
    ['neutral', false],
    ['skipped', false],
    ['stale', false],
    ['action_required', false],
  ])('maps a completed run concluded %s to %s', (conclusion, expected) => {
    expect(isTerminalWorkflowRun({ status: 'completed', conclusion })).toBe(
      expected,
    );
  });

  it('never treats a run that has not completed as terminal', () => {
    expect(
      isTerminalWorkflowRun({ status: 'in_progress', conclusion: null }),
    ).toBe(false);
    expect(isTerminalWorkflowRun({ status: 'queued', conclusion: null })).toBe(
      false,
    );
    // A `queued` run cannot carry a conclusion in practice; assert the guard
    // is on `status` regardless, so a malformed payload cannot settle a run.
    expect(
      isTerminalWorkflowRun({ status: 'queued', conclusion: 'failure' }),
    ).toBe(false);
    expect(isTerminalWorkflowRun({})).toBe(false);
  });
});

describe('settleTerminalRuns', () => {
  it('settles a live run whose workflow run hit startup_failure, and re-requests the task', async () => {
    const { store, orchestrator, deps, urls, arm } = fixture();
    const runId = await liveRun(orchestrator);
    arm([workflowRun(runId, 'startup_failure')]);

    const result = await settleTerminalRuns(deps);

    expect(result.settled).toEqual([{ runId, conclusion: 'startup_failure' }]);
    expect(result.failed).toEqual([]);
    expect((await store.readRun(runId))?.state).toBe('lost');
    // The mutex is released and handed straight to the auto-retry: the task
    // is workable again in this one reconcile cycle, not one lease later.
    expect(result.retried).toHaveLength(1);
    expect((await store.readActiveRun(TASK))?.runId).toBe(
      result.retried[0]?.newRunId,
    );
    expect(urls).toEqual([
      'https://api.github.com/repos/octo/example/actions/workflows/claude.yml/runs' +
        '?event=workflow_dispatch&per_page=100',
    ]);
  });

  it('leaves a still-running workflow run alone', async () => {
    const { store, orchestrator, deps, arm } = fixture();
    const runId = await liveRun(orchestrator);
    arm([workflowRun(runId, null, 'in_progress')]);

    const result = await settleTerminalRuns(deps);

    expect(result.settled).toEqual([]);
    expect((await store.readRun(runId))?.state).toBe('running');
  });

  it('lists workflow runs against an injected GitHub API root', async () => {
    const { orchestrator, deps, urls, arm } = fixture();
    const runId = await liveRun(orchestrator);
    arm([workflowRun(runId, null, 'in_progress')]);

    await settleTerminalRuns({
      ...deps,
      githubApiBaseUrl: 'https://fixture.invalid/github/',
    });

    expect(urls).toEqual([
      'https://fixture.invalid/github/repos/octo/example/actions/workflows/claude.yml/runs' +
        '?event=workflow_dispatch&per_page=100',
    ]);
  });

  it('does not double-settle a run whose completion callback already arrived', async () => {
    const { store, orchestrator, deps, urls, arm } = fixture();
    const runId = await liveRun(orchestrator);
    // The agent reported before this reconcile cycle ran -- the ordinary
    // path. The run is no longer live, so it is not even in the probe's
    // feed, and its agent-reported result must survive untouched.
    await orchestrator.report(runId, { ok: false, summary: 'agent said' });
    const reported = await store.readRun(runId);
    arm([workflowRun(runId, 'failure')]);

    const result = await settleTerminalRuns(deps);

    expect(result).toEqual({ settled: [], retried: [], failed: [] });
    expect(urls).toEqual([]); // no live runs: GitHub is never called
    expect(await store.readRun(runId)).toEqual(reported);
    expect(await store.listRuns(TASK)).toHaveLength(1); // no phantom retry
  });

  it('ignores a workflow run carrying no dispatch marker', async () => {
    const { store, orchestrator, deps, arm } = fixture();
    const runId = await liveRun(orchestrator);
    // A hand-triggered workflow_dispatch renders an empty marker.
    arm([
      {
        display_title: '#7: Claude issue agent [dispatch:g:]',
        status: 'completed',
        conclusion: 'failure',
      },
    ]);

    const result = await settleTerminalRuns(deps);

    expect(result.settled).toEqual([]);
    expect((await store.readRun(runId))?.state).toBe('running');
  });

  it('records a failed listing and leaves the run to the lease backstop', async () => {
    const { store, orchestrator, deps } = fixture({ status: 403 });
    const runId = await liveRun(orchestrator);

    const result = await settleTerminalRuns(deps);

    expect(result.settled).toEqual([]);
    expect(result.failed).toEqual([
      {
        repo: TASK.repo,
        pipeline: 'claude',
        error: 'workflow runs listing returned 403',
      },
    ]);
    expect((await store.readRun(runId))?.state).toBe('running');
  });
});
