import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import type { WorkPayload } from '@agent-lcars/work';
import { describe, expect, it, vi } from 'vitest';

import { admitGithubWork } from './github-work-admission';

const REPO = 'jlapenna/agent-lcars';
const ANCHOR = { repo: REPO, issue: 1630 };

function work(
  pipeline: 'claude' | 'codex' | 'opencode' = 'claude',
): WorkPayload {
  return {
    origin: { principal: 'github:jlapenna', channel: 'github' },
    spec: {
      title: 'Unify GitHub work admission',
      description: 'Use one server-owned admission boundary.',
      pipeline,
      target: { repo: REPO },
    },
  };
}

function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => '2026-08-31T00:00:00.000Z',
  });
  const drain = vi.fn().mockImplementation(async () => ({
    dispatched: [`${REPO}#${ANCHOR.issue}/r1`],
    reported: [],
    failed: [],
  }));
  return { store, orchestrator, drain };
}

describe('admitGithubWork', () => {
  it('normalizes, accepts, and drains one GitHub anchor request', async () => {
    const runtime = fixture();

    await expect(
      admitGithubWork(runtime, {
        anchor: ANCHOR,
        requestId: 'delivery-1',
        params: { mode: 'implement' },
        work: work(),
      }),
    ).resolves.toEqual({
      kind: 'accepted',
      runId: `${REPO}#${ANCHOR.issue}/r1`,
      dispatched: true,
    });
    expect(runtime.drain).toHaveBeenCalledOnce();
  });

  it('rejects a Work target that differs from its GitHub anchor before requesting', async () => {
    const runtime = fixture();

    await expect(
      admitGithubWork(runtime, {
        anchor: ANCHOR,
        requestId: 'bad-target',
        params: { mode: 'implement' },
        work: {
          ...work(),
          spec: { ...work().spec, target: { repo: 'octo/example' } },
        },
      }),
    ).resolves.toMatchObject({ kind: 'invalid' });
    expect(await runtime.store.listRuns(ANCHOR)).toEqual([]);
    expect(runtime.drain).not.toHaveBeenCalled();
  });

  it('enforces signed source-repository and ordinary pipeline grants', async () => {
    const runtime = fixture();
    const authorized = {
      grantsPrincipal: {
        principal: 'github-actions:jlapenna/agent-lcars',
        pipelines: ['claude'],
      },
    };

    await expect(
      admitGithubWork(runtime, {
        anchor: ANCHOR,
        requestId: 'foreign-source',
        params: { mode: 'implement' },
        work: work(),
        authorization: {
          ...authorized,
          sourceRepository: 'other-org/other-repo',
        },
      }),
    ).resolves.toMatchObject({ kind: 'forbidden' });
    await expect(
      admitGithubWork(runtime, {
        anchor: ANCHOR,
        requestId: 'denied-pipeline',
        params: { mode: 'implement' },
        work: work('codex'),
        authorization: authorized,
      }),
    ).resolves.toMatchObject({ kind: 'forbidden' });
    expect(await runtime.store.listRuns(ANCHOR)).toEqual([]);
  });

  it('maps idempotent replays and a competing request without draining again', async () => {
    const runtime = fixture();
    const input = {
      anchor: ANCHOR,
      requestId: 'delivery-1',
      params: { mode: 'implement' },
      work: work(),
    };
    await admitGithubWork(runtime, input);

    await expect(admitGithubWork(runtime, input)).resolves.toEqual({
      kind: 'duplicate',
      runId: `${REPO}#${ANCHOR.issue}/r1`,
    });
    await expect(
      admitGithubWork(runtime, { ...input, requestId: 'delivery-2' }),
    ).resolves.toEqual({ kind: 'busy', runId: `${REPO}#${ANCHOR.issue}/r1` });
    expect(runtime.drain).toHaveBeenCalledOnce();
  });

  it('refuses a changed specification after the GitHub Task is settled', async () => {
    const runtime = fixture();
    const input = {
      anchor: ANCHOR,
      requestId: 'delivery-1',
      params: { mode: 'implement' },
      work: work(),
    };
    const first = await admitGithubWork(runtime, input);
    if (first.kind !== 'accepted') throw new Error('first admission failed');
    await runtime.orchestrator.report(first.runId, { ok: true });

    await expect(
      admitGithubWork(runtime, {
        ...input,
        requestId: 'delivery-2',
        work: work('codex'),
      }),
    ).resolves.toEqual({
      kind: 'conflict',
      message: 'GitHub Work specification is immutable once admitted',
    });
    expect(await runtime.store.listRuns(ANCHOR)).toHaveLength(1);
    expect(runtime.drain).toHaveBeenCalledOnce();
  });
});
