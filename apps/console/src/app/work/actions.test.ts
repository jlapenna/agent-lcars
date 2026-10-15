import { logger } from '@agent-lcars/logging';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  token: vi.fn(),
  context: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  resolveRepo: vi.fn(),
  githubGet: vi.fn(),
  issueCreate: vi.fn(),
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
    rest: {
      repos: { get: mocks.githubGet },
      issues: { create: mocks.issueCreate },
    },
  })),
}));
vi.mock('@/lib/quick-task-evidence-lifecycle', () => ({
  createQuickTaskEvidenceLifecycle: mocks.createLifecycle,
}));
vi.mock('@/lib/work-mint', () => ({
  isWorkOperatorPrincipal: mocks.isOperator,
  forbiddenReason: mocks.forbiddenReason,
}));

import {
  createItem,
  createItemWithEvidence,
  createTrackingIssue,
} from './actions';

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
  it.each(['urgent', 'background', undefined])(
    'preserves evidence priority %s with a normal default',
    async (priority) => {
      await createItemWithEvidence(form({ ...intent, priority }));
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({ priority: priority ?? 'normal' }),
        }),
      );
    },
  );

  it('rejects unknown priority before evidence storage or native creation', async () => {
    expect(
      (
        await createItemWithEvidence(form({ ...intent, priority: 'immediate' }))
      )[0],
    ).toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.createLifecycle).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
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

  it('requests a new sign-in for a rejected GitHub credential before any evidence or Work mutation', async () => {
    mocks.githubGet.mockRejectedValueOnce(
      Object.assign(new Error('Bad credentials: private server detail'), {
        status: 401,
      }),
    );

    const [error, data] = await createItemWithEvidence(form());

    expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(error?.message).toContain('Sign out and sign in again');
    expect(error?.message).not.toContain('private server detail');
    expect(data).toBeUndefined();
    expect(mocks.createLifecycle).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('authorizes a valid GitHub credential before uploading evidence and creating Work', async () => {
    const [error, data] = await createItemWithEvidence(form());

    expect(error).toBeUndefined();
    expect(data).toEqual({ id: intent.workId });
    expect(mocks.githubGet).toHaveBeenCalledWith({
      owner: 'jlapenna',
      repo: 'agent-lcars',
    });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 42, visibility: 'private' }),
    );
    expect(mocks.githubGet.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepare.mock.invocationCallOrder[0],
    );
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0],
    );
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

  it('retains a generation when a concurrent exact-binding retry wins before a conflict', async () => {
    mocks.prepare.mockResolvedValue({
      generation: '7',
      createdByCall: true,
      binding: {},
    });
    mocks.create.mockResolvedValue([
      { code: 'CONFLICT', message: 'different spec' },
      undefined,
    ]);
    await createItemWithEvidence(form());
    expect(mocks.prepare).toHaveBeenCalled();
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('turns an unexpected create throw into a coded error instead of rejecting', async () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    mocks.create.mockRejectedValue(new Error('firestore unavailable'));
    const [error, data] = await createItem({
      id: intent.workId,
      spec: {
        title: 't',
        description: 'd',
        pipeline: 'codex',
        target: { repo: 'jlapenna/agent-lcars' },
      },
    });
    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(data).toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it.each(['context', 'githubGet', 'create'] as const)(
    'contains an unexpected %s failure without exposing server details',
    async (stage) => {
      const failure = Object.assign(new Error('private server detail'), {
        status: 503,
      });
      const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      mocks[stage].mockRejectedValueOnce(failure);
      try {
        const [error, data] = await createItemWithEvidence(form());

        expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
        expect(error?.message).not.toContain('private server detail');
        expect(data).toBeUndefined();
        expect(log).toHaveBeenCalledWith('work item creation failed', failure);
        expect(mocks.rollback).not.toHaveBeenCalled();
        expect(mocks.prepare).toHaveBeenCalledTimes(stage === 'create' ? 1 : 0);
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe('createTrackingIssue', () => {
  const input = {
    workId: intent.workId,
    repository: intent.repository,
    title: 'Tracking',
    body: 'Body',
  };

  it('requests a new sign-in when GitHub rejects the user credential', async () => {
    mocks.issueCreate.mockRejectedValueOnce(
      Object.assign(new Error('Bad credentials: private detail'), {
        status: 401,
      }),
    );

    const [error, data] = await createTrackingIssue(input);

    expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(error?.message).toContain('Sign out and sign in again');
    expect(error?.message).not.toContain('private detail');
    expect(data).toBeUndefined();
  });

  it('files the issue with a valid credential', async () => {
    mocks.issueCreate.mockResolvedValueOnce({
      data: {
        number: 7,
        html_url: 'https://github.com/jlapenna/agent-lcars/issues/7',
      },
    });

    const [error, data] = await createTrackingIssue(input);

    expect(error).toBeUndefined();
    expect(data).toEqual({
      number: 7,
      url: 'https://github.com/jlapenna/agent-lcars/issues/7',
    });
  });
});
