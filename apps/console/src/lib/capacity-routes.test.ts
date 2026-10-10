import {
  CapacityProtocol,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { capacityAuthority } from './capacity-routes';
import { verifyCapacityWorkerIdentity } from './capacity-worker-identity';
import { hashRunToken } from './run-token';
import { createRunsHandler, type RunsContext } from './runs-router';
import type { WorkPrincipal } from './work-auth';

const now = '2026-10-10T04:00:00.000Z';
const principal: WorkPrincipal = {
  principal: 'svc:executor',
  subject: 'executor-a',
  capacityPool: 'pool-a',
  pipelines: ['claude'],
  via: 'google',
  scopes: new Set([
    'work.executor',
    'work.capacity.recover',
    'work.capacity.operator',
  ]),
};
const policy = {
  poolId: 'pool-a',
  cluster: 'cluster-a',
  namespace: 'lcars',
  version: 1,
  maxConcurrent: 1,
  maxUnplaced: 1,
  enforced: true,
  inventoryKnown: false,
  domains: { claude: { domainId: 'claude-global', ceiling: 1 } },
};
const recoveryNonce = 'recovery-nonce-123456';
afterEach(() => vi.unstubAllEnvs());

async function call(
  context: RunsContext,
  path: string,
  body?: unknown,
  method = 'POST',
) {
  const result = await createRunsHandler().handle(
    new Request(`https://lcars.test/api/work/v1${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
    { prefix: '/api/work/v1', context },
  );
  const text = await result.response?.text();
  return {
    status: result.response?.status,
    body: text === undefined || text === '' ? undefined : JSON.parse(text),
  };
}
async function fixture(anchor?: { repo: string; issue: number }) {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => now });
  const context: RunsContext = {
    store,
    orchestrator,
    now: () => new Date(now),
    principal,
    capacityEnabled: true,
    tokens: { tokenFor: async () => 'unused-token' },
    checkoutTokens: {
      tokenFor: async () => 'unused-token',
      expiringTokenFor: async () => ({ token: 'unused-token', expiresAt: now }),
      expiringTokenForRepositories: async () => ({
        token: 'unused-token',
        expiresAt: now,
      }),
    },
    drain: async () => ({ dispatched: [], reported: [], failed: [] }),
    codexAuth: {
      read: async () => undefined,
      readLease: async () => undefined,
      createLease: async () => undefined,
      takeLease: async () => undefined,
      releaseLease: async () => undefined,
      replace: async () => undefined,
    },
  };
  expect(
    (await call(context, '/runs/capacity', { action: 'configure', policy }))
      .status,
  ).toBe(200);
  const proposal = {
    action: 'import',
    dryRun: true,
    known: true,
    evidence: 'reviewed-complete-inventory',
    inventory: [],
  };
  const dryRun = await call(context, '/runs/capacity', proposal);
  expect(dryRun.status).toBe(200);
  expect(
    (
      await call(context, '/runs/capacity', {
        ...proposal,
        dryRun: false,
        reviewedDigest: dryRun.body.digest,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(context, '/runs/capacity', {
        action: 'register',
        producerId: 'producer-a',
      })
    ).status,
  ).toBe(200);
  const run = await orchestrator.request({
    taskId: anchor ?? { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3A' },
    requestId: 'capacity-http',
    pipeline: 'claude',
    params: { mode: 'implement' },
    work: {
      origin: { principal: 'user:jlapenna', channel: 'api' },
      spec: {
        title: 'Capacity HTTP contract',
        pipeline: 'claude',
        target: { repo: 'example/capacity' },
      },
    },
  });
  if ('refused' in run || run.run === undefined) throw new Error('Run refused');
  await store.enqueueRun({ runId: run.run.runId, now });
  const request = {
    runner: 'runner-a',
    capacityVersion: 1,
    producerId: 'producer-a',
    claimRequestId: 'first-claim',
  };
  const claimed = await call(context, '/runs/claim', request);
  expect(claimed.status).toBe(200);
  return {
    context,
    protocol: new CapacityProtocol(store),
    claim: claimed.body,
    request,
  };
}
async function attested(f: Awaited<ReturnType<typeof fixture>>) {
  const { context, claim } = f;
  const recovery = { fence: claim.receipt, recoveryNonce };
  expect(
    (await call(context, '/runs/capacity', { action: 'recover', ...recovery }))
      .status,
  ).toBe(200);
  expect(
    (
      await call(context, '/runs/capacity', {
        action: 'bind',
        ...recovery,
        jobUid: 'job-original',
        jobName: claim.jobName,
        podUid: 'pod-original',
        secretUid: 'secret-original',
        secretTokenHash: hashRunToken(claim.token),
        placed: true,
        deleting: false,
        owned: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(context, '/runs/capacity', {
        action: 'attest',
        ...recovery,
        jobUid: 'job-original',
        podUid: 'pod-original',
        generation: 1,
        owned: true,
      })
    ).status,
  ).toBe(200);
}

describe('receipt HTTP authority and activation', () => {
  it('an unavailable GitHub lifecycle verifier quarantines a receipt without exposing a token', async () => {
    const f = await fixture({ repo: 'example/capacity', issue: 2311 });
    expect(f.claim.kind).toBe('quarantined-unrecoverable-token');
    expect(f.claim).not.toHaveProperty('token');
    expect((await f.protocol.read(now)).receipts[0]?.state).toBe('quarantined');
  });
  it('returns a discriminated claim and no reconstructed secret on replay', async () => {
    const { context, claim, request } = await fixture();
    expect(claim.kind).toBe('claim');
    expect(claim).not.toHaveProperty('tokenHash');
    const replay = await call(context, '/runs/claim', request);
    expect(replay.body).toEqual({
      kind: 'quarantined-unrecoverable-token',
      runId: claim.runId,
      jobName: claim.jobName,
    });
    expect(replay.body).not.toHaveProperty('token');
  });
  it('pool/domain cannot be selected by the caller and enforced legacy grants fail closed', async () => {
    const { context, request } = await fixture();
    expect(
      (
        await call(context, '/runs/claim', {
          ...request,
          poolId: 'another-pool',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          { ...context, principal: { ...principal, capacityPool: undefined } },
          '/runs/claim',
          { runner: 'legacy' },
        )
      ).status,
    ).toBe(409);
    expect(
      (await call(context, '/runs/claim', { runner: 'legacy' })).status,
    ).toBe(409);
    expect(
      (
        await call(
          { ...context, capacityEnabled: false },
          '/runs/claim',
          request,
        )
      ).status,
    ).toBe(409);
  });
  it('ordinary executor scopes cannot attest workers or fence an incarnation', async () => {
    const { context, claim } = await fixture();
    const ordinary = {
      ...context,
      principal: { ...principal, scopes: new Set(['work.executor'] as const) },
    };
    expect(
      (
        await call(ordinary, '/runs/capacity', {
          action: 'recover',
          fence: claim.receipt,
          recoveryNonce,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(ordinary, '/runs/capacity', {
          action: 'stop-producer',
          fence: claim.receipt,
          producerId: 'producer-a',
          producerSubject: principal.subject,
          fenced: true,
          evidence: 'claimed-dead',
        })
      ).status,
    ).toBe(401);
    expect(
      (await call(ordinary, '/runs/capacity/metrics', undefined, 'GET')).status,
    ).toBe(401);
  });
  it('arbitrary body Pod UID and unverified workload identity cannot activate', async () => {
    const f = await fixture();
    await attested(f);
    const input = { fence: f.claim.receipt, jobUid: 'job-original' };
    expect(
      (
        await call(
          { ...f.context, bearerToken: f.claim.token },
          '/runs/activate',
          { ...input, podUid: 'pod-original' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          { ...f.context, bearerToken: f.claim.token },
          '/runs/activate',
          input,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          {
            ...f.context,
            bearerToken: f.claim.token,
            workerIdentityToken: 'forged-jwt',
          },
          '/runs/activate',
          input,
        )
      ).status,
    ).toBe(401);
  });
  it('exact verified workload can activate and heartbeat; duplicate UID and stale generation cannot', async () => {
    const f = await fixture();
    await attested(f);
    const worker = {
      ...f.context,
      principal: undefined,
      bearerToken: f.claim.token,
      workerIdentityToken: 'bound-jwt',
      verifyWorkerIdentity: async () => ({
        podUid: 'pod-original',
        namespace: 'lcars',
      }),
    };
    expect(
      await call(worker, '/runs/activate', {
        fence: f.claim.receipt,
        jobUid: 'job-original',
      }),
    ).toEqual({ status: 200, body: { generation: 1 } });
    expect(
      (
        await call(
          {
            ...worker,
            verifyWorkerIdentity: async () => ({
              podUid: 'duplicate-pod',
              namespace: 'lcars',
            }),
          },
          '/runs/activate',
          { fence: f.claim.receipt, jobUid: 'job-original' },
        )
      ).status,
    ).toBe(401);
    const heartbeatPath = `/runs/${encodeURIComponent(f.claim.runId)}/heartbeat`;
    expect(
      (await call({ ...worker, workerGeneration: 1 }, heartbeatPath, {}))
        .status,
    ).toBe(200);
    expect(
      (await call({ ...worker, workerGeneration: 2 }, heartbeatPath, {}))
        .status,
    ).toBe(409);
    expect(
      (
        await call(
          {
            ...worker,
            workerGeneration: 1,
            verifyWorkerIdentity: async () => ({
              podUid: 'pod-original',
              namespace: 'foreign-namespace',
            }),
          },
          heartbeatPath,
          {},
        )
      ).status,
    ).toBe(401);
  });
  it('metrics expose declared pool/domain bounds and fencing refusals without run/token labels', async () => {
    const f = await fixture();
    const metrics = await call(
      f.context,
      '/runs/capacity/metrics',
      undefined,
      'GET',
    );
    expect(metrics.status).toBe(200);
    expect(metrics.body).toContain(
      'lcars_capacity_slots{pool="pool-a",state="unplaced"} 1',
    );
    expect(metrics.body).toContain(
      'lcars_capacity_domain_workers{domain="claude-global"} 0',
    );
    expect(metrics.body).not.toContain(f.claim.runId);
    expect(metrics.body).not.toContain(f.claim.token);
    expect(capacityAuthority(principal).capabilities.has('fence')).toBe(false);
  });
});

describe('real signed Pod-bound Kubernetes JWT verification', () => {
  it('validates signature/issuer/audience/namespace/service-account binding and requires Pod UID', async () => {
    vi.stubEnv(
      'AGENT_LCARS_CAPACITY_WORKER_IDENTITIES',
      JSON.stringify([
        {
          poolId: 'pool-a',
          issuer: 'https://cluster.example',
          jwksUri: 'https://cluster.example/keys',
          audience: 'lcars-capacity',
          namespace: 'lcars',
          serviceAccountUid: 'sa-uid',
        },
      ]),
    );
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(publicKey)), kid: 'local-key', alg: 'RS256' },
      ],
    });
    const token = (bound: unknown, audience = 'lcars-capacity') =>
      new SignJWT({ 'kubernetes.io': bound })
        .setProtectedHeader({ alg: 'RS256', kid: 'local-key' })
        .setIssuer('https://cluster.example')
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    const bound = {
      namespace: 'lcars',
      pod: { uid: 'pod-original' },
      serviceaccount: { uid: 'sa-uid' },
    };
    expect(
      await verifyCapacityWorkerIdentity(await token(bound), 'pool-a', jwks),
    ).toEqual({ podUid: 'pod-original', namespace: 'lcars' });
    for (const invalid of [
      { ...bound, pod: undefined },
      { ...bound, namespace: 'foreign' },
      { ...bound, serviceaccount: { uid: 'wrong-sa' } },
    ])
      await expect(
        verifyCapacityWorkerIdentity(await token(invalid), 'pool-a', jwks),
      ).rejects.toThrow();
    await expect(
      verifyCapacityWorkerIdentity(
        await token(bound, 'foreign-audience'),
        'pool-a',
        jwks,
      ),
    ).rejects.toThrow();
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ 'kubernetes.io': bound })
      .setProtectedHeader({ alg: 'RS256', kid: 'local-key' })
      .setIssuer('https://cluster.example')
      .setAudience('lcars-capacity')
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(
      verifyCapacityWorkerIdentity(forged, 'pool-a', jwks),
    ).rejects.toThrow();
  });
});
