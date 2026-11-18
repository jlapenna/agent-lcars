import type { RunEvidence } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Run } from './model';
import { withRunEvidence } from './run-evidence';

const evidence: RunEvidence = {
  source: 'acp',
  harness: 'openclaw',
  toolCallCount: 0,
  toolCalls: [],
  recordedAt: '2026-08-26T10:00:00.000Z',
};
const claimed = (runId: string): Pick<Run, 'runId' | 'queue'> => ({
  runId,
  queue: { state: 'claimed', tokenHash: 'a'.repeat(64) } as Run['queue'],
});
const views = [{ runId: 'r1' }, { runId: 'r2' }];

describe('withRunEvidence', () => {
  it('adds each run its own record and leaves the others as they were', async () => {
    const readRunEvidence = vi.fn(async () => new Map([['r2', evidence]]));
    expect(
      await withRunEvidence({ readRunEvidence }, views, [
        claimed('r1'),
        claimed('r2'),
      ]),
    ).toEqual([{ runId: 'r1' }, { runId: 'r2', evidence }]);
  });

  it('asks nothing for runs that were never claimed', async () => {
    const readRunEvidence = vi.fn(async () => new Map<string, RunEvidence>());
    expect(
      await withRunEvidence({ readRunEvidence }, views, [
        { runId: 'r1' },
        { runId: 'r2', queue: undefined },
      ]),
    ).toEqual(views);
    expect(readRunEvidence).not.toHaveBeenCalled();
  });

  it('serves the item without evidence when the lookup does not answer in time', async () => {
    // A read that never returns, as a stalled RPC would not for minutes.
    const readRunEvidence = vi.fn(
      () => new Promise<Map<string, RunEvidence>>(() => undefined),
    );
    const unreadable = vi.fn();
    const began = Date.now();
    expect(
      await withRunEvidence(
        { readRunEvidence },
        views,
        [claimed('r1'), claimed('r2')],
        unreadable,
        50,
      ),
    ).toEqual(views);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(String(unreadable.mock.calls[0]?.[0])).toContain('50 ms');
  });

  it('serves the item without evidence when the lookup fails', async () => {
    const unreadable = vi.fn();
    expect(
      await withRunEvidence(
        {
          readRunEvidence: async () => {
            throw new Error('unavailable');
          },
        },
        views,
        [claimed('r1')],
        unreadable,
      ),
    ).toEqual(views);
    expect(unreadable).toHaveBeenCalledOnce();
  });
});
