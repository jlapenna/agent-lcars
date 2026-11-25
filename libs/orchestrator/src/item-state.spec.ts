import { describe, expect, it } from 'vitest';

import { taskDerivedFrom } from './item-state';
import type { Run, Task } from './model';

const UPDATED = '2026-11-25T12:00:00.000Z';
const WORK_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const revision = {
  key: 'k',
  input: { agent: 'jlapenna/homelab/investigator', message: 'why?' },
};

function run(state: Run['state'], extra: Partial<Run> = {}): Run {
  return {
    runId: `work:${WORK_ID}/r1`,
    task: { workId: WORK_ID },
    state,
    pipeline: 'claude',
    requestId: 'r1',
    requestSource: 'caller',
    leaseExpiresAt: UPDATED,
    events: [],
    createdAt: UPDATED,
    updatedAt: UPDATED,
    ...extra,
  };
}

const task: Pick<
  Task,
  'closedAt' | 'consecutiveLost' | 'delivery' | 'desiredRevision' | 'updatedAt'
> = { consecutiveLost: 0, updatedAt: UPDATED };

describe('taskDerivedFrom sort keys', () => {
  it.each([
    ['parked', run('finished', { result: { ok: true, summary: 'park' } })],
    ['failed', run('finished', { result: { ok: false } })],
  ])('stamps a %s task with stoppedAt', (state, latest) => {
    expect(taskDerivedFrom(task, [latest])).toEqual({
      state,
      latestRunId: latest.runId,
      event: false,
      stoppedAt: UPDATED,
    });
  });

  it('leaves stoppedAt off running and finished tasks', () => {
    expect(taskDerivedFrom(task, [run('running')])).not.toHaveProperty(
      'stoppedAt',
    );
    expect(
      taskDerivedFrom(task, [run('finished', { result: { ok: true } })]),
    ).not.toHaveProperty('stoppedAt');
  });

  it('stamps event work with eventAt, and only event work', () => {
    const event = run('running', { sourceRevision: revision });
    expect(
      taskDerivedFrom({ ...task, desiredRevision: revision }, [event]),
    ).toMatchObject({ event: true, eventAt: UPDATED });
    expect(taskDerivedFrom(task, [run('running')])).not.toHaveProperty(
      'eventAt',
    );
  });
});
