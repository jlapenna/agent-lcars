import { logger } from '@agent-lcars/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  labelStoreReads,
  recordRead,
  report,
  withReadLabel,
} from './read-accounting';

describe('read accounting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('totals reads by operation and collection and logs the largest first', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    withReadLabel('listNativeTasks', () => {
      recordRead('orchestrator-tasks', 400);
      // A nested label keeps the outer operation.
      withReadLabel('readTask', () => recordRead('orchestrator-tasks', 1));
    });
    recordRead('sessions', 3);

    report();

    expect(info).toHaveBeenCalledOnce();
    const [message, fields] = info.mock.calls[0]!;
    expect(message).toBe('agent-lcars: firestore read accounting');
    expect(fields).toEqual({
      windowMinutes: 5,
      totalDocs: 404,
      reads: {
        'listNativeTasks orchestrator-tasks': { calls: 2, docs: 401 },
        'direct sessions': { calls: 1, docs: 3 },
      },
    });

    // Each window starts empty, and an empty window logs nothing.
    report();
    expect(info).toHaveBeenCalledOnce();
  });

  it('labels a store method’s reads with its name without changing its result', async () => {
    class Store {
      #secret = 7;
      async listThings(n: number) {
        recordRead('things', n);
        return this.#secret + n;
      }
    }
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const store = labelStoreReads(new Store());

    expect(await store.listThings(2)).toBe(9);
    report();

    expect(info.mock.calls[0]![1]).toMatchObject({
      reads: { 'listThings things': { calls: 1, docs: 2 } },
    });
  });
});
