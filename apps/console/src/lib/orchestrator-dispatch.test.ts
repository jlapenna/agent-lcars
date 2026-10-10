// @vitest-environment node

import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
  type Run,
  type TaskId,
} from '@agent-lcars/orchestrator';
import type { WorkOrigin } from '@agent-lcars/work';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

/** Requests a native work item carrying the given origin, for the
 *  native-outcome-webhook tests below -- `requested()` above always uses a
 *  fixed `{ principal, channel: 'api' }` origin, which can't carry a
 *  thread. */
async function requestedWithOrigin(
  orchestrator: Orchestrator,
  origin: WorkOrigin,
  workId = '01J5Z3K9QX8F0N2B4V6C8D1E4H',
) {
  const outcome = await orchestrator.request({
    taskId: { workId },
    requestId: 'request-1',
    pipeline: 'codex',
    work: {
      origin,
      spec: {
        title: 'Dispatch test work',
        description: 'Current Work payload for the dispatch test.',
        pipeline: 'codex',
        target: { repo: 'octo/example' },
      },
    },
  });
  if (isRefusal(outcome)) {
    throw new Error(`unexpected refusal: ${outcome.reason}`);
  }
  return decidedRun(outcome);
}

describe('drainOutbox native outcome webhook delivery', () => {
  const THREAD = 'T0123/C0456/1788673935.123456';
  const SLACK_TARGET = {
    url: 'https://bot.example/outcome',
    audience: 'sprinkles-lcars-bot',
  };

  afterEach(() => {
    delete process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'];
  });

  it('delivers the outcome webhook for a slack-origin item with a thread', async () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      slack: SLACK_TARGET,
    });
    const { store, orchestrator } = fixture();
    const run = await requestedWithOrigin(orchestrator, {
      principal: 'svc:sprinkles-lcars-bot',
      channel: 'slack',
      thread: THREAD,
    });
    await orchestrator.report(run.runId, {
      ok: true,
      summary: 'park',
      message: 'Which database should I use?',
    });

    const deliverOutcomeWebhook = vi.fn().mockResolvedValue(undefined);
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: vi.fn() as typeof fetch,
      deliverOutcomeWebhook,
    });

    expect(result.reported).toEqual([run.runId]);
    expect(deliverOutcomeWebhook).toHaveBeenCalledTimes(1);
    expect(deliverOutcomeWebhook).toHaveBeenCalledWith(SLACK_TARGET, {
      itemId: '01J5Z3K9QX8F0N2B4V6C8D1E4H',
      runId: run.runId,
      state: 'finished',
      ok: true,
      parked: true,
      message: 'Which database should I use?',
      thread: THREAD,
      consoleUrl: 'https://lcars.jlapenna.net/work/01J5Z3K9QX8F0N2B4V6C8D1E4H',
    });
  });

  it('does not deliver when the origin has no thread', async () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      slack: SLACK_TARGET,
    });
    const { store, orchestrator } = fixture();
    const run = await requestedWithOrigin(orchestrator, {
      principal: 'svc:sprinkles-lcars-bot',
      channel: 'slack',
    });
    await orchestrator.report(run.runId, { ok: true, summary: 'park' });

    const deliverOutcomeWebhook = vi.fn();
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: vi.fn() as typeof fetch,
      deliverOutcomeWebhook,
    });

    expect(deliverOutcomeWebhook).not.toHaveBeenCalled();
  });

  it('does not deliver when no webhook target is configured for the channel', async () => {
    // AGENT_LCARS_OUTCOME_WEBHOOKS deliberately left unset.
    const { store, orchestrator } = fixture();
    const run = await requestedWithOrigin(orchestrator, {
      principal: 'svc:sprinkles-lcars-bot',
      channel: 'slack',
      thread: THREAD,
    });
    await orchestrator.report(run.runId, { ok: true, summary: 'park' });

    const deliverOutcomeWebhook = vi.fn();
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: vi.fn() as typeof fetch,
      deliverOutcomeWebhook,
    });

    expect(deliverOutcomeWebhook).not.toHaveBeenCalled();
  });

  it('keeps posting a GitHub anchor outcome comment and never attempts a webhook, even when one is configured for it', async () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      github: SLACK_TARGET,
    });
    const { store, orchestrator } = fixture();
    const run = await requested(orchestrator);
    await orchestrator.report(run.runId, { ok: true });

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const deliverOutcomeWebhook = vi.fn();

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      deliverOutcomeWebhook,
      now: () => NOW,
    });

    expect(deliverOutcomeWebhook).not.toHaveBeenCalled();
    expect(result.reported).toEqual([run.runId]);
    expect(calls).toContain(
      'https://api.github.com/repos/octo/example/issues/7/comments',
    );
  });

  it('releases the entry for retry with backoff -- never settling it done -- when webhook delivery fails, and retries it successfully once backoff elapses', async () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      slack: SLACK_TARGET,
    });
    const { store, orchestrator } = fixture();
    const run = await requestedWithOrigin(orchestrator, {
      principal: 'svc:sprinkles-lcars-bot',
      channel: 'slack',
      thread: THREAD,
    });
    await orchestrator.report(run.runId, { ok: true, summary: 'park' });

    let attempt = 0;
    const deliverOutcomeWebhook = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('bot unreachable');
    });

    const result1 = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: vi.fn() as typeof fetch,
      deliverOutcomeWebhook,
      now: () => NOW,
    });
    expect(result1.failed.map((f) => f.error)).toEqual(['bot unreachable']);
    expect(result1.reported).toEqual([]);

    // Immediately retrying, before backoff elapses, must not reclaim it.
    const resultImmediate = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: vi.fn() as typeof fetch,
      deliverOutcomeWebhook,
      now: () => NOW,
    });
    expect(deliverOutcomeWebhook).toHaveBeenCalledTimes(1);
    expect(resultImmediate.reported).toEqual([]);

    // Past the backoff window (OUTBOX_BACKOFF_BASE_MS), the same entry is
    // retried -- exactly the GitHub outcome-comment failure path -- and
    // this time succeeds. Never a lost run.
    const laterNow = new Date(Date.parse(NOW) + 61_000).toISOString();
    const result2 = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: vi.fn() as typeof fetch,
      deliverOutcomeWebhook,
      now: () => laterNow,
    });
    expect(deliverOutcomeWebhook).toHaveBeenCalledTimes(2);
    expect(result2.reported).toEqual([run.runId]);
  });
});

describe('drainOutbox native session expiry on item close', () => {
  const WORK_ID = '01J5Z3K9QX8F0N2B4V6C8D1E4H';
  const DISPATCH_URL = `https://api.github.com/repos/${process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY']}/actions/workflows/work-session-expiry.yml/dispatches`;
  const origin = { principal: 'test:expiry', channel: 'api' } as const;

  function recordingFetch(status = 204) {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return new Response(status === 204 ? null : 'nope', { status });
      },
    ) as typeof fetch;
    return { calls, fetchImpl };
  }

  it.each([
    ['done', { ok: true }],
    ['failed', { ok: false }],
  ] as const)(
    'dispatches the expiry workflow for an item that settles %s',
    async (_state, result) => {
      const { store, orchestrator } = fixture();
      const run = await requestedWithOrigin(orchestrator, origin, WORK_ID);
      await orchestrator.report(run.runId, result);
      const { calls, fetchImpl } = recordingFetch();

      const drained = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl,
        now: () => NOW,
      });

      expect(drained.failed).toEqual([]);
      expect(calls).toEqual([
        {
          url: DISPATCH_URL,
          body: { ref: 'main', inputs: { item: WORK_ID } },
          auth: 'Bearer test-token',
        },
      ]);
    },
  );

  it('dispatches it when an operator cancels the live run', async () => {
    const { store, orchestrator } = fixture();
    const run = await requestedWithOrigin(orchestrator, origin, WORK_ID);
    await orchestrator.cancel(run.runId, 'canceled by test');
    const { calls, fetchImpl } = recordingFetch();

    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => NOW,
    });

    expect(calls.map((call) => call.url)).toEqual([DISPATCH_URL]);
  });

  it('leaves a parked item open: its sessions keep no expiry', async () => {
    const { store, orchestrator } = fixture();
    const run = await requestedWithOrigin(orchestrator, origin, WORK_ID);
    await orchestrator.report(run.runId, { ok: true, summary: 'park' });
    const { calls, fetchImpl } = recordingFetch();

    const drained = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => NOW,
    });

    expect(calls).toEqual([]);
    expect(drained.failed).toEqual([]);
  });

  it('never lets a failed dispatch hold back the outcome webhook', async () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      slack: { url: 'https://bot.example/outcome', audience: 'bot' },
    });
    try {
      const { store, orchestrator } = fixture();
      const run = await requestedWithOrigin(
        orchestrator,
        { principal: 'svc:bot', channel: 'slack', thread: 'T1/C1/1.2' },
        WORK_ID,
      );
      await orchestrator.report(run.runId, { ok: true });
      const failing = recordingFetch(503);
      const deliverOutcomeWebhook = vi.fn().mockResolvedValue(undefined);

      const drained = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl: failing.fetchImpl,
        deliverOutcomeWebhook,
        now: () => NOW,
      });

      expect(failing.calls.map((call) => call.url)).toEqual([DISPATCH_URL]);
      expect(deliverOutcomeWebhook).toHaveBeenCalledOnce();
      expect(drained.reported).toEqual([run.runId]);
      expect(drained.failed).toEqual([]);
    } finally {
      delete process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'];
    }
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

describe.each([
  { ok: false, summary: 'failed', method: undefined },
  { ok: true, summary: 'park', method: 'POST' },
  { ok: true, summary: 'pull-request', method: 'DELETE' },
])('outcome ordering for $summary', ({ ok, summary, method }) => {
  it.each([
    ['/r2', true],
    ['/r9007199254740991', true],
    ['/missing', false],
    ['/r9007199254740993', false],
  ])(
    'only suppresses label changes for a known newer run: %s',
    async (suffix, suppress) => {
      const { store, orchestrator } = fixture();
      const original = await requested(orchestrator);
      await orchestrator.report(original.runId, { ok, summary });
      // A later successful result resolves an old failure; a later park
      // preserves the human-needed signal against an old success.
      vi.spyOn(store, 'listRuns').mockResolvedValue([
        run({
          runId: `octo/example#7${suffix}`,
          result:
            method === 'DELETE' ? { ok: true, summary: 'park' } : { ok: true },
        }),
      ]);
      const fetchImpl = vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) =>
          new Response(null, { status: 201 }),
      );
      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl: fetchImpl as typeof fetch,
        now: () => NOW,
      });
      expect(result.reported).toEqual([original.runId]);
      const labelCalls = fetchImpl.mock.calls.filter(([url]) =>
        String(url).includes('/labels'),
      );
      expect(labelCalls.map(([, init]) => init?.method)).toEqual(
        suppress || method === undefined ? [] : [method],
      );
    },
  );
});

describe('outcomeCommentBody', () => {
  it('identifies a created fresh fallback instead of requesting a manual retry', () => {
    const original = run({ result: { ok: false, summary: 'provider-limit' } });
    const successor = run({
      runId: `${TASK.repo}#${TASK.issue}/r2`,
      pipeline: 'codex',
      state: 'running',
      providerFallback: {
        principal: 'user:operator',
        allowedPipelines: ['codex'],
        attemptedPipelines: ['claude', 'codex'],
        originalRunId: original.runId,
        fromRunId: original.runId,
        trigger: {
          reason: 'provider-limit',
          failureRunId: original.runId,
          limitedPipeline: 'claude',
        },
      },
    });
    const body = outcomeCommentBody(original, successor);
    expect(body).toContain(
      `fresh fallback attempt ${successor.runId} on codex`,
    );
    expect(body).not.toContain('re-request manually');
    expect(
      outcomeCommentBody({
        ...successor,
        state: 'finished',
        result: { ok: true },
      }),
    ).toContain(`triggering failure: ${original.runId}`);
  });
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
