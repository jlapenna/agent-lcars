import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal, requestRun } from './decide';
import { type QueuePriority, type Run, runSchema } from './model';
import {
  queuePriorityCursorSchema,
  queuePriorityTurnAfter,
  selectFairQueuedRun,
} from './store';

const NOW = '2026-10-10T00:00:00.000Z';
function queued(
  issue: number,
  priority: QueuePriority = 'normal',
  pipeline = 'claude',
): Run {
  const decision = requestRun({
    now: new Date(Date.parse(NOW) + issue * 1000).toISOString(),
    taskId: { repo: 'octo/example', issue },
    task: undefined,
    activeRun: undefined,
    requestId: `priority-${issue}`,
    pipeline,
    priority,
    work: { spec: { title: 'priority contract' } },
  });
  if (isRefusal(decision)) throw new Error('unexpected refusal');
  return { ...decidedRun(decision), queue: { state: 'queued' } };
}

describe('priority inside provider-fair selection', () => {
  it('decodes pre-priority run history as normal and rejects unknown priorities', () => {
    const old = queued(1);
    delete old.priority;
    expect(runSchema.parse(old).priority).toBe('normal');
    expect(() =>
      runSchema.parse({ ...old, priority: 'superurgent' }),
    ).toThrow();
    expect(() => queuePriorityCursorSchema.parse({ position: 7 })).toThrow();
  });

  it('preserves FIFO for absent and explicit normal history', () => {
    const old = queued(1);
    delete old.priority;
    expect(selectFairQueuedRun([queued(2), old], [], ['claude'])?.runId).toBe(
      old.runId,
    );
  });

  it('admits urgent work ahead of older normal/background work on its turn', () => {
    const urgent = queued(3, 'urgent');
    expect(
      selectFairQueuedRun(
        [queued(1, 'background'), queued(2), urgent],
        [],
        ['claude'],
      )?.runId,
    ).toBe(urgent.runId);
  });

  it('preserves historical lexical run-ID ties within normal FIFO', () => {
    const dash = { ...queued(1), runId: 'octo/a-a#1/r1' };
    delete dash.priority;
    const underscore = { ...queued(1), runId: 'octo/a_a#1/r1' };
    expect(selectFairQueuedRun([underscore, dash], [], ['claude'])?.runId).toBe(
      dash.runId,
    );
  });

  it('provides 4:2:1 service, class FIFO, and a seven-claim background-head bound under persistent urgent demand', () => {
    const pending = Array.from({ length: 10 }, (_, index) => [
      queued(index + 1, 'background'),
      queued(index + 101, 'normal'),
      queued(index + 201, 'urgent'),
    ]).flat();
    const positions = new Map<string, number>();
    const served: Run[] = [];
    for (let index = 0; index < 14; index++) {
      const run = selectFairQueuedRun(
        pending,
        [],
        ['claude'],
        undefined,
        positions,
      );
      if (!run) throw new Error('expected a claim candidate');
      served.push(run);
      positions.set(
        'claude',
        queuePriorityTurnAfter(
          positions.get('claude') ?? 0,
          run.priority ?? 'normal',
        ),
      );
      pending.splice(
        pending.findIndex((candidate) => candidate.runId === run.runId),
        1,
      );
    }
    expect(served.map((run) => run.priority)).toEqual([
      'urgent',
      'urgent',
      'normal',
      'urgent',
      'urgent',
      'normal',
      'background',
      'urgent',
      'urgent',
      'normal',
      'urgent',
      'urgent',
      'normal',
      'background',
    ]);
    expect(
      served
        .filter((run) => run.priority === 'background')
        .map((run) => run.task),
    ).toEqual([
      { repo: 'octo/example', issue: 1 },
      { repo: 'octo/example', issue: 2 },
    ]);
  });

  it('keeps provider fairness independent of urgent class and honors ceilings', () => {
    const olderProvider = queued(1, 'background');
    const urgentCodex = queued(2, 'urgent', 'codex');
    expect(
      selectFairQueuedRun([urgentCodex, olderProvider], [], ['codex', 'claude'])
        ?.runId,
    ).toBe(olderProvider.runId);
    const occupied = {
      ...queued(3, 'normal', 'codex'),
      queue: { state: 'claimed' as const },
    };
    expect(
      selectFairQueuedRun([urgentCodex], [occupied], ['codex']),
    ).toBeUndefined();
  });

  it('skips deferred work and unavailable classes without advancing on empty polls', () => {
    const urgent = {
      ...queued(1, 'urgent'),
      queue: {
        state: 'queued' as const,
        deferredUntil: '2026-10-11T00:00:00.000Z',
      },
    };
    const normal = queued(2);
    const positions = new Map([['claude', 0]]);
    expect(
      selectFairQueuedRun([urgent, normal], [], ['claude'], NOW, positions)
        ?.runId,
    ).toBe(normal.runId);
    expect(
      selectFairQueuedRun([urgent], [], ['claude'], NOW, positions),
    ).toBeUndefined();
    expect(positions.get('claude')).toBe(0);
  });
});
