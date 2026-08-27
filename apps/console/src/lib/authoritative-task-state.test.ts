import { MemoryStore, type Task } from '@agent-lcars/orchestrator';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { readAuthoritativeTaskState } from './authoritative-task-state';
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
  it("surfaces the task doc's work.spec when present", async () => {
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
          target: { repo: 'jlapenna/agent-lcars' },
        },
      },
    });

    const state = await readAuthoritativeTaskState({
      repository: 'jlapenna/agent-lcars',
      issue: 42,
    });

    expect(state?.spec).toEqual({
      title: 'T',
      description: 'D',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    });
  });

  it('omits spec when the task carries no work payload', async () => {
    await seedTask({
      task: { repo: 'jlapenna/agent-lcars', issue: 43 },
      runCount: 0,
      updatedAt: T0,
    });

    const state = await readAuthoritativeTaskState({
      repository: 'jlapenna/agent-lcars',
      issue: 43,
    });

    expect(state?.spec).toBeUndefined();
  });
});
