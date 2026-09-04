// @vitest-environment node

import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
  type Run,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import type { DispatchTokenProvider } from './github-app-tokens';
import { drainOutbox, outcomeCommentBody } from './orchestrator-dispatch';

const TASK: TaskId = { repo: 'octo/example', issue: 7 };
const NOW = '2026-08-29T12:00:00.000Z';
const tokens: DispatchTokenProvider = { tokenFor: async () => 'test-token' };

function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  return { store, orchestrator };
}

async function requested(orchestrator: Orchestrator, taskId = TASK) {
  const outcome = await orchestrator.request({
    taskId,
    requestId: 'request-1',
    pipeline: 'codex',
    work: {
      origin: { principal: 'test:orchestrator-dispatch', channel: 'api' },
      spec: {
        title: 'Dispatch test work',
        description: 'Current Work payload for the dispatch test.',
        pipeline: 'codex',
        target:
          'repo' in taskId ? { repo: taskId.repo } : { workId: taskId.workId },
      },
    },
  });
  if (isRefusal(outcome)) {
    throw new Error(`unexpected refusal: ${outcome.reason}`);
  }
  return decidedRun(outcome);
}

describe('drainOutbox QueueExecutor dispatch', () => {
  it('enqueues every admitted provider run without a GitHub Actions workflow dispatch', async () => {
    const { store, orchestrator } = fixture();
    const run = await requested(orchestrator);
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ assignees: [{ login: 'agent-lcars-bot' }] }),
        { status: 201 },
      );
    }) as typeof fetch;

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    expect(result.dispatched).toEqual([run.runId]);
    expect(calls).toEqual([
      'https://api.github.com/repos/octo/example/issues/7/reactions',
      'https://api.github.com/repos/octo/example/issues/7/assignees',
    ]);
    expect(calls.some((url) => url.includes('/actions/workflows/'))).toBe(
      false,
    );
    expect((await store.readRun(run.runId))?.queue).toMatchObject({
      state: 'queued',
    });
    expect((await store.readRun(run.runId))?.state).toBe('running');
  });

  it('enqueues a native work run without calling GitHub', async () => {
    const { store, orchestrator } = fixture();
    const run = await requested(orchestrator, {
      workId: '01J5Z3K9QX8F0N2B4V6C8D1E4H',
    });
    const fetchImpl = vi.fn() as typeof fetch;

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    expect(result.dispatched).toEqual([run.runId]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await store.readRun(run.runId))?.queue).toMatchObject({
      state: 'queued',
    });
  });
});

/** A minimal, valid `Run`, none of `outcomeCommentBody`'s callers'
 *  machinery -- it is a pure function of a `Run`, so this fixture skips
 *  the orchestrator entirely. */
function run(over: Partial<Run> = {}): Run {
  return {
    runId: `${TASK.repo}#${TASK.issue}/r1`,
    task: TASK,
    state: 'finished',
    pipeline: 'claude',
    requestId: 'r1',
    requestSource: 'caller',
    events: [],
    leaseExpiresAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('outcomeCommentBody', () => {
  it('includes the agent final message on a parked run', () => {
    const body = outcomeCommentBody(
      run({
        state: 'finished',
        result: {
          ok: true,
          summary: 'park',
          message: 'Which database should I use?',
        },
      }),
    );
    expect(body).toContain('Which database should I use?');
    expect(body).toContain('Parked');
  });

  it('is unchanged for a parked run that reported no message', () => {
    const body = outcomeCommentBody(
      run({ state: 'finished', result: { ok: true, summary: 'park' } }),
    );
    expect(body).toContain("see this run's own comment above");
  });
});
