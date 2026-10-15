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
import type {
  OutcomeWebhookPayload,
  OutcomeWebhookTarget,
} from './outcome-webhook';

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
    const body = outcomeCommentBody(
      original,
      successor,
      run({
        runId: `${TASK.repo}#${TASK.issue}/r3`,
      }),
    );
    expect(body).toContain(
      `fresh fallback attempt ${successor.runId} on codex`,
    );
    expect(body).not.toContain('re-request manually');
    expect(body).not.toContain('A newer request already exists');
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

describe('delayed failure outcome advice', () => {
  it('names the highest valid generation from unordered authoritative history', async () => {
    const { store, orchestrator } = fixture();
    const original = await requested(orchestrator);
    await orchestrator.report(original.runId, {
      ok: false,
      summary: 'provider-limit',
    });
    vi.spyOn(store, 'listRuns').mockResolvedValue([
      run({ runId: `${TASK.repo}#${TASK.issue}/r10` }),
      run({ runId: `${TASK.repo}#${TASK.issue}/r9007199254740993` }),
      run({ runId: `${TASK.repo}#${TASK.issue}/missing` }),
      original,
      run({ runId: `${TASK.repo}#${TASK.issue}/r2` }),
    ]);
    const comments: string[] = [];
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      now: () => NOW,
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith('/comments'))
          comments.push(JSON.parse(String(init?.body)).body);
        return new Response(null, { status: 201 });
      }) as typeof fetch,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`run ${TASK.repo}#${TASK.issue}/r10`);
    expect(comments[0]).not.toContain('/r2');
    expect(comments[0]).not.toContain('/r9007199254740993');
    expect(comments[0]).not.toContain('/missing');
    expect(comments[0]).not.toContain('re-request manually');
  });
  it('delivers direct fallback identity ahead of generic newer-request advice', async () => {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator(
      store,
      { now: () => NOW },
      {
        pipelines: ['claude', 'codex'],
        allowedPipelines: () => ['claude', 'codex'],
      },
    );
    const admitted = await orchestrator.request({
      taskId: TASK,
      requestId: 'with-fallback',
      pipeline: 'claude',
      work: { spec: { title: 'Explicit fallback delivery' } },
      providerFallback: {
        principal: 'user:operator',
        allowedPipelines: ['codex'],
      },
    });
    if (isRefusal(admitted)) throw new Error(admitted.reason);
    const original = decidedRun(admitted);
    await orchestrator.report(original.runId, {
      ok: false,
      summary: 'provider-limit',
    });
    const successor = await store.readActiveRun(TASK);
    expect(successor).toBeDefined();
    const comments: string[] = [];
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      now: () => NOW,
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith('/comments'))
          comments.push(JSON.parse(String(init?.body)).body);
        return new Response(
          JSON.stringify({ assignees: [{ login: 'agent-lcars-bot' }] }),
          { status: 201 },
        );
      }) as typeof fetch,
    });
    const historical = comments.find((body) =>
      body.startsWith(`❌ Run ${original.runId} failed.`),
    );
    expect(historical).toContain(
      `fresh fallback attempt ${successor?.runId} on codex`,
    );
    expect(historical).toContain(`Original intent: ${original.runId}`);
    expect(historical).not.toContain('re-request manually');
    expect(historical).not.toContain('A newer request already exists');
  });
  it('retries the same report after a failed history read instead of posting unqualified advice', async () => {
    const { store, orchestrator } = fixture();
    const original = await requested(orchestrator);
    await orchestrator.report(original.runId, {
      ok: false,
      summary: 'provider-limit',
    });
    const next = await orchestrator.request({
      taskId: TASK,
      requestId: 'manual-next',
      pipeline: 'claude',
    });
    if (isRefusal(next)) throw new Error(next.reason);
    const newer = decidedRun(next);
    const history = vi
      .spyOn(store, 'listRuns')
      .mockRejectedValueOnce(new Error('history unavailable'));
    const comments: string[] = [];
    const deps = {
      store,
      orchestrator,
      tokens,
      now: () => NOW,
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith('/comments'))
          comments.push(JSON.parse(String(init?.body)).body);
        return new Response(
          JSON.stringify({ assignees: [{ login: 'agent-lcars-bot' }] }),
          { status: 201 },
        );
      }) as typeof fetch,
    };
    const failed = await drainOutbox(deps);
    expect(failed.reported).not.toContain(original.runId);
    expect(failed.failed).toEqual([
      expect.objectContaining({ error: 'history unavailable' }),
    ]);
    expect(comments).toEqual([]);
    history.mockRestore();
    const retried = await drainOutbox({
      ...deps,
      now: () => '2026-08-29T12:01:01.000Z',
    });
    expect(retried.reported).toContain(original.runId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(original.runId);
    expect(comments[0]).toContain(newer.runId);
    expect(comments[0]).not.toContain('re-request manually');
  });
  it.each(['pending', 'running', 'finished', 'canceled'] as const)(
    'names an already requested newer %s run instead of requesting another retry',
    async (newerState) => {
      const { store, orchestrator } = fixture();
      const original = await requested(orchestrator);
      await orchestrator.report(original.runId, {
        ok: false,
        summary: 'provider-limit',
      });
      const next = await orchestrator.request({
        taskId: TASK,
        requestId: 'manual-next',
        pipeline: 'claude',
      });
      if (isRefusal(next)) throw new Error(next.reason);
      const newer = decidedRun(next);
      if (newerState === 'running')
        await orchestrator.confirmDispatch(newer.runId);
      if (newerState === 'finished')
        await orchestrator.report(newer.runId, {
          ok: true,
          summary: 'resolved',
        });
      if (newerState === 'canceled') await orchestrator.cancel(newer.runId);
      const comments: string[] = [];
      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        now: () => NOW,
        fetchImpl: (async (url, init) => {
          if (String(url).endsWith('/comments'))
            comments.push(JSON.parse(String(init?.body)).body);
          return new Response(
            JSON.stringify({ assignees: [{ login: 'agent-lcars-bot' }] }),
            { status: 201 },
          );
        }) as typeof fetch,
      });
      expect(result.reported).toContain(original.runId);
      const historical = comments.find((body) =>
        body.startsWith(`❌ Run ${original.runId} failed.`),
      );
      expect(historical).toContain('provider-limit');
      expect(historical).toContain(newer.runId);
      expect(historical).toContain(newerState);
      expect(historical).not.toContain('re-request manually');
    },
  );
  it('retains manual retry guidance when no newer request exists', async () => {
    const { store, orchestrator } = fixture();
    const original = await requested(orchestrator);
    await orchestrator.report(original.runId, {
      ok: false,
      summary: 'provider-limit',
    });
    const comments: string[] = [];
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      now: () => NOW,
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith('/comments'))
          comments.push(JSON.parse(String(init?.body)).body);
        return new Response(
          JSON.stringify({ assignees: [{ login: 'agent-lcars-bot' }] }),
          { status: 201 },
        );
      }) as typeof fetch,
    });
    expect(comments.find((body) => body.includes(original.runId))).toContain(
      're-request manually',
    );
  });
});

describe('native delivery finalization reuses terminal outcome and session expiry', () => {
  const WORK_ID = '01J5Z3K9QX8F0N2B4V6C8D1E4H';
  const HEAD = 'a'.repeat(40),
    MERGE = 'b'.repeat(40);
  afterEach(() => vi.unstubAllEnvs());
  async function reported(
    runtimeGate: 'none' | 'required' = 'none',
    state: 'waiting' | 'complete' = 'waiting',
  ) {
    vi.stubEnv(
      'AGENT_LCARS_OUTCOME_WEBHOOKS',
      JSON.stringify({
        slack: { url: 'https://bot.example/outcome', audience: 'bot' },
      }),
    );
    const f = fixture();
    const run = await requestedWithOrigin(
      f.orchestrator,
      { principal: 'test:delivery', channel: 'slack', thread: 'thread' },
      WORK_ID,
    );
    const original = {
      ok: true,
      summary: 'pull-request',
      ref: 'https://github.com/octo/example/pull/12',
      message: 'Published ready PR',
    };
    const decision = await f.orchestrator.report(
      run.runId,
      original,
      undefined,
      undefined,
      undefined,
      {
        runId: run.runId,
        repo: 'octo/example',
        number: 12,
        baseRef: 'main',
        head: HEAD,
        state,
        ...(state === 'complete' ? { mergeCommit: MERGE } : {}),
        runtimeGate,
        observedAt: NOW,
      },
    );
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const deliver = vi.fn(
      async (_target: OutcomeWebhookTarget, _payload: OutcomeWebhookPayload) =>
        undefined,
    );
    const deps = {
      ...f,
      tokens,
      fetchImpl,
      deliverOutcomeWebhook: deliver,
      now: () => NOW,
    };
    if (isRefusal(decision)) throw new Error(decision.reason);
    return { ...f, run, original, fetchImpl, deliver, deps, decision };
  }
  async function waiting(runtimeGate: 'none' | 'required' = 'none') {
    const f = await reported(runtimeGate);
    await drainOutbox(f.deps);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.deliver.mock.calls[0]?.[1]).not.toHaveProperty('eventId');
    return f;
  }
  it('emits one distinct final native event and expiry after none runtime gating, preserving the original result', async () => {
    const f = await waiting('none');
    const landing = await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => false,
    );
    expect(isRefusal(landing)).toBe(false);
    const final = await drainOutbox(f.deps);
    expect(final.reported).toEqual([f.run.runId]);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(String(vi.mocked(f.fetchImpl).mock.calls[0]?.[0])).toContain(
      '/work-session-expiry.yml/dispatches',
    );
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.deliver.mock.calls[1]?.[1]).toMatchObject({
      eventId: `delivery-outcome/${f.run.runId}`,
      deliveryStage: 'complete',
      runId: f.run.runId,
    });
    expect((await f.store.readRun(f.run.runId))?.result).toEqual(f.original);
    await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => false,
    );
    await drainOutbox(f.deps);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });

  it('emits one distinct final native event and expiry after required runtime gating, preserving the original result', async () => {
    const f = await waiting('required');
    const landing = await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => false,
    );
    expect(isRefusal(landing)).toBe(false);
    expect((await drainOutbox(f.deps)).reported).toEqual([]);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    const runtime = await f.orchestrator.observeDelivery(
      f.run.runId,
      {
        kind: 'runtime-evidence',
        head: HEAD,
        mergeCommit: MERGE,
        principal: 'user:operator',
        ref: 'https://example.test/runtime-proof',
      },
      () => true,
    );
    expect(isRefusal(runtime)).toBe(false);

    const final = await drainOutbox(f.deps);
    expect(final.reported).toEqual([f.run.runId]);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(String(vi.mocked(f.fetchImpl).mock.calls[0]?.[0])).toContain(
      '/work-session-expiry.yml/dispatches',
    );
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.deliver.mock.calls[1]?.[1]).toMatchObject({
      eventId: `delivery-outcome/${f.run.runId}`,
      deliveryStage: 'complete',
      runId: f.run.runId,
    });
    expect((await f.store.readRun(f.run.runId))?.result).toEqual(f.original);
    await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => false,
    );
    await drainOutbox(f.deps);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it('retries final delivery with the same event identity without replaying the settled execution event', async () => {
    const f = await waiting();
    await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => false,
    );
    f.deliver.mockRejectedValueOnce(new Error('lost response'));
    expect((await drainOutbox(f.deps)).failed).toHaveLength(1);
    const retry = { ...f.deps, now: () => '2026-08-29T12:02:00.000Z' };
    expect((await drainOutbox(retry)).reported).toEqual([f.run.runId]);
    expect(f.deliver).toHaveBeenCalledTimes(3);
    const attempts = f.deliver.mock.calls.slice(1).map((call) => call[1]);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]).toMatchObject({
      eventId: `delivery-outcome/${f.run.runId}`,
      deliveryStage: 'complete',
    });
    expect((await f.store.readRun(f.run.runId))?.result).toEqual(f.original);
    await drainOutbox(retry);
    expect(f.deliver).toHaveBeenCalledTimes(3);
  });
  it('immediate native complete delivery emits one final marker and owns expiry once', async () => {
    const f = await reported('none', 'complete');
    expect(f.decision.outbox.map((entry) => entry.entryId)).toContain(
      `outcome/${f.run.runId}`,
    );
    expect(f.decision.outbox.map((entry) => entry.entryId)).toContain(
      `delivery-outcome/${f.run.runId}`,
    );
    await drainOutbox(f.deps);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.deliver.mock.calls[0]?.[1]).not.toHaveProperty('eventId');
    expect(f.deliver.mock.calls[1]?.[1]).toMatchObject({
      eventId: `delivery-outcome/${f.run.runId}`,
      deliveryStage: 'complete',
    });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect((await f.store.readRun(f.run.runId))!.result).toEqual(f.original);
    await drainOutbox(f.deps);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it('closed native monitor retires before any GitHub read and preserves accepted execution', async () => {
    const f = await waiting();
    expect(isRefusal(await f.orchestrator.close(f.run.task))).toBe(false);
    expect(
      (await drainOutbox({ ...f.deps, now: () => '2026-08-29T12:01:00.000Z' }))
        .failed,
    ).toEqual([]);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect((await f.store.readRun(f.run.runId))!.result).toEqual(f.original);
    const pending = await f.store.claimPendingOutbox({
      now: '2026-08-29T12:10:00.000Z',
      leaseExpiresAt: '2026-08-29T12:11:00.000Z',
      limit: 20,
    });
    expect(pending.some((entry) => entry.kind === 'monitor-delivery')).toBe(
      false,
    );
  });
  it('closed native monitor rejects closure racing the actual GitHub evidence read', async () => {
    const f = await waiting();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/pulls/12')) {
        const closed = await f.orchestrator.close(f.run.task);
        if (isRefusal(closed)) throw new Error(closed.reason);
        return Response.json({
          number: 12,
          body: `<!-- attempt-claim:g1:${f.run.runId} -->`,
          state: 'closed',
          draft: false,
          head: { sha: HEAD },
          base: { ref: 'main' },
          user: { login: 'author' },
          merged: true,
          merge_commit_sha: MERGE,
          auto_merge: null,
        });
      }
      if (url.endsWith('/graphql'))
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                headRefOid: HEAD,
                reviews: {
                  pageInfo: { hasPreviousPage: false },
                  nodes: [
                    {
                      state: 'APPROVED',
                      author: { login: 'reviewer' },
                      commit: { oid: HEAD },
                    },
                  ],
                },
                reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
              },
            },
          },
        });
      if (url.includes('/rulesets/rule-suites?'))
        return Response.json([
          { id: 1, after_sha: MERGE, result: 'pass', ref: 'refs/heads/main' },
        ]);
      if (url.endsWith('/rulesets/rule-suites/1'))
        return Response.json({
          result: 'pass',
          after_sha: MERGE,
          rule_evaluations: [
            { rule_type: 'required_status_checks', result: 'pass' },
            { rule_type: 'pull_request', result: 'pass' },
          ],
        });
      throw new Error(`Unexpected evidence request ${url}`);
    });
    expect(
      (
        await drainOutbox({
          ...f.deps,
          fetchImpl,
          now: () => '2026-08-29T12:01:00.000Z',
        })
      ).failed,
    ).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const task = (await f.store.readTask(f.run.task))!.task;
    expect(task.closedAt).toBe(NOW);
    expect(task.delivery).toMatchObject({ head: HEAD, state: 'waiting' });
    expect(task.runCount).toBe(1);
    expect(f.deliver).toHaveBeenCalledOnce();
    expect((await f.store.readRun(f.run.runId))!.result).toEqual(f.original);
    const pending = await f.store.claimPendingOutbox({
      now: '2026-08-29T12:10:00.000Z',
      leaseExpiresAt: '2026-08-29T12:11:00.000Z',
      limit: 20,
    });
    expect(
      pending.some(
        (entry) =>
          entry.kind === 'monitor-delivery' ||
          entry.entryId.startsWith('delivery-outcome/'),
      ),
    ).toBe(false);
  });
  async function laterPark(f: Awaited<ReturnType<typeof waiting>>, ok = true) {
    const request = await f.orchestrator.request({
      taskId: f.run.task,
      requestId: 'later-reply',
      pipeline: 'claude',
      params: { mode: 'reply', replyPrincipal: 'user:operator' },
    });
    if (isRefusal(request)) throw new Error(request.reason);
    const later = decidedRun(request);
    await f.orchestrator.confirmDispatch(later.runId);
    const outcome = await f.orchestrator.report(later.runId, {
      ok,
      summary: ok ? 'park' : 'failed',
    });
    if (isRefusal(outcome)) throw new Error(outcome.reason);
    return later;
  }
  it('closed native final delivery is suppressed while the later execution outcome remains', async () => {
    const f = await waiting();
    await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => true,
    );
    const later = await laterPark(f);
    expect(isRefusal(await f.orchestrator.close(f.run.task))).toBe(false);
    await drainOutbox(f.deps);
    expect(
      f.deliver.mock.calls
        .map((call) => call[1])
        .filter((payload) => payload.deliveryStage === 'complete'),
    ).toEqual([]);
    expect(f.deliver.mock.calls.at(-1)?.[1]).toMatchObject({
      runId: later.runId,
      parked: true,
    });
    expect((await f.store.readRun(f.run.runId))!.result).toEqual(f.original);
    expect((await f.store.readTask(f.run.task))!.task.closedAt).toBe(NOW);
  });
  it('a later failed reply retains its ordinary expiry after an older completed delivery', async () => {
    const f = await waiting();
    await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => true,
    );
    await drainOutbox(f.deps);
    vi.mocked(f.fetchImpl).mockClear();
    f.deliver.mockClear();
    const later = await laterPark(f, false);
    await drainOutbox(f.deps);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.deliver.mock.calls[0]?.[1]).toMatchObject({
      runId: later.runId,
      ok: false,
    });
    expect(f.deliver.mock.calls[0]?.[1]).not.toHaveProperty('deliveryStage');
    expect((await f.store.readRun(f.run.runId))!.result).toEqual(f.original);
  });
  it('native item cancellation retires monitoring during an active correction', async () => {
    const f = await waiting();
    const correction = await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'correction', head: HEAD, reason: 'review change' },
      () => true,
    );
    if (isRefusal(correction)) throw Error(correction.reason);
    const active = correction.additionalRuns![0]!;
    const canceled = await f.orchestrator.cancel(
      active.runId,
      'native item canceled',
      { workId: WORK_ID },
    );
    if (isRefusal(canceled)) throw Error(canceled.reason);
    expect(canceled.task.closedAt).toBe(NOW);
    expect(
      (await drainOutbox({ ...f.deps, now: () => '2026-08-29T12:01:00.000Z' }))
        .failed,
    ).toEqual([]);
    expect(
      vi
        .mocked(f.fetchImpl)
        .mock.calls.some(([input]) => String(input).includes('/pulls/')),
    ).toBe(false);
    expect(
      f.deliver.mock.calls
        .map((call) => call[1])
        .filter((payload) => payload.deliveryStage === 'complete'),
    ).toEqual([]);
    expect(f.deliver.mock.calls.at(-1)?.[1]).toMatchObject({
      runId: active.runId,
      state: 'canceled',
    });
    expect((await f.store.readRun(f.run.runId))!.result).toEqual(f.original);
    expect(
      await f.orchestrator.observeDelivery(
        f.run.runId,
        { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
        () => true,
      ),
    ).toMatchObject({ refused: true, reason: 'task-closed' });
  });

  it('delayed native final survives a later ready handoff with its immutable identity', async () => {
    const f = await waiting();
    await f.orchestrator.observeDelivery(
      f.run.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => true,
    );
    const originalBinding = (await f.store.readRun(f.run.runId))!.delivery;
    f.deliver.mockRejectedValueOnce(Error('temporary lost response'));
    expect((await drainOutbox(f.deps)).failed).toHaveLength(1);
    const request = await f.orchestrator.request({
      taskId: f.run.task,
      requestId: 'later-ready-reply',
      pipeline: 'claude',
      params: { mode: 'reply', replyPrincipal: 'user:operator' },
    });
    if (isRefusal(request)) throw Error(request.reason);
    const later = decidedRun(request);
    await f.orchestrator.confirmDispatch(later.runId);
    const head = 'd'.repeat(40);
    const laterResult = {
      ok: true,
      summary: 'pull-request',
      ref: 'https://github.com/octo/example/pull/13',
      message: 'Later ready PR',
    };
    const report = await f.orchestrator.report(
      later.runId,
      laterResult,
      undefined,
      undefined,
      undefined,
      {
        runId: later.runId,
        repo: 'octo/example',
        number: 13,
        baseRef: 'main',
        head,
        state: 'waiting',
        runtimeGate: 'none',
        observedAt: NOW,
      },
    );
    if (isRefusal(report)) throw Error(report.reason);
    await drainOutbox(f.deps);
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/pulls/13'))
          return Response.json({
            number: 13,
            body: `<!-- attempt-claim:g2:${later.runId} -->`,
            state: 'open',
            draft: false,
            head: { sha: head },
            base: { ref: 'main' },
            user: { login: 'author' },
            merged: false,
            merge_commit_sha: null,
            auto_merge: { merge_method: 'squash' },
          });
        if (url.endsWith('/graphql'))
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  headRefOid: head,
                  reviews: {
                    pageInfo: { hasPreviousPage: false },
                    nodes: [
                      {
                        state: 'APPROVED',
                        author: { login: 'reviewer' },
                        commit: { oid: head },
                      },
                    ],
                  },
                  reviewThreads: {
                    pageInfo: { hasNextPage: false },
                    nodes: [],
                  },
                },
              },
            },
          });
        if (url.includes('/rules/branches/'))
          return Response.json([
            { type: 'pull_request' },
            {
              type: 'required_status_checks',
              parameters: { required_status_checks: [{ context: 'Verify' }] },
            },
          ]);
        if (url.includes(`/commits/${head}/check-runs`))
          return Response.json({
            total_count: 1,
            check_runs: [
              {
                name: 'Verify',
                head_sha: head,
                status: 'queued',
                conclusion: null,
              },
            ],
          });
        return f.fetchImpl(input, init);
      },
    );
    const retry = await drainOutbox({
      ...f.deps,
      fetchImpl,
      now: () => '2026-08-29T12:02:00.000Z',
    });
    expect(retry.failed).toEqual([]);
    expect(retry.reported).toContain(f.run.runId);
    const originalFinals = f.deliver.mock.calls
      .map((call) => call[1])
      .filter(
        (payload) => payload.eventId === `delivery-outcome/${f.run.runId}`,
      );
    expect(originalFinals).toHaveLength(2);
    expect(originalFinals[1]).toEqual(originalFinals[0]);
    expect(originalFinals[1]).toMatchObject({
      runId: f.run.runId,
      deliveryStage: 'complete',
      ref: f.original.ref,
    });
    expect(
      f.deliver.mock.calls
        .map((call) => call[1])
        .filter(
          (payload) =>
            payload.runId === f.run.runId &&
            payload.deliveryStage === undefined,
        ),
    ).toHaveLength(1);
    expect((await f.store.readTask(f.run.task))!.task.delivery).toMatchObject({
      runId: later.runId,
      head,
      state: 'waiting',
    });
    expect((await f.store.readRun(f.run.runId))!.delivery).toEqual(
      originalBinding,
    );
    expect((await f.store.readRun(f.run.runId))!.result).toEqual(f.original);
    expect((await f.store.readRun(later.runId))!.result).toEqual(laterResult);
  });

  it.each(['wrong-run', 'waiting', 'missing-merge'] as const)(
    'suppresses a final event without its own complete immutable %s binding',
    async (cause) => {
      const f = await waiting();
      await f.orchestrator.observeDelivery(
        f.run.runId,
        { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
        () => true,
      );
      const task = (await f.store.readTask(f.run.task))!;
      const original = (await f.store.readRun(f.run.runId))!;
      const delivery = { ...original.delivery! };
      if (cause === 'wrong-run') delivery.runId = `${f.run.runId}-wrong`;
      if (cause === 'waiting') delivery.state = 'waiting';
      if (cause === 'missing-merge') delete delivery.mergeCommit;
      await f.store.apply({
        expectedRevision: task.revision,
        decision: {
          task: task.task,
          run: { ...original, delivery },
          outbox: [],
        },
      });
      await drainOutbox(f.deps);
      expect(f.deliver).toHaveBeenCalledOnce();
      expect(f.deliver.mock.calls[0]?.[1]).not.toHaveProperty('deliveryStage');
      expect((await f.store.readRun(f.run.runId))!.result).toEqual(f.original);
    },
  );
});
