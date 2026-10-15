// @vitest-environment node
import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createOrchestratorRuntime,
  enqueueGitHubWebhook,
  handleWebhookDelivery,
  ProjectionRefreshError,
  revalidateTag,
} = vi.hoisted(() => {
  class ProjectionRefreshError extends Error {
    override readonly name = 'ProjectionRefreshError';
  }
  return {
    createOrchestratorRuntime: vi.fn(),
    enqueueGitHubWebhook: vi.fn(),
    handleWebhookDelivery: vi.fn(),
    ProjectionRefreshError,
    revalidateTag: vi.fn(),
  };
});

vi.mock('@/lib/orchestrator-runtime', () => ({ createOrchestratorRuntime }));
vi.mock('@/lib/hosted-webhook-queue', () => ({ enqueueGitHubWebhook }));
vi.mock('@/lib/orchestrator-routes', () => ({
  handleWebhookDelivery,
  ProjectionRefreshError,
}));
vi.mock('@/lib/github-webhook-auth', () => ({
  verifyWebhookSignature: vi.fn(() => true),
}));
vi.mock('next/cache', () => ({ revalidateTag }));

import { POST } from './route';

function request(retryCount: string, repairGeneration?: string): Request {
  return new Request('https://console.test/api/control-plane/webhook/process', {
    method: 'POST',
    body: JSON.stringify({ repository: { full_name: 'jlapenna/agent-lcars' } }),
    headers: {
      'x-cloudtasks-taskretrycount': retryCount,
      ...(repairGeneration === undefined
        ? {}
        : { 'x-agent-lcars-projection-repair-generation': repairGeneration }),
      'x-github-delivery': 'projection-refresh-delivery',
      'x-github-event': 'issues',
      'x-hub-signature-256': 'sha256=ignored-by-mock',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['AGENT_LCARS_WEBHOOK_SECRET'] = 'test-webhook-secret';
  createOrchestratorRuntime.mockReturnValue({});
  enqueueGitHubWebhook.mockResolvedValue({ outcome: 'enqueued' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env['AGENT_LCARS_WEBHOOK_SECRET'];
  vi.restoreAllMocks();
});

describe('POST /api/control-plane/webhook/process', () => {
  it('binds queue invalidation to the durable webhook projection path', async () => {
    handleWebhookDelivery.mockImplementation(async (deps) => {
      await deps.invalidateAuthoritativeQueue();
      return { status: 200, body: { ignored: 'no-trigger-label' } };
    });

    const response = await POST(request('0'));

    expect(response.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith('authoritative-queue', 'max');
  });

  it('hands a projection-only repair to a durable successor at the retry cap', async () => {
    handleWebhookDelivery.mockRejectedValue(
      new ProjectionRefreshError('GitHub exact refresh unavailable'),
    );

    const response = await POST(request('9'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: 'projection_repair_requeued',
      attempt: 10,
    });
    expect(enqueueGitHubWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'projection-refresh-delivery',
        repairGeneration: 1,
      }),
    );
    expect(handleWebhookDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        invalidateAuthoritativeQueue: expect.any(Function),
      }),
      expect.objectContaining({
        event: 'issues',
        deliveryId: 'projection-refresh-delivery',
      }),
    );
  });

  it('advances the predecessor repair generation after the successor exhausts its own retries', async () => {
    handleWebhookDelivery.mockRejectedValue(
      new ProjectionRefreshError('GitHub exact refresh unavailable'),
    );

    const response = await POST(request('9', '1'));

    expect(response.status).toBe(200);
    expect(enqueueGitHubWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'projection-refresh-delivery',
        repairGeneration: 2,
      }),
    );
  });

  it('schedules each repair successor after a growing delay so a poisoned anchor cannot thrash the queue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
    handleWebhookDelivery.mockRejectedValue(
      new ProjectionRefreshError('GitHub exact refresh unavailable'),
    );

    await POST(request('9', '2'));

    const envelope = enqueueGitHubWebhook.mock.calls[0]?.[0] as {
      repairGeneration: number;
      notBefore: Date;
    };
    expect(envelope.repairGeneration).toBe(3);
    // generation 3 waits 2^3 = 8 hours
    expect(envelope.notBefore.toISOString()).toBe('2026-09-16T08:00:00.000Z');
    vi.useRealTimers();
  });

  it('drops the delivery loudly once the repair chain is exhausted instead of minting another successor', async () => {
    handleWebhookDelivery.mockRejectedValue(
      new ProjectionRefreshError('GitHub exact refresh unavailable'),
    );

    const response = await POST(request('9', '10'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: 'projection_repair_dropped',
      attempt: 10,
      repairGeneration: 10,
    });
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: 'within-bound',
      historical: 1,
      expectedBody: { dispatched: false, runId: 'jlapenna/agent-lcars#42/r2' },
      expectedStatus: 'accepted',
      expectedRuns: 2,
    },
    {
      name: 'overflow',
      historical: 1001,
      expectedBody: {
        refused: 'physical-ownership-unavailable',
        providerRouting: { status: 'refused' },
      },
      expectedStatus: 'refused',
      expectedRuns: 1001,
    },
  ])(
    'acknowledges real label inventory $name at the HTTP boundary',
    async ({ historical, expectedBody, expectedStatus, expectedRuns }) => {
      const actual = await vi.importActual<
        typeof import('@/lib/orchestrator-routes')
      >('@/lib/orchestrator-routes');
      handleWebhookDelivery.mockImplementation(actual.handleWebhookDelivery);
      const store = new MemoryStore();
      let instant = '2026-08-15T12:00:00.000Z';
      const orchestrator = new Orchestrator(store, { now: () => instant });
      createOrchestratorRuntime.mockReturnValue({
        store,
        orchestrator,
        now: () => instant,
        tokens: { tokenFor: async () => 'unused-test-token' },
        fetchImpl: vi.fn(async () => new Response(null, { status: 201 })),
        drain: async () => ({ dispatched: [], reported: [], failed: [] }),
        refreshGithubAnchorProjection: async () => undefined,
      });
      const anchor = { repo: 'jlapenna/agent-lcars', issue: 42 };
      const labelRequest = (delivery: string, pipeline: string) =>
        new Request('https://console.test/api/control-plane/webhook/process', {
          method: 'POST',
          headers: {
            'x-github-event': 'issues',
            'x-github-delivery': delivery,
            'x-hub-signature-256': 'sha256=ignored-by-existing-auth-stub',
          },
          body: JSON.stringify({
            action: 'labeled',
            repository: { full_name: anchor.repo },
            sender: { login: 'jlapenna' },
            label: { name: `agent:${pipeline}` },
            issue: {
              state: 'open',
              number: anchor.issue,
              title: 'Long-lived Task',
              body: 'Preserve label refusal',
              updated_at: instant,
              labels: [{ name: `agent:${pipeline}` }],
              assignees: [],
            },
          }),
        });
      const first = await POST(labelRequest('first-label', 'claude'));
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const runId = firstBody.runId as string;
      await store.enqueueRun({ runId, now: instant });
      const claimed = await store.claimQueuedRun({
        pipelines: ['claude'],
        now: instant,
        claimedBy: 'executor',
        tokenHash: 'a'.repeat(64),
      });
      expect(claimed?.runId).toBe(runId);
      await orchestrator.report(runId, { ok: true });
      const legacy = await store.readRun(runId);
      if (legacy === undefined) throw new Error('missing legacy Run');
      for (let start = 2; start <= historical; start += 250) {
        const task = await store.readTask(anchor);
        if (task === undefined) throw new Error('missing Task');
        const additionalRuns = Array.from(
          { length: Math.min(250, historical + 1 - start) },
          (_, index) => ({
            ...legacy,
            runId: `${anchor.repo}#${anchor.issue}/r${start + index}`,
            requestId: `legacy-${start + index}`,
          }),
        );
        await store.apply({
          expectedRevision: task.revision,
          decision: {
            task: { ...task.task, runCount: start + additionalRuns.length - 1 },
            additionalRuns,
            outbox: [],
          },
        });
      }
      instant = '2026-08-15T12:01:00.000Z';
      const response = await POST(labelRequest('switch-label', 'opencode'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject(expectedBody);
      expect((await store.readTask(anchor))?.task.providerRouting?.status).toBe(
        expectedStatus,
      );
      expect(await store.listRuns(anchor)).toHaveLength(expectedRuns);
      expect(await store.readRun(legacy.runId)).toEqual(legacy);
      const replay = await POST(labelRequest('switch-label', 'opencode'));
      expect(replay.status).toBe(200);
      const replayBody = await replay.json();
      // Overflow is a persisted source-clock refusal; a successful request replays
      // through its normal duplicate binding. Both outcomes remain acknowledged.
      expect(replayBody).toMatchObject(
        historical > 1 ? expectedBody : { duplicate: true, runId: body.runId },
      );
      expect(await store.listRuns(anchor)).toHaveLength(expectedRuns);
    },
  );
});
