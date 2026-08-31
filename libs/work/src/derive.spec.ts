import type { Run, Task } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import {
  deriveItemState,
  latestRun,
  toItemView,
  toItemViewSafe,
  toWorkSummary,
} from './derive';

const T = '2026-08-26T10:00:00.000Z';
const WORK_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const payload = {
  origin: { principal: 'user:jlapenna', channel: 'api' as const },
  spec: {
    title: 't',
    description: 'd',
    pipeline: 'claude' as const,
    target: { repo: 'octo/example' },
  },
};

function run(n: number, state: Run['state'], extra: Partial<Run> = {}): Run {
  return {
    runId: `work:${WORK_ID}/r${n}`,
    task: { workId: WORK_ID },
    state,
    pipeline: 'claude',
    requestId: `r${n}`,
    leaseExpiresAt: T,
    events: [],
    createdAt: `2026-08-26T10:0${n}:00.000Z`,
    updatedAt: T,
    ...extra,
  };
}
function task(extra: Partial<Task> = {}): Task {
  return {
    task: { workId: WORK_ID },
    runCount: 1,
    updatedAt: T,
    work: payload,
    ...extra,
  };
}

describe('deriveItemState', () => {
  it.each([
    [
      'closedAt set',
      task({ closedAt: T }),
      [run(1, 'finished', { result: { ok: true } })],
      'canceled',
    ],
    ['latest run canceled', task(), [run(1, 'canceled')], 'canceled'],
    [
      'live run',
      task(),
      [run(1, 'finished', { result: { ok: false } }), run(2, 'pending')],
      'running',
    ],
    [
      'finished ok',
      task(),
      [run(1, 'finished', { result: { ok: true } })],
      'done',
    ],
    [
      'finished not ok',
      task(),
      [run(1, 'finished', { result: { ok: false } })],
      'parked',
    ],
    [
      'lost, budget spent',
      task({ consecutiveLost: 3 }),
      [run(1, 'lost')],
      'parked',
    ],
    [
      'lost, budget left',
      task({ consecutiveLost: 1 }),
      [run(1, 'lost')],
      'running',
    ],
    ['no runs yet', task(), [], 'running'],
  ] as const)('%s → %s', (_name, t, runs, expected) => {
    expect(deriveItemState(t, runs)).toBe(expected);
  });
});

describe('latestRun', () => {
  it('picks the newest by createdAt', () => {
    expect(
      latestRun([run(1, 'finished'), run(3, 'lost'), run(2, 'canceled')])
        ?.runId,
    ).toBe(`work:${WORK_ID}/r3`);
  });
});

describe('toItemView', () => {
  it('projects task, runs, and sessions', () => {
    const view = toItemView({
      workId: WORK_ID,
      task: task(),
      runs: [
        run(1, 'finished', {
          result: { ok: true, ref: 'https://github.com/octo/example/pull/9' },
        }),
      ],
      sessions: [
        {
          sessionId: 's1',
          runId: `work:${WORK_ID}/r1`,
          startedAt: T,
          lastActivityAt: T,
        },
      ],
    });
    expect(view.state).toBe('done');
    expect(view.spec.title).toBe('t');
    expect(view.runs[0]?.result?.ref).toContain('/pull/9');
    expect(view.sessions).toHaveLength(1);
    expect(view.runs[0]).not.toHaveProperty('queue');
  });

  it('projects a claimed-by queue state onto each run view', () => {
    const view = toItemView({
      workId: WORK_ID,
      task: task(),
      runs: [
        run(1, 'running', {
          queue: { state: 'claimed', claimedBy: 'runner-pike-1' },
        }),
      ],
    });
    expect(view.runs[0]).toMatchObject({
      queue: { state: 'claimed', claimedBy: 'runner-pike-1' },
    });
  });

  it('throws when the task carries no valid work payload', () => {
    expect(() =>
      toItemView({
        workId: WORK_ID,
        task: task({ work: undefined }),
        runs: [],
      }),
    ).toThrow();
  });
});

describe('toItemViewSafe', () => {
  it('returns a view for a valid work payload', () => {
    const view = toItemViewSafe({
      workId: WORK_ID,
      task: task(),
      runs: [run(1, 'finished', { result: { ok: true } })],
    });
    expect(view?.state).toBe('done');
    expect(view?.spec.title).toBe('t');
  });

  it('returns undefined when the payload is missing spec', () => {
    const view = toItemViewSafe({
      workId: WORK_ID,
      task: task({
        work: { origin: { principal: 'user:x', channel: 'api' } },
      }),
      runs: [],
    });
    expect(view).toBeUndefined();
  });
});

describe('toWorkSummary', () => {
  const githubTask: Task = {
    task: { repo: 'octo/example', issue: 7 },
    runCount: 1,
    updatedAt: T,
    work: payload,
  };
  const githubRun: Run = {
    ...run(1, 'finished', { result: { ok: false, summary: 'parked' } }),
    runId: 'octo/example#7/r1',
    task: githubTask.task,
  };

  it('uses a collision-free anchor key and authoritative run state for a GitHub task', () => {
    const summary = toWorkSummary({ task: githubTask, runs: [githubRun] });
    expect(summary).toMatchObject({
      id: 'octo/example#7',
      anchor: { repo: 'octo/example', issue: 7 },
      state: 'parked',
      spec: payload.spec,
    });
  });
});
