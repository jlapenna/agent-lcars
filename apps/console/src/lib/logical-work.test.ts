import { describe, expect, it } from 'vitest';

import type { AgentRun } from './agent-activity';
import {
  deriveActivityMetrics,
  deriveLogicalWork,
  type TaskMeta,
  taskMetaFromItems,
} from './logical-work';

const REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };
const REPO_B = { owner: 'org-b', name: 'repo-b' };

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    repo: REPO,
    pipeline: 'claude',
    status: 'running',
    event: 'workflow_dispatch',
    url: 'https://github.com/supersprinklesracing/sprinkles/actions/runs/1',
    displayTitle: '#42: Claude issue agent [dispatch:g1:intent-abc123]',
    issueNumber: 42,
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:00:00Z',
    elapsedSeconds: 60,
    ...overrides,
  };
}

function makeTaskMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    repo: REPO,
    issueNumber: 42,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
    ...overrides,
  };
}

const KEY = 'supersprinklesracing/sprinkles#42';

describe('deriveLogicalWork - one task, one attempt', () => {
  it('marks a failed authority read unavailable instead of using attempt state', () => {
    const { work } = deriveLogicalWork({
      attempts: [makeRun()],
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
      unavailableTaskKeys: new Set([KEY]),
    });

    expect(work[0].state).toBe('unavailable');
    expect(work[0].provenance).toEqual({ kind: 'unavailable' });
  });

  it('joins a single marker-carrying attempt into one active LogicalWork', () => {
    const { work, unattributedAttempts } = deriveLogicalWork({
      attempts: [makeRun()],
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(unattributedAttempts).toEqual([]);
    expect(work).toHaveLength(1);
    const task = work[0];
    expect(task.task).toEqual({ repository: REPO, issueNumber: 42 });
    expect(task.title).toBe('Fix the thing');
    expect(task.state).toBe('active');
    expect(task.provenance).toEqual({ kind: 'legacy' });
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0].attribution).toBe('run-marker');
    expect(task.attempts[0].generation).toBe(1);
    expect(task.attempts[0].intentId).toBe('intent-abc123');
    expect(task.attempts[0].attemptId).toBe('g1:intent-abc123');
    expect(task.anomalies).toEqual([]);
  });
});

describe('deriveLogicalWork - zero attempts', () => {
  it('reports a genuinely idle task (no attempts) as unknown', () => {
    const { work } = deriveLogicalWork({
      attempts: [],
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work).toHaveLength(1);
    expect(work[0].state).toBe('unknown');
    expect(work[0].provenance).toEqual({ kind: 'legacy' });
  });
});

describe('deriveLogicalWork - retry / two terminal attempts', () => {
  it('keeps both a failed first attempt and a completed retry visible under two generations', () => {
    const attempts = [
      makeRun({
        id: 1,
        status: 'completed',
        conclusion: 'failure',
        displayTitle: '#42: Claude issue agent [dispatch:g1:intent-g1]',
        createdAt: '2026-07-07T00:00:00Z',
      }),
      makeRun({
        id: 2,
        status: 'completed',
        conclusion: 'success',
        displayTitle: '#42: Claude issue agent [dispatch:g2:intent-g2]',
        createdAt: '2026-07-07T01:00:00Z',
      }),
    ];

    const { work } = deriveLogicalWork({
      attempts,
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work).toHaveLength(1);
    expect(work[0].state).toBe('completed');
    expect(work[0].attempts.map((a) => a.id)).toEqual([1, 2]);
    expect(work[0].attempts[0].generation).toBe(1);
    expect(work[0].attempts[1].generation).toBe(2);
    expect(work[0].anomalies).toEqual([]);
  });
});

describe('deriveLogicalWork - duplicate active attempts', () => {
  it('flags two same-pipeline live attempts as an anomaly without dropping either', () => {
    const attempts = [
      makeRun({
        id: 1,
        status: 'queued',
        displayTitle: '#42: Claude issue agent [dispatch:g1:intent-a]',
      }),
      makeRun({
        id: 2,
        status: 'running',
        displayTitle: '#42: Claude issue agent [dispatch:g1:intent-a]',
      }),
    ];

    const { work } = deriveLogicalWork({
      attempts,
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work).toHaveLength(1);
    expect(work[0].attempts.map((a) => a.id)).toEqual([1, 2]);
    expect(work[0].state).toBe('anomaly');
    expect(work[0].anomalies).toHaveLength(1);
    expect(work[0].anomalies[0].kind).toBe('duplicate-active-attempts');
    expect(work[0].anomalies[0].detail).toContain('claude');
  });

  it('does not flag two different pipelines racing the same issue as a duplicate-attempt anomaly', () => {
    const attempts = [
      makeRun({ id: 1, status: 'running', pipeline: 'claude' }),
      makeRun({
        id: 2,
        status: 'running',
        pipeline: 'codex',
        displayTitle: 'codex #42: [dispatch:g1:intent-codex]',
      }),
    ];

    const { work } = deriveLogicalWork({
      attempts,
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work).toHaveLength(1);
    expect(work[0].attempts).toHaveLength(2);
    expect(
      work[0].anomalies.some((a) => a.kind === 'duplicate-active-attempts'),
    ).toBe(false);
  });

  it('does not flag two completed attempts of the same pipeline as a live duplicate', () => {
    const attempts = [
      makeRun({ id: 1, status: 'completed', conclusion: 'failure' }),
      makeRun({ id: 2, status: 'completed', conclusion: 'success' }),
    ];

    const { work } = deriveLogicalWork({
      attempts,
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].anomalies).toEqual([]);
    expect(work[0].state).toBe('completed');
  });
});

describe('deriveLogicalWork - attribution', () => {
  it('falls back to legacy-title attribution for a pre-marker run', () => {
    const attempts = [makeRun({ id: 1, displayTitle: '#42: Fix the thing' })];
    const { work } = deriveLogicalWork({
      attempts,
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].attempts[0].attribution).toBe('legacy-title');
    expect(work[0].provenance).toEqual({ kind: 'legacy' });
  });

  it('keeps a run with no parseable issue number out of any LogicalWork', () => {
    const attempts = [
      makeRun({ id: 1, issueNumber: undefined, displayTitle: 'Fix it' }),
    ];
    const { work, unattributedAttempts } = deriveLogicalWork({
      attempts,
      taskMeta: new Map(),
    });

    expect(work).toEqual([]);
    expect(unattributedAttempts).toHaveLength(1);
    expect(unattributedAttempts[0].attribution).toBe('unattributed');
  });
});

describe('deriveLogicalWork - attemptId (#645)', () => {
  it('derives attemptId from the run-name marker', () => {
    const attempts = [
      makeRun({
        id: 1,
        displayTitle: '#42: Claude issue agent [dispatch:g3:intent-xyz]',
      }),
    ];

    const { work } = deriveLogicalWork({
      attempts,
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].attempts[0].attribution).toBe('run-marker');
    expect(work[0].attempts[0].attemptId).toBe('g3:intent-xyz');
  });

  it('leaves attemptId undefined for a legacy-title attempt with no marker at all', () => {
    const attempts = [makeRun({ id: 1, displayTitle: '#42: Fix the thing' })];

    const { work } = deriveLogicalWork({
      attempts,
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].attempts[0].attribution).toBe('legacy-title');
    expect(work[0].attempts[0].attemptId).toBeUndefined();
  });
});

describe('deriveLogicalWork - cross-repo and cross-task safety', () => {
  it('never merges the same issue number across two different repositories', () => {
    const attempts = [
      makeRun({ id: 1, repo: REPO, issueNumber: 42 }),
      makeRun({ id: 2, repo: REPO_B, issueNumber: 42 }),
    ];
    const { work } = deriveLogicalWork({
      attempts,
      taskMeta: new Map(),
    });

    expect(work).toHaveLength(2);
    expect(new Set(work.map((w) => w.task.repository.owner))).toEqual(
      new Set(['supersprinklesracing', 'org-b']),
    );
  });
});

describe('deriveLogicalWork - human-needed', () => {
  it('surfaces a maintainer-blocked task distinctly even with an active attempt', () => {
    const { work } = deriveLogicalWork({
      attempts: [makeRun()],
      taskMeta: new Map([[KEY, makeTaskMeta({ humanNeeded: true })]]),
    });

    expect(work[0].state).toBe('human-needed');
  });
});

describe('taskMetaFromItems', () => {
  it('keys the map by repoItemKey', () => {
    const items = [
      { repo: REPO, number: 42, title: 'A', url: 'https://x' },
      { repo: REPO, number: 43, title: 'B', url: 'https://y' },
    ];
    const taskMeta = taskMetaFromItems(items);

    expect(taskMeta.size).toBe(2);
    expect(taskMeta.get(KEY)?.title).toBe('A');
    expect(taskMeta.get('supersprinklesracing/sprinkles#43')?.title).toBe('B');
  });
});

describe('deriveActivityMetrics', () => {
  it('reports logical tasks, queued/running attempts, and runner occupancy as distinct numbers', () => {
    const attempts = [
      makeRun({ id: 1, status: 'queued' }),
      // Two duplicate running attempts on the SAME task (#42) - this is
      // exactly the case that used to be silently collapsed to one row.
      // It must inflate the attempt count without inflating the task count.
      makeRun({ id: 2, status: 'running' }),
      makeRun({ id: 3, status: 'running' }),
      makeRun({ id: 4, status: 'running', issueNumber: 43 }),
    ];
    const { work, unattributedAttempts } = deriveLogicalWork({
      attempts,
      taskMeta: new Map([
        [KEY, makeTaskMeta()],
        [
          'supersprinklesracing/sprinkles#43',
          makeTaskMeta({ issueNumber: 43 }),
        ],
      ]),
    });
    const allAttempts = [
      ...work.flatMap((w) => w.attempts),
      ...unattributedAttempts,
    ];

    const metrics = deriveActivityMetrics(work, allAttempts, {
      online: 5,
      busy: 2,
    });

    expect(metrics.logicalTaskCount).toBe(2);
    expect(metrics.queuedAttempts).toBe(1);
    expect(metrics.runningAttempts).toBe(3);
    expect(metrics.onlineRunners).toBe(5);
    expect(metrics.busyRunners).toBe(2);
    // A duplicate-attempt task still counts once as logical work, even
    // though it contributes three running attempts - the whole point of
    // keeping these numbers distinct.
    expect(metrics.logicalTaskCount).not.toBe(metrics.runningAttempts);
  });

  it('never inflates the runner numbers when the fleet API was unavailable', () => {
    const metrics = deriveActivityMetrics([], [], undefined);
    expect(metrics.onlineRunners).toBeUndefined();
    expect(metrics.busyRunners).toBeUndefined();
  });
});
