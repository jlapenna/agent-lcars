// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Run } from '@agent-lcars/orchestrator';
import { beforeEach, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { jobProfileSchema } from './repository-job-definition';
import { hashRunToken } from './run-token';
import { createRunsHandler, type RunsContext } from './runs-router';

const mocks = vi.hoisted(() => ({ jobs: vi.fn() }));
vi.mock('./repository-jobs-runtime', () => ({ repositoryJobs: mocks.jobs }));
const workId = '01JOBS00000000000000000000';
const runId = `work:${workId}/r1`;
const now = new Date('2026-11-04T00:00:00Z');
let run: Run;
const authorize = vi.fn();
const credential = vi.fn();
const appToken = vi.fn();
const readOccurrence = vi.fn();
let context: RunsContext;
beforeEach(() => {
  vi.resetAllMocks();
  run = {
    runId,
    task: { workId },
    pipeline: 'goose',
    state: 'running',
    params: { jobOccurrence: 'b'.repeat(64) },
    leaseExpiresAt: '2026-11-04T01:00:00Z',
    queue: { tokenHash: hashRunToken('fixture-run-token') },
  } as Run;
  readOccurrence.mockResolvedValue({
    workId,
    definition: { repository: 'jlapenna/dev' },
    profile: {
      name: 'personal',
      credentialSet: { name: 'personal', revision: 1 },
    },
    secretSnapshot: {
      credentialSet: { name: 'personal', revision: 1 },
      versions: { 'github-jlapenna': '1' },
    },
  });
  authorize.mockReturnValue({
    credentialSet: { name: 'personal', revision: 1 },
    gitIdentity: { name: 'Joe LaPenna', email: 'joe@example.invalid' },
  });
  credential.mockResolvedValue({
    token: 'fixture-user-token',
    login: 'jlapenna',
    expiresAt: null,
    refreshAt: '2026-11-04T00:05:00Z',
  });
  mocks.jobs.mockReturnValue({
    deps: { store: { readOccurrence } },
    authorizeOccurrence: authorize,
  });
  context = {
    bearerToken: 'fixture-run-token',
    store: {
      readRun: async () => run,
      readTask: async () => ({
        task: { work: { spec: { target: { repo: 'jlapenna/dev' } } } },
      }),
    },
    now: () => now,
    checkoutTokens: { expiringTokenFor: appToken },
    jobCredentials: {
      refused: vi.fn(async () => undefined),
      github: credential,
      deliver: vi.fn(async () => ({ environment: {}, files: {} })),
    },
  } as unknown as RunsContext;
});
async function request(path = 'checkout-token') {
  const { response } = await createRunsHandler().handle(
    new Request(
      `https://console.test/api/work/v1/runs/${encodeURIComponent(runId)}/${path}`,
    ),
    { prefix: '/api/work/v1', context },
  );
  return { status: response!.status, body: await response!.json() };
}
it('vends the authorized occurrence identity to both runner credential consumers', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    token: 'fixture-user-token',
    expiresAt: null,
    identity: {
      login: 'jlapenna',
      git: { name: 'Joe LaPenna', email: 'joe@example.invalid' },
    },
  });
  expect(credential).toHaveBeenCalledExactlyOnceWith(
    await readOccurrence(),
    (await readOccurrence()).secretSnapshot,
  );
  expect(appToken).not.toHaveBeenCalled();
});
it.each([
  'foreign-occurrence',
  'revoked-profile',
  'invalid-run-token',
  'expired-credential',
])('refuses %s without a bot fallback', async (failure) => {
  if (failure === 'foreign-occurrence')
    readOccurrence.mockResolvedValue({
      workId: 'foreign',
      definition: { repository: 'jlapenna/dev' },
    });
  if (failure === 'revoked-profile')
    authorize.mockImplementation(() => {
      throw new Error('Reserved execution profile changed');
    });
  if (failure === 'invalid-run-token') context.bearerToken = 'wrong';
  if (failure === 'expired-credential')
    credential.mockRejectedValue(new Error('fixture-private-error'));
  const response = await request();
  expect(response.status).toBe(
    failure === 'invalid-run-token'
      ? 401
      : failure === 'expired-credential'
        ? 409
        : 403,
  );
  expect(appToken).not.toHaveBeenCalled();
  expect(JSON.stringify(response.body)).not.toContain('fixture-private-error');
  expect(credential).toHaveBeenCalledTimes(
    failure === 'expired-credential' ? 1 : 0,
  );
  expect(context.jobCredentials?.refused).toHaveBeenCalledTimes(
    failure === 'expired-credential' ? 1 : 0,
  );
});
it('keeps ordinary Goose profiles on installation credentials', async () => {
  authorize.mockReturnValue({ name: 'repository' });
  appToken.mockResolvedValue({
    token: 'fixture-app-token',
    expiresAt: '2026-11-04T01:00:00Z',
  });
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.body.token).toBe('fixture-app-token');
  expect(response.body.identity).toBeUndefined();
  expect(credential).not.toHaveBeenCalled();
});

it('uses leased Codex auth for the deployed eval profile with repository App checkout and no job secrets', async () => {
  const config = parseYaml(
    readFileSync(
      path.join(import.meta.dirname, '../../apphosting.yaml'),
      'utf8',
    ),
  ) as { env: { variable: string; value?: string }[] };
  const profiles = JSON.parse(
    config.env.find((entry) => entry.variable === 'AGENT_LCARS_JOB_PROFILES')!
      .value!,
  ) as { name: string }[];
  const profile = jobProfileSchema.parse(
    profiles.find((entry) => entry.name === 'skill-evals'),
  );
  run.params = { ...run.params, providerAuth: profile.providerAuth };
  authorize.mockReturnValue(profile);
  readOccurrence.mockResolvedValue({
    workId,
    definition: { repository: 'jlapenna/agent-lcars', name: 'skill-evals' },
    profile,
  });
  context.store.readTask = vi.fn(async () => ({
    task: { work: { spec: { target: { repo: 'jlapenna/agent-lcars' } } } },
  })) as typeof context.store.readTask;
  const reserve = vi.fn(async () => ({
    refused: true,
    reason: 'credential-operation-pending',
  }));
  context.store.transactRun = reserve;
  appToken.mockResolvedValue({
    token: 'fixture-app-token',
    expiresAt: '2026-11-04T01:00:00Z',
  });

  const delivered = await request('job-secrets');
  expect(delivered.status).toBe(200);
  expect(delivered.body).toEqual({ environment: {}, files: {} });
  expect(context.jobCredentials!.deliver).not.toHaveBeenCalled();
  expect(credential).not.toHaveBeenCalled();
  const checkout = await request();
  expect(checkout.status).toBe(200);
  expect(checkout.body.token).toBe('fixture-app-token');
  expect(checkout.body.identity).toBeUndefined();
  expect(appToken).toHaveBeenCalledExactlyOnceWith('jlapenna/agent-lcars');
  // A controlled refusal proves the real deployed profile reaches the shared
  // lease broker, without issuing credentials or performing provider work.
  const provider = await request('codex-auth');
  expect(provider.status).toBe(409);
  expect(reserve).toHaveBeenCalledTimes(1);
});

it.each([
  'ordinary',
  'forged-provider',
  'foreign-occurrence',
  'revoked-profile',
])(
  'refuses Codex auth for %s recipes before any credential store IO',
  async (failure) => {
    const read = vi.fn();
    context.codexAuth = { read } as unknown as RunsContext['codexAuth'];
    if (failure !== 'ordinary')
      run.params = { ...run.params, providerAuth: 'codex' };
    if (failure === 'foreign-occurrence')
      readOccurrence.mockResolvedValue({
        workId: 'foreign',
        definition: { repository: 'jlapenna/dev' },
      });
    if (failure === 'revoked-profile')
      authorize.mockImplementation(() => {
        throw new Error('revoked');
      });
    const response = await request('codex-auth');
    expect(response.status).toBe(failure === 'ordinary' ? 401 : 403);
    expect(read).not.toHaveBeenCalled();
  },
);

it('authorizes a Codex-enabled recipe before entering the existing lease broker', async () => {
  run.params = { ...run.params, providerAuth: 'codex' };
  authorize.mockReturnValue({ name: 'skill-evals', providerAuth: 'codex' });
  // A deliberate controlled broker refusal proves the request reached the
  // broker only after exact profile authorization; it vends no credentials.
  const reserve = vi.fn(async () => ({
    refused: true,
    reason: 'credential-operation-pending',
  }));
  context.store = {
    ...context.store,
    transactRun: reserve,
  } as unknown as RunsContext['store'];
  const response = await request('codex-auth');
  expect(response.status).toBe(409);
  expect(authorize).toHaveBeenCalled();
  expect(reserve).toHaveBeenCalled();
});
