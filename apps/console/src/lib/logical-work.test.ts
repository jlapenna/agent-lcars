import {
  classifyFailure,
  formatFailure,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type { AgentRun } from './agent-activity';
import type { DispatchLedger } from './dispatch-ledger';
import {
  deriveActivityMetrics,
  deriveLogicalWork,
  ledgerAndTaskMetaFromItems,
  type TaskMeta,
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

function makeLedger(overrides: Partial<DispatchLedger> = {}): DispatchLedger {
  return {
    schema: 'agent-lcars.dispatch-ledger/v1',
    revision: 1,
    task: {
      repositoryId: 1001,
      repository: 'supersprinklesracing/sprinkles',
      issue: 42,
    },
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:00:00Z',
    control: { closed: false },
    sources: [
      {
        sourceKind: 'labeled',
        sourceId: 'src-1',
        transportRunId: 1,
        occurredAt: '2026-07-07T00:00:00Z',
      },
    ],
    generations: [
      {
        generation: 1,
        intentId: 'intent-abc123',
        sourceId: 'src-1',
        occurredAt: '2026-07-07T00:00:00Z',
        pipeline: 'claude',
        mode: 'implement',
        state: 'active',
        attempt: { runId: 1, status: 'in_progress' },
      },
    ],
    anomalies: [],
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
  it('joins a single ledger-backed attempt into one active LogicalWork', () => {
    const { work, unattributedAttempts } = deriveLogicalWork({
      attempts: [makeRun()],
      ledgers: new Map([[KEY, makeLedger()]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(unattributedAttempts).toEqual([]);
    expect(work).toHaveLength(1);
    const task = work[0];
    expect(task.task).toEqual({ repository: REPO, issueNumber: 42 });
    expect(task.title).toBe('Fix the thing');
    expect(task.state).toBe('active');
    expect(task.provenance).toEqual({ kind: 'ledger-v1', revision: 1 });
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0].attribution).toBe('ledger');
    expect(task.attempts[0].generation).toBe(1);
    expect(task.attempts[0].intentId).toBe('intent-abc123');
    expect(task.attempts[0].attemptId).toBe('g1:intent-abc123');
    expect(task.intents).toHaveLength(1);
    expect(task.intents[0]).toMatchObject({
      intentId: 'intent-abc123',
      generation: 1,
      sourceKind: 'labeled',
      state: 'active',
    });
    expect(task.anomalies).toEqual([]);
  });
});

describe('deriveLogicalWork - pending, zero attempts', () => {
  it('surfaces a ledger generation with no materialized attempt yet as pending', () => {
    const ledger = makeLedger({
      generations: [
        {
          generation: 1,
          intentId: 'intent-pending',
          sourceId: 'src-1',
          occurredAt: '2026-07-07T00:00:00Z',
          pipeline: 'claude',
          mode: 'implement',
          state: 'accepted',
        },
      ],
    });
    const { work } = deriveLogicalWork({
      attempts: [],
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work).toHaveLength(1);
    expect(work[0].state).toBe('pending');
    expect(work[0].attempts).toEqual([]);
    expect(work[0].intents).toHaveLength(1);
  });

  it('reports a genuinely idle task (no ledger, no attempts) as unknown', () => {
    const { work } = deriveLogicalWork({
      attempts: [],
      ledgers: new Map(),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work).toHaveLength(1);
    expect(work[0].state).toBe('unknown');
    expect(work[0].provenance).toEqual({ kind: 'legacy' });
  });
});

describe('deriveLogicalWork - retry / two terminal attempts', () => {
  it('keeps both a failed first attempt and a completed retry visible under two generations', () => {
    const ledger = makeLedger({
      generations: [
        {
          generation: 1,
          intentId: 'intent-g1',
          sourceId: 'src-1',
          occurredAt: '2026-07-07T00:00:00Z',
          pipeline: 'claude',
          state: 'completed',
          attempt: { runId: 1, status: 'completed', conclusion: 'failure' },
        },
        {
          generation: 2,
          intentId: 'intent-g2',
          sourceId: 'src-1',
          occurredAt: '2026-07-07T01:00:00Z',
          pipeline: 'claude',
          state: 'completed',
          attempt: { runId: 2, status: 'completed', conclusion: 'success' },
        },
      ],
    });
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
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work).toHaveLength(1);
    expect(work[0].state).toBe('completed');
    expect(work[0].attempts.map((a) => a.id)).toEqual([1, 2]);
    expect(work[0].attempts[0].generation).toBe(1);
    expect(work[0].attempts[1].generation).toBe(2);
    expect(work[0].intents.map((i) => i.generation)).toEqual([1, 2]);
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
      ledgers: new Map(),
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
      ledgers: new Map(),
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
      ledgers: new Map(),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].anomalies).toEqual([]);
    expect(work[0].state).toBe('completed');
  });
});

describe('deriveLogicalWork - ledger-recorded anomalies (#364 review)', () => {
  it('surfaces a ledger-recorded duplicate-attempt anomaly even with no matching live runs', () => {
    const ledger = makeLedger({
      generations: [
        {
          generation: 1,
          intentId: 'intent-abc123',
          sourceId: 'src-1',
          occurredAt: '2026-07-07T00:00:00Z',
          pipeline: 'claude',
          state: 'completed',
          attempt: { runId: 555, status: 'completed', conclusion: 'success' },
        },
      ],
      anomalies: [
        {
          kind: 'duplicate-attempt',
          detail: { generation: 1, runIds: [555, 556] },
          occurredAt: '2026-07-07T00:05:00Z',
        },
      ],
    });

    // Neither duplicate run is still visible - both completed and aged out
    // of the recent-run window this render can see (or were never fetched
    // at all). The ledger is the only surviving evidence.
    const { work } = deriveLogicalWork({
      attempts: [],
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work).toHaveLength(1);
    expect(work[0].attempts).toEqual([]);
    const ledgerAnomalies = work[0].anomalies.filter(
      (a) => a.kind === 'ledger-recorded',
    );
    expect(ledgerAnomalies).toHaveLength(1);
    expect(ledgerAnomalies[0].detail).toContain('duplicate-attempt');
    expect(ledgerAnomalies[0].detail).toContain('555');
    expect(ledgerAnomalies[0].detail).toContain('556');
    expect(work[0].state).toBe('anomaly');
  });

  it('surfaces a ledger-recorded duplicate-attempt anomaly alongside genuinely live corroborating attempts too', () => {
    const ledger = makeLedger({
      anomalies: [
        {
          kind: 'duplicate-attempt',
          detail: { generation: 1, runIds: [1, 2] },
          occurredAt: '2026-07-07T00:05:00Z',
        },
      ],
    });
    const attempts = [
      makeRun({ id: 1, status: 'running' }),
      makeRun({ id: 2, status: 'queued' }),
    ];

    const { work } = deriveLogicalWork({
      attempts,
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].attempts).toHaveLength(2);
    expect(
      work[0].anomalies.some((a) => a.kind === 'duplicate-active-attempts'),
    ).toBe(true);
    expect(work[0].anomalies.some((a) => a.kind === 'ledger-recorded')).toBe(
      true,
    );
  });

  it('renders a generic message for a ledger anomaly kind this app does not specifically recognize', () => {
    const ledger = makeLedger({
      anomalies: [
        {
          kind: 'reconcile-missing-run',
          detail: { generation: 1, attempt: 2, ageMs: 900000 },
          occurredAt: '2026-07-07T00:05:00Z',
        },
      ],
    });

    const { work } = deriveLogicalWork({
      attempts: [],
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    const ledgerAnomalies = work[0].anomalies.filter(
      (a) => a.kind === 'ledger-recorded',
    );
    expect(ledgerAnomalies).toHaveLength(1);
    expect(ledgerAnomalies[0].detail).toContain('reconcile-missing-run');
  });

  it('adds no ledger-recorded anomalies for a clean ledger with an empty anomalies array', () => {
    const ledger = makeLedger({ anomalies: [] });
    const { work } = deriveLogicalWork({
      attempts: [makeRun()],
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });
    expect(work[0].anomalies).toEqual([]);
  });

  it('appends the #645 failure classification to a ledger anomaly, reusing formatFailure rather than re-deriving its layout', () => {
    const failure = classifyFailure({
      phase: 'reconciliation',
      owningSystem: 'controller',
      reason: 'launch_response_lost',
      retryDisposition: 'backoff',
      retryBudget: 1,
    });
    const ledger = makeLedger({
      anomalies: [
        {
          kind: 'reconcile-missing-run',
          detail: { generation: 1, attempt: 2, ageMs: 900000 },
          occurredAt: '2026-07-07T00:05:00Z',
          failure,
        },
      ],
    });

    const { work } = deriveLogicalWork({
      attempts: [],
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    const ledgerAnomalies = work[0].anomalies.filter(
      (a) => a.kind === 'ledger-recorded',
    );
    expect(ledgerAnomalies).toHaveLength(1);
    // Exact substring match against formatFailure's own output, not a
    // hand-written expectation of what that string looks like - this is
    // what would catch the two renderings drifting apart.
    expect(ledgerAnomalies[0].detail).toContain(formatFailure(failure));
  });

  it('renders a ledger anomaly with no failure classification exactly as it did before #645 (regression guard)', () => {
    // Every anomaly recorded by a pre-#645 broker has no `failure` field.
    // Appending anything here - even an empty suffix - for those would be a
    // visible, silent behavior change on every existing ledger.
    const withoutFailure = makeLedger({
      anomalies: [
        {
          kind: 'reconcile-missing-run',
          detail: { generation: 1, attempt: 2, ageMs: 900000 },
          occurredAt: '2026-07-07T00:05:00Z',
        },
      ],
    });
    const { work } = deriveLogicalWork({
      attempts: [],
      ledgers: new Map([[KEY, withoutFailure]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });
    expect(work[0].anomalies[0].detail).toBe(
      'The dispatch ledger recorded a "reconcile-missing-run" anomaly at 2026-07-07T00:05:00Z. {"generation":1,"attempt":2,"ageMs":900000}',
    );
  });

  it('degrades a malformed failure field to the plain anomaly message instead of crashing or rendering "undefined"', () => {
    // A hand-edited or foreign comment could carry any JSON under `failure`.
    // isWellFormedAnomaly (the shared read-side gate) only checks it's an
    // object; this is the stricter check that keeps a garbage object from
    // reaching formatFailure and interpolating "undefined" into the UI.
    const ledger = makeLedger({
      anomalies: [
        {
          kind: 'reconcile-parked',
          detail: { generation: 1, reason: 'missing-run-bound-exhausted' },
          occurredAt: '2026-07-07T00:05:00Z',
          failure: 'manual' as unknown as ReturnType<typeof classifyFailure>,
        },
      ],
    });
    const { work } = deriveLogicalWork({
      attempts: [],
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });
    const detail = work[0].anomalies[0].detail;
    expect(detail).toBe(
      'The dispatch ledger recorded a "reconcile-parked" anomaly at 2026-07-07T00:05:00Z. {"generation":1,"reason":"missing-run-bound-exhausted"}',
    );
    expect(detail).not.toContain('undefined');
  });
});

describe('deriveLogicalWork - attribution and mismatch anomalies', () => {
  it('attributes a marker attempt to the ledger only when the intent actually exists there', () => {
    const attempts = [
      makeRun({
        id: 1,
        status: 'running',
        displayTitle: '#42: Claude issue agent [dispatch:g9:intent-unknown]',
      }),
    ];
    const { work } = deriveLogicalWork({
      attempts,
      ledgers: new Map([[KEY, makeLedger()]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].attempts[0].attribution).toBe('run-marker');
    expect(
      work[0].anomalies.some((a) => a.kind === 'attempt-ledger-mismatch'),
    ).toBe(true);
  });

  it('falls back to legacy-title attribution for a pre-broker run with no marker', () => {
    const attempts = [makeRun({ id: 1, displayTitle: '#42: Fix the thing' })];
    const { work } = deriveLogicalWork({
      attempts,
      ledgers: new Map(),
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
      ledgers: new Map(),
      taskMeta: new Map(),
    });

    expect(work).toEqual([]);
    expect(unattributedAttempts).toHaveLength(1);
    expect(unattributedAttempts[0].attribution).toBe('unattributed');
  });
});

describe('deriveLogicalWork - attemptId (#645)', () => {
  it('falls back to formatAttemptId(generation) when the ledger predates the persisted field', () => {
    // makeLedger()'s default generation has an `attempt` with no
    // `attemptId` field, matching every generation dispatched before #645
    // added it - this is the "recompute, don't crash or omit" path.
    const { work } = deriveLogicalWork({
      attempts: [makeRun()],
      ledgers: new Map([[KEY, makeLedger()]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].attempts[0].attemptId).toBe('g1:intent-abc123');
  });

  it('prefers the ledger-persisted attempt.attemptId over recomputing it', () => {
    // Deliberately a different string than `formatAttemptId` would
    // recompute from generation/intentId, so the assertion can only pass by
    // actually reading the persisted field - proving preference, not just
    // coincidental agreement.
    const ledger = makeLedger({
      generations: [
        {
          generation: 1,
          intentId: 'intent-abc123',
          sourceId: 'src-1',
          occurredAt: '2026-07-07T00:00:00Z',
          pipeline: 'claude',
          mode: 'implement',
          state: 'active',
          attempt: {
            runId: 1,
            status: 'in_progress',
            attemptId: 'g1:intent-abc123-persisted',
          },
        },
      ],
    });

    const { work } = deriveLogicalWork({
      attempts: [makeRun()],
      ledgers: new Map([[KEY, ledger]]),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].attempts[0].attemptId).toBe('g1:intent-abc123-persisted');
  });

  it('derives attemptId from the run-marker alone when no ledger corroborates the attempt', () => {
    const attempts = [
      makeRun({
        id: 1,
        displayTitle: '#42: Claude issue agent [dispatch:g3:intent-xyz]',
      }),
    ];

    const { work } = deriveLogicalWork({
      attempts,
      ledgers: new Map(),
      taskMeta: new Map([[KEY, makeTaskMeta()]]),
    });

    expect(work[0].attempts[0].attribution).toBe('run-marker');
    expect(work[0].attempts[0].attemptId).toBe('g3:intent-xyz');
  });

  it('leaves attemptId undefined for a legacy-title attempt with no marker at all', () => {
    const attempts = [makeRun({ id: 1, displayTitle: '#42: Fix the thing' })];

    const { work } = deriveLogicalWork({
      attempts,
      ledgers: new Map(),
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
      ledgers: new Map(),
      taskMeta: new Map(),
    });

    expect(work).toHaveLength(2);
    expect(new Set(work.map((w) => w.task.repository.owner))).toEqual(
      new Set(['supersprinklesracing', 'org-b']),
    );
  });
});

describe('deriveLogicalWork - human-needed', () => {
  it('surfaces a maintainer-blocked task distinctly even with an active ledger generation', () => {
    const { work } = deriveLogicalWork({
      attempts: [makeRun()],
      ledgers: new Map([[KEY, makeLedger()]]),
      taskMeta: new Map([[KEY, makeTaskMeta({ humanNeeded: true })]]),
    });

    expect(work[0].state).toBe('human-needed');
  });
});

describe('ledgerAndTaskMetaFromItems', () => {
  it('keys both maps by repoItemKey in one pass, skipping the ledger map for items with no ledger', () => {
    const items = [
      {
        repo: REPO,
        number: 42,
        ledger: makeLedger(),
        title: 'A',
        url: 'https://x',
      },
      { repo: REPO, number: 43, title: 'B', url: 'https://y' },
    ];
    const { ledgers, taskMeta } = ledgerAndTaskMetaFromItems(items);

    expect(ledgers.size).toBe(1);
    expect(ledgers.has(KEY)).toBe(true);
    expect(taskMeta.size).toBe(2);
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
      ledgers: new Map(),
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
