// @vitest-environment node
import {
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { expect, it, vi } from 'vitest';

import { GcsCodexAuthStore } from './codex-auth-store';
import {
  recoverCodexCredentialOperations,
  releaseCodexCredentialLease,
} from './codex-credential-operations';
import { codexCentralAuthObject } from './deployment';
import { hashRunToken } from './run-token';
import { createRunsHandler, type RunsContext } from './runs-router';
import { ConditionalCodexBucket, deferred } from './testing/codex-auth-bucket';
const mocks = vi.hoisted(() => ({ jobs: vi.fn() }));
vi.mock('./repository-jobs-runtime', () => ({ repositoryJobs: mocks.jobs }));

async function recipeFixture() {
  const now = new Date('2026-11-06T19:00:00Z');
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => now.toISOString(),
  });
  const workId = '01M6RY6R9E7Y847455RFBWC19A';
  const requested = await orchestrator.request({
    taskId: { workId },
    requestId: 'recipe-codex',
    pipeline: 'goose',
    params: {
      mode: 'recipe',
      jobOccurrence: 'b'.repeat(64),
      providerAuth: 'codex',
    },
    work: {
      spec: { title: 'Skill evals', target: { repo: 'jlapenna/labels' } },
    },
  });
  if (isRefusal(requested) || !requested.run) throw Error('Admission failed');
  const runId = requested.run.runId;
  await store.enqueueRun({ runId, now: now.toISOString() });
  await store.claimQueuedRun({
    pipelines: ['goose'],
    now: now.toISOString(),
    claimedBy: 'worker',
    claimedBySubject: 'executor',
    tokenHash: hashRunToken('fixture'),
  });
  const fake = new ConditionalCodexBucket();
  const original = fake.seed(
    codexCentralAuthObject(),
    Buffer.from('{"tokens":{"access":"original-fixture"}}'),
  );
  const codexAuth = new GcsCodexAuthStore(fake.bucket);
  let authorized = true;
  mocks.jobs.mockReturnValue({
    deps: {
      store: {
        readOccurrence: async () => ({
          workId,
          profile: { providerAuth: 'codex' },
          definition: { repository: 'jlapenna/labels' },
        }),
      },
    },
    authorizeOccurrence: () => {
      if (!authorized) throw Error('revoked');
      return { providerAuth: 'codex' };
    },
  });
  const context = {
    store,
    orchestrator,
    codexAuth,
    bearerToken: 'fixture',
    now: () => now,
    drain: async () => ({ dispatched: [], reported: [], failed: [] }),
  } as unknown as RunsContext;
  const call = async (method: string, body?: unknown) => {
    const { response } = await createRunsHandler().handle(
      new Request(
        `https://console.test/api/work/v1/runs/${encodeURIComponent(runId)}/codex-auth`,
        {
          method,
          ...(body
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              }
            : {}),
        },
      ),
      { prefix: '/api/work/v1', context },
    );
    return { status: response!.status, body: await response!.json() };
  };
  const restored = await call('GET');
  expect(restored.status).toBe(200);
  expect(restored.body.generation).toBe(original.generation);
  expect((await codexAuth.readLease())?.runId).toBe(runId);
  return {
    store,
    orchestrator,
    runId,
    codexAuth,
    context,
    call,
    restored,
    fake,
    now,
    setAuthorized(value: boolean) {
      authorized = value;
    },
  };
}

it('recipe Codex lease/CAS preserves rotation and cleanup after completion', async () => {
  const {
    store,
    orchestrator,
    runId,
    codexAuth,
    context,
    call,
    restored,
    setAuthorized,
  } = await recipeFixture();
  const payload = {
    generation: restored.body.generation,
    restoredSha256: restored.body.sha256,
    authBase64: Buffer.from('{"tokens":{"access":"rotated-fixture"}}').toString(
      'base64',
    ),
  };
  expect((await call('PUT', payload)).status).toBe(200);
  expect((await codexAuth.read()).authBase64).toBe(payload.authBase64);
  setAuthorized(false);
  expect((await call('GET')).status).toBe(403);
  setAuthorized(true);
  const run = await store.readRun(runId);
  expect(run).toBeDefined();
  const reported = await orchestrator.report(
    runId,
    { ok: true, summary: 'Actual report' },
    hashRunToken('fixture'),
  );
  expect(isRefusal(reported)).toBe(false);
  expect((await store.readRun(runId))?.credentialOperation?.kind).toBe(
    'cleanup',
  );
  await releaseCodexCredentialLease(context, run!);
  expect((await store.readRun(runId))?.credentialOperation).toBeUndefined();
  await orchestrator.executorExited(runId, {
    subject: 'executor',
    runner: 'worker',
    claimFingerprint: hashRunToken('fixture'),
  });
  expect((await store.readRun(runId))?.queue?.state).toBe('retired');
});

it('worker-loss exit settles and retires a Codex recipe after exact cleanup', async () => {
  const { context, runId, store, codexAuth } = await recipeFixture();
  context.principal = {
    principal: 'svc:executor',
    subject: 'executor',
    via: 'google',
    pipelines: ['goose'],
    scopes: new Set(['work.executor']),
  };
  const { response } = await createRunsHandler().handle(
    new Request(
      `https://console.test/api/work/v1/runs/${encodeURIComponent(runId)}/exit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runner: 'worker',
          claimFingerprint: hashRunToken('fixture'),
        }),
      },
    ),
    { prefix: '/api/work/v1', context },
  );
  expect(response!.status).toBe(200);
  const settled = await store.readRun(runId);
  expect(settled?.state).toBe('lost');
  expect(settled?.queue?.state).toBe('retired');
  expect(settled?.credentialOperation).toBeUndefined();
  expect((await codexAuth.readLease())?.expiresAt).toBe(
    '1970-01-01T00:00:00.000Z',
  );
});

async function observeRecipeExit(
  f: Awaited<ReturnType<typeof recipeFixture>>,
  fingerprint = hashRunToken('fixture'),
) {
  f.context.principal = {
    principal: 'svc:executor',
    subject: 'executor',
    via: 'google',
    pipelines: ['goose'],
    scopes: new Set(['work.executor']),
  };
  const { response } = await createRunsHandler().handle(
    new Request(
      `https://console.test/api/work/v1/runs/${encodeURIComponent(f.runId)}/exit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runner: 'worker',
          claimFingerprint: fingerprint,
        }),
      },
    ),
    { prefix: '/api/work/v1', context: f.context },
  );
  return response!.status;
}
it.each(['finished', 'canceled', 'lost'] as const)(
  'actual exit remains durable during %s recipe cleanup',
  async (state) => {
    const f = await recipeFixture();
    const settle = {
      finished: () =>
        f.orchestrator.report(
          f.runId,
          { ok: true, summary: 'Actual report' },
          hashRunToken('fixture'),
        ),
      canceled: () => f.orchestrator.cancel(f.runId),
      lost: async () => {
        f.now.setTime(f.now.getTime() + 3 * 60 * 60 * 1000);
        await f.orchestrator.sweepExpired();
      },
    };
    await settle[state]();
    const before = await f.store.readRun(f.runId);
    expect(before?.state).toBe(state);
    expect(before?.credentialOperation?.kind).toBe('cleanup');
    expect(await observeRecipeExit(f, 'b'.repeat(64))).toBe(403);
    expect(await observeRecipeExit(f)).toBe(200);
    const observed = await f.store.readRun(f.runId);
    expect(observed?.updatedAt).toBe(before?.updatedAt);
    expect(observed?.result).toEqual(before?.result);
    expect(observed?.queue?.state).toBe('claimed');
    expect(observed?.credentialOperation).toEqual(before?.credentialOperation);
    expect(await observeRecipeExit(f)).toBe(200);
    expect((await f.store.readRun(f.runId))?.events).toEqual(observed?.events);
    await releaseCodexCredentialLease(f.context, observed!);
    expect((await f.store.readRun(f.runId))?.queue?.state).toBe('retired');
  },
);
it('physical exit survives ambiguous cleanup and exact generation recovery', async () => {
  const f = await recipeFixture();
  await f.orchestrator.report(
    f.runId,
    { ok: true, summary: 'Actual report' },
    hashRunToken('fixture'),
  );
  const late = deferred<void>();
  f.fake.delayAndLoseResponse = () => late.promise;
  await expect(
    releaseCodexCredentialLease(f.context, (await f.store.readRun(f.runId))!),
  ).rejects.toThrow();
  expect(
    (await f.store.readRun(f.runId))?.credentialOperation?.mutation,
  ).toBeDefined();
  expect(await observeRecipeExit(f)).toBe(200);
  expect((await f.store.readRun(f.runId))?.queue?.state).toBe('claimed');
  f.fake.delayAndLoseResponse = undefined;
  late.resolve();
  await Promise.all(f.fake.delayedResults);
  f.now.setTime(f.now.getTime() + 6 * 60 * 1000);
  await recoverCodexCredentialOperations(f.context);
  const recovered = await f.store.readRun(f.runId);
  expect(recovered?.state).toBe('finished');
  expect(recovered?.credentialOperation).toBeUndefined();
  expect(recovered?.queue?.state).toBe('retired');
});
