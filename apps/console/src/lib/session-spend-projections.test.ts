import {
  type GithubAnchorProjection,
  MemoryStore,
} from '@agent-lcars/orchestrator';
import type { CliSessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { aggregateSessionSpend } from './session-spend';
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
    deliverables: {
      prNumbers,
      qualifiedPRs: prNumbers.map((number) => ({
        repo: { owner: 'jlapenna', name: 'agent-lcars' },
        number,
      })),
      commitShas: [],
    },
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

describe('canonical stored projection identities (#2303)', () => {
  it('reads canonical mixed-case keys while deduplicating case-insensitive identities', async () => {
    const store = new MemoryStore();
    const anchor = { repo: 'Acme/Other-Project', issue: 42 };
    const timestamp = '2026-10-01T00:00:00.000Z';
    const projection: GithubAnchorProjection = {
      anchor,
      kind: 'pr',
      state: 'closed',
      title: 'merged',
      body: '',
      url: 'https://github.com/Acme/Other-Project/pull/42',
      labels: [],
      assigneeLogins: [],
      sourceUpdatedAt: timestamp,
      observedAt: timestamp,
      mergedAt: timestamp,
    };
    const generation = await store.beginGithubAnchorProjectionRefresh(anchor);
    await store.applyGithubAnchorProjectionRefresh({
      anchor,
      generation,
      projection,
    });
    const session = {
      ...doc([42]),
      deliverables: {
        prNumbers: [42],
        commitShas: [],
        qualifiedPRs: [
          { repo: { owner: 'Acme', name: 'Other-Project' }, number: 42 },
          { repo: { owner: 'acme', name: 'other-project' }, number: 42 },
        ],
      },
    };
    const read = vi.fn((target) => store.readGithubAnchorProjection(target));
    const loaded = await loadSpendProjections([session], read, 5000, [
      { owner: 'Acme', name: 'Other-Project' },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(anchor);
    expect(aggregateSessionSpend([session], loaded.projections).mergedPRs).toBe(
      1,
    );
    const canonicalSession = {
      ...session,
      deliverables: {
        ...session.deliverables,
        qualifiedPRs: session.deliverables.qualifiedPRs.slice(0, 1),
      },
    };
    expect(
      aggregateSessionSpend(
        [canonicalSession],
        (
          await loadSpendProjections([canonicalSession], (target) =>
            store.readGithubAnchorProjection(target),
          )
        ).projections,
      ).mergedPRs,
    ).toBe(1);
  });
});
