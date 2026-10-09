import {
  MemoryStore,
  Orchestrator,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { beforeEach, describe, expect, it } from 'vitest';

import { getNativeInboxCards } from './native-inbox';
import type { WorkPrincipal } from './work-auth';

const ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const operator: WorkPrincipal = {
  principal: 'user:operator',
  subject: 'github:operator',
  via: 'session',
  pipelines: ['claude'],
  scopes: new Set(['work.operator']),
};
const payload = {
  origin: { principal: 'user:operator', channel: 'console' as const },
  spec: {
    title: 'Choose storage',
    description: 'Store the result',
    pipeline: 'claude' as const,
    target: { repo: 'jlapenna/agent-lcars' },
  },
};

beforeEach(() => {
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
    'jlapenna/agent-lcars';
});

async function seed(
  store: MemoryStore,
  taskId: TaskId,
  summary: string,
  at: string,
) {
  const orchestrator = new Orchestrator(store, { now: () => at });
  const admitted = await orchestrator.request({
    taskId,
    requestId: JSON.stringify(taskId),
    pipeline: 'claude',
    work: payload,
  });
  if ('refused' in admitted) throw new Error(admitted.reason);
  await orchestrator.confirmDispatch(admitted.run.runId);
  await orchestrator.report(admitted.run.runId, {
    ok: true,
    summary,
    message: 'Which storage should I use?',
  });
  return orchestrator;
}

describe('native human decisions', () => {
  it('finds an older park past newer completed tasks, without duplicating GitHub parks or failures', async () => {
    const store = new MemoryStore();
    await seed(store, { workId: ID }, 'park', '2026-10-01T00:00:00Z');
    await seed(
      store,
      { repo: 'jlapenna/agent-lcars', issue: 2177 },
      'park',
      '2026-10-02T00:00:00Z',
    );
    await seed(
      store,
      { workId: 'failed-work' },
      'execution failure',
      '2026-10-02T00:00:00Z',
    );
    for (let issue = 1; issue <= 201; issue++) {
      await seed(
        store,
        { repo: 'jlapenna/agent-lcars', issue },
        'done',
        '2026-10-03T00:00:00Z',
      );
    }
    const cards = await getNativeInboxCards(store, operator);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      work: {
        id: `work:${ID}`,
        state: 'parked',
        runs: [{ result: { message: 'Which storage should I use?' } }],
      },
      canReply: true,
    });
  });

  it.each([
    undefined,
    { ...operator, scopes: new Set() },
    { ...operator, pipelines: ['codex'] },
  ])(
    'shows the question but withholds Reply without the operator and pipeline grant (%j)',
    async (principal) => {
      const store = new MemoryStore();
      await seed(store, { workId: ID }, 'park', '2026-10-01T00:00:00Z');
      expect((await getNativeInboxCards(store, principal))[0]?.canReply).toBe(
        false,
      );
    },
  );

  it('keeps a selected conversation visible after admission but removes it from human decisions', async () => {
    const store = new MemoryStore();
    const orchestrator = await seed(
      store,
      { workId: ID },
      'park',
      '2026-10-01T00:00:00Z',
    );
    await orchestrator.request({
      taskId: { workId: ID },
      requestId: 'reply',
      pipeline: 'claude',
    });
    expect(await getNativeInboxCards(store, operator)).toEqual([]);
    expect(
      (await getNativeInboxCards(store, operator, `work:${ID}`))[0],
    ).toMatchObject({
      work: { id: `work:${ID}`, state: 'running' },
      canReply: false,
    });
  });
});
