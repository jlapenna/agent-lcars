import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import type { CliSessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { loadSpendProjections } from './session-spend-projections';

function doc(prNumbers: number[]): CliSessionDoc {
  return {
    sessionId: 's',
    source: 'cli',
    agent: 'codex',
    repo: { owner: 'jlapenna', name: 'agent-lcars' },
    liveness: 'ended',
    startedAt: '',
    lastActivityAt: '',
    turns: 0,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers, commitShas: [] },
  };
}

describe('stored spend evidence boundary', () => {
  it('deduplicates qualified identities, caps reads and reports missing evidence', async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    const result = await loadSpendProjections(
      [doc(Array.from({ length: 205 }, (_, i) => i + 1)), doc([1, 2, 2])],
      read,
    );
    expect(read).toHaveBeenCalledTimes(200);
    expect(read).toHaveBeenCalledWith({
      repo: 'jlapenna/agent-lcars',
      issue: 1,
    });
    expect(result.incomplete).toBe(true);
    expect(result.projections.size).toBe(0);
  });
  it('limits outstanding reads and degrades failed lookups independently', async () => {
    let outstanding = 0,
      max = 0;
    const read = async () => {
      outstanding++;
      max = Math.max(max, outstanding);
      await new Promise((resolve) => setTimeout(resolve, 1));
      outstanding--;
      throw new Error('store unavailable');
    };
    expect(
      (
        await loadSpendProjections(
          [doc(Array.from({ length: 20 }, (_, i) => i + 1))],
          read,
        )
      ).incomplete,
    ).toBe(true);
    expect(max).toBe(8);
  });
  it('bounds a hung store and late completion cannot mutate the returned snapshot', async () => {
    let resolve!: (p: GithubAnchorProjection) => void;
    const read = vi.fn(
      () =>
        new Promise<GithubAnchorProjection>((done) => {
          resolve = done;
        }),
    );
    const result = await loadSpendProjections([doc([1])], read, 10);
    expect(result.incomplete).toBe(true);
    resolve({
      anchor: { repo: 'jlapenna/agent-lcars', issue: 1 },
    } as GithubAnchorProjection);
    await Promise.resolve();
    expect(result.projections.size).toBe(0);
  });
});
