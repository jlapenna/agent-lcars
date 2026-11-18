import { MemoryStore, type Task } from '@agent-lcars/orchestrator';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  readAuthoritativeTaskState,
  readAuthoritativeTaskStates,
} from './authoritative-task-state';
import { createOrchestratorRuntime } from './orchestrator-runtime';

const T0 = '2026-08-15T12:00:00.000Z';

// Same mock-the-runtime-module pattern as backend-actions.test.ts's own
// `fixtureOrchestratorRuntime` -- `readAuthoritativeTaskState` resolves its
// store via `createOrchestratorRuntime()` rather than taking one as an
// argument, so a real `FirestoreStore` (which needs `PROJECT_ID`/
// `DISPATCH_FIRESTORE_DATABASE_ID`) never gets constructed here.
vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: vi.fn(),
}));

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  (createOrchestratorRuntime as Mock).mockReturnValue({ store });
});

/** `MemoryStore` has no direct "seed a task doc" method -- only `apply`
 * (compare-and-set over a full `Decision`, same as production writes go
 * through). `expectedRevision: undefined` matches a brand-new task, exactly
 * as `MemoryStore.apply`'s own conflict check expects for a key it has
 * never seen. */
async function seedTask(task: Task) {
  await store.apply({
    decision: { task, outbox: [] },
    expectedRevision: undefined,
  });
}

describe('readAuthoritativeTaskState', () => {
  it.each([
    [undefined, 'normal'],
    ['normal', 'normal'],
    ['urgent', 'urgent'],
    ['background', 'background'],
  ] as const)(
    'surfaces durable Work with priority %s as %s without rewriting storage',
    async (priority, expectedPriority) => {
      await seedTask({
        task: { repo: 'jlapenna/agent-lcars', issue: 42 },
        runCount: 0,
        updatedAt: T0,
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'T',
            description: 'D',
            pipeline: 'claude',
            ...(priority === undefined ? {} : { priority }),
            target: { repo: 'jlapenna/agent-lcars' },
          },
        },
      });

      const before = structuredClone(
        await store.readTask({
          repo: 'jlapenna/agent-lcars',
          issue: 42,
        }),
      );
      const state = await readAuthoritativeTaskState({
        repository: 'jlapenna/agent-lcars',
        issue: 42,
      });

      expect(state?.spec).toEqual({
        title: 'T',
        description: 'D',
        pipeline: 'claude',
        priority: expectedPriority,
        target: { repo: 'jlapenna/agent-lcars' },
      });
      expect(
        await store.readTask({ repo: 'jlapenna/agent-lcars', issue: 42 }),
      ).toEqual(before);
    },
  );

  it('rejects a task with no immutable Work payload', async () => {
    await seedTask({
      task: { repo: 'jlapenna/agent-lcars', issue: 43 },
      runCount: 0,
      updatedAt: T0,
    });

    await expect(
      readAuthoritativeTaskState({
        repository: 'jlapenna/agent-lcars',
        issue: 43,
      }),
    ).rejects.toThrow();
  });

  it('rejects recipe Work with a coding-only precondition, not a schema error', async () => {
    await seedTask({
      task: { repo: 'jlapenna/agent-lcars', issue: 43 },
      runCount: 0,
      updatedAt: T0,
      work: {
        origin: { principal: 'svc:jobs', channel: 'cron' },
        spec: {
          title: 'T',
          description: 'D',
          pipeline: 'goose',
          priority: 'background',
          target: { repo: 'jlapenna/agent-lcars' },
          jobOccurrence: 'a'.repeat(64),
        },
      },
    });

    await expect(
      readAuthoritativeTaskState({
        repository: 'jlapenna/agent-lcars',
        issue: 43,
      }),
    ).rejects.toThrow('requires coding Work');
  });
});

function codingTask(issue: number): Task {
  return {
    task: { repo: 'jlapenna/agent-lcars', issue },
    runCount: 0,
    updatedAt: T0,
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: `T${issue}`,
        description: 'D',
        pipeline: 'claude',
        target: { repo: 'jlapenna/agent-lcars' },
      },
    },
  };
}

const ref = (issueNumber: number) => ({
  repository: { owner: 'jlapenna', name: 'agent-lcars' },
  issueNumber,
});

describe('readAuthoritativeTaskStates', () => {
  it('reads the set in one batched pass, leaving a missing task absent rather than unavailable', async () => {
    await seedTask(codingTask(1));
    await seedTask(codingTask(2));
    const listRuns = vi.spyOn(store, 'listRuns');
    const readTask = vi.spyOn(store, 'readTask');

    const result = await readAuthoritativeTaskStates([
      ref(1),
      ref(2),
      ref(1),
      ref(99),
    ]);

    expect([...result.states.keys()].sort()).toEqual([
      'jlapenna/agent-lcars#1',
      'jlapenna/agent-lcars#2',
    ]);
    expect(result.states.get('jlapenna/agent-lcars#1')?.runs).toEqual([]);
    expect(result.states.get('jlapenna/agent-lcars#2')?.spec.title).toBe('T2');
    expect(result.unavailableTaskKeys.size).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(listRuns).not.toHaveBeenCalled();
    expect(readTask).not.toHaveBeenCalled();
  });

  it('marks only a task without coding Work unavailable', async () => {
    await seedTask(codingTask(1));
    await seedTask({
      task: { repo: 'jlapenna/agent-lcars', issue: 3 },
      runCount: 0,
      updatedAt: T0,
    });

    const result = await readAuthoritativeTaskStates([ref(1), ref(3)]);

    expect([...result.states.keys()]).toEqual(['jlapenna/agent-lcars#1']);
    expect([...result.unavailableTaskKeys]).toEqual(['jlapenna/agent-lcars#3']);
  });

  it('treats a run map missing a requested task as unavailable, not as no runs', async () => {
    await seedTask(codingTask(1));
    vi.spyOn(store, 'listRunsForTasks').mockResolvedValue(new Map());

    const result = await readAuthoritativeTaskStates([ref(1)]);

    expect(result.states.size).toBe(0);
    expect([...result.unavailableTaskKeys]).toEqual(['jlapenna/agent-lcars#1']);
  });

  it('falls back to per-task reads when the batched read fails, isolating the failing task', async () => {
    await seedTask(codingTask(1));
    await seedTask(codingTask(2));
    vi.spyOn(store, 'readTasks').mockRejectedValue(new Error('corrupt doc'));
    const listRuns = store.listRuns.bind(store);
    vi.spyOn(store, 'listRuns').mockImplementation(async (id) => {
      if ('issue' in id && id.issue === 2) throw new Error('corrupt run');
      return listRuns(id);
    });

    const result = await readAuthoritativeTaskStates([ref(1), ref(2)]);

    expect([...result.states.keys()]).toEqual(['jlapenna/agent-lcars#1']);
    expect([...result.unavailableTaskKeys]).toEqual(['jlapenna/agent-lcars#2']);
    expect(result.warnings).toEqual([
      'Authoritative lifecycle state unavailable for jlapenna/agent-lcars#2.',
    ]);
  });
});
