import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  token: vi.fn(),
  context: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  resolveRepo: vi.fn(),
  githubGet: vi.fn(),
  createLifecycle: vi.fn(),
  prepare: vi.fn(),
  rollback: vi.fn(),
  isOperator: vi.fn(),
  forbiddenReason: vi.fn(),
}));

vi.mock('@/auth', () => ({
  auth: mocks.auth,
  githubAccessTokenFor: mocks.token,
}));
vi.mock('./context', () => ({ context: mocks.context }));
vi.mock('@/lib/work-router', () => ({
  workRouter: {
    create: 'create',
    cancel: 'cancel',
    redispatch: 'redispatch',
    reply: 'reply',
    get: 'get',
    list: 'list',
  },
}));
vi.mock('@orpc/next', () => ({
  createServerFunctionable: vi.fn(
    () => (procedure: string) =>
      procedure === 'create' ? mocks.create : mocks.cancel,
  ),
}));
vi.mock('@/lib/github-client', () => ({
  resolveWatchedRepo: mocks.resolveRepo,
  createGithubUserClient: vi.fn(() => ({
    rest: { repos: { get: mocks.githubGet } },
  })),
}));
vi.mock('@/lib/quick-task-evidence-lifecycle', () => ({
  createQuickTaskEvidenceLifecycle: mocks.createLifecycle,
}));
vi.mock('@/lib/work-mint', () => ({
  isWorkOperatorPrincipal: mocks.isOperator,
  forbiddenReason: mocks.forbiddenReason,
}));

import { createItemWithEvidence } from './actions';

const intent = {
  workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  requestId: '11111111-1111-4111-8111-111111111111',
  evidenceId: '22222222-2222-4222-8222-222222222222',
  repository: { owner: 'jlapenna', name: 'agent-lcars' },
  pipeline: 'codex',
  description: 'Fix this',
  source: {
    route: '/',
    identities: '',
    capturedAt: '2026-09-10T00:00:00.000Z',
  },
};

function form(value: unknown = intent) {
  const data = new FormData();
  data.set('intent', JSON.stringify(value));
  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', {
    type: 'image/png',
  });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  data.set('evidence', file);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({
    principal: {
      principal: 'user:test',
      scopes: new Set(['work.operator']),
      pipelines: ['codex'],
    },
  });
  mocks.isOperator.mockReturnValue(true);
  mocks.forbiddenReason.mockReturnValue(undefined);
  mocks.auth.mockResolvedValue({ user: { login: 'test' } });
  mocks.token.mockReturnValue('token');
  mocks.resolveRepo.mockImplementation((repo) => repo);
  mocks.githubGet.mockResolvedValue({
    data: { id: 42, visibility: 'private' },
  });
  mocks.prepare.mockResolvedValue({
    generation: '7',
    createdByCall: true,
    binding: {},
  });
  mocks.createLifecycle.mockResolvedValue({
    prepare: mocks.prepare,
    rollbackDefinitiveCreateFailure: mocks.rollback,
  });
  mocks.create.mockResolvedValue([undefined, { id: intent.workId }]);
  process.env.AUTH_URL = 'https://lcars.jlapenna.net';
  process.env.QUICK_TASK_EVIDENCE_BUCKET = 'evidence';
});

describe('createItemWithEvidence', () => {
  it('rejects malformed or unauthorized input before image or storage work', async () => {
    expect((await createItemWithEvidence(form(null)))[0]).toMatchObject({
      code: 'BAD_REQUEST',
    });
    mocks.isOperator.mockReturnValue(false);
    expect((await createItemWithEvidence(form()))[0]).toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mocks.githubGet).not.toHaveBeenCalled();
    expect(mocks.createLifecycle).not.toHaveBeenCalled();
  });

  it('retains evidence when native creation reports an ambiguous internal failure', async () => {
    mocks.create.mockResolvedValue([
      { code: 'INTERNAL_SERVER_ERROR', message: 'unknown commit result' },
      undefined,
    ]);
    await createItemWithEvidence(form());
    expect(mocks.prepare).toHaveBeenCalled();
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('rolls back a newly prepared generation after a definitive precommit conflict', async () => {
    const prepared = { generation: '7', createdByCall: true, binding: {} };
    mocks.prepare.mockResolvedValue(prepared);
    mocks.create.mockResolvedValue([
      { code: 'CONFLICT', message: 'different spec' },
      undefined,
    ]);
    await createItemWithEvidence(form());
    expect(mocks.rollback).toHaveBeenCalledWith(prepared);
  });
});
