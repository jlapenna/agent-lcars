// @vitest-environment node
import {
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { expect, it, vi } from 'vitest';

import { GcsCodexAuthStore } from './codex-auth-store';
import { releaseCodexCredentialLease } from './codex-credential-operations';
import { codexCentralAuthObject } from './deployment';
import { hashRunToken } from './run-token';
import { createRunsHandler, type RunsContext } from './runs-router';
import { ConditionalCodexBucket } from './testing/codex-auth-bucket';
const mocks = vi.hoisted(() => ({ jobs: vi.fn() }));
vi.mock('./repository-jobs-runtime', () => ({ repositoryJobs: mocks.jobs }));

it('a recipe uses the native Codex lease/CAS barriers and preserves cleanup authority after settlement', async () => {
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
  const payload = {
    generation: restored.body.generation,
    restoredSha256: restored.body.sha256,
    authBase64: Buffer.from('{"tokens":{"access":"rotated-fixture"}}').toString(
      'base64',
    ),
  };
  expect((await call('PUT', payload)).status).toBe(200);
  expect((await codexAuth.read()).authBase64).toBe(payload.authBase64);
  authorized = false;
  expect((await call('GET')).status).toBe(403);
  authorized = true;
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
