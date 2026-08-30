import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  auth,
  createQuickTask,
  resolveWatchedRepo,
  createLifecycle,
  userIssueCreator,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  createQuickTask: vi.fn(),
  resolveWatchedRepo: vi.fn(),
  createLifecycle: vi.fn(),
  userIssueCreator: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth }));
vi.mock('@/lib/backend-actions', () => ({
  ActionError: class ActionError extends Error {},
  createQuickTask,
}));
vi.mock('@/lib/github-client', () => ({ resolveWatchedRepo }));
vi.mock('@/lib/quick-task-evidence-lifecycle', () => ({
  createQuickTaskEvidenceLifecycle: createLifecycle,
}));
vi.mock('@/lib/quick-task-author', () => ({
  quickTaskIssueCreatorFor: vi.fn(() => userIssueCreator),
}));

import { POST } from './route';

const intent = {
  requestId: '11111111-1111-4111-8111-111111111111',
  evidenceId: '22222222-2222-4222-8222-222222222222',
  repository: { owner: 'jlapenna', name: 'agent-lcars' },
  pipeline: 'codex',
  description: 'Fix this',
  source: {
    route: '/',
    identities: '',
    capturedAt: '2026-08-14T00:00:00.000Z',
  },
};

function request(
  file = true,
  suppliedEntries?: Array<[string, FormDataEntryValue]>,
) {
  const request = new Request('https://lcars.test/api/quick-task/v1', {
    method: 'POST',
  });
  const evidence = file
    ? {
        size: 3,
        arrayBuffer: async () => new TextEncoder().encode('png').buffer,
      }
    : null;
  const entries =
    suppliedEntries ??
    ([
      ['intent', JSON.stringify(intent)],
      ...(evidence
        ? [['evidence', evidence] as [string, FormDataEntryValue]]
        : []),
    ] as Array<[string, FormDataEntryValue]>);
  vi.spyOn(request, 'formData').mockResolvedValue({
    get(name: string) {
      return entries.find(([entryName]) => entryName === name)?.[1] ?? null;
    },
    entries: () => entries[Symbol.iterator](),
  } as FormData);
  return request;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { isAdmin: true } });
  resolveWatchedRepo.mockImplementation((repo) => repo);
  createLifecycle.mockResolvedValue({
    prepare: vi.fn(),
    rollbackDefinitiveCreateFailure: vi.fn(),
  });
  createQuickTask.mockResolvedValue({
    requestId: intent.requestId,
    task: { repository: intent.repository, issueNumber: 7 },
    url: 'https://github.com/jlapenna/agent-lcars/issues/7',
  });
  process.env.AUTH_URL = 'https://lcars.jlapenna.net';
  process.env.QUICK_TASK_EVIDENCE_BUCKET = 'agent-lcars-quick-task-evidence';
});

describe('POST /api/quick-task/v1', () => {
  it('requires an administrator session', async () => {
    auth.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(createQuickTask).not.toHaveBeenCalled();
  });

  it('creates server-composed evidence and retains the supplied identities', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceId: intent.evidenceId,
        bucket: 'agent-lcars-quick-task-evidence',
      }),
    );
    expect(createQuickTask).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: intent.requestId,
        description: expect.stringContaining(
          `/api/quick-task-evidence/v1/${intent.evidenceId}`,
        ),
      }),
      expect.objectContaining({ intent }),
      userIssueCreator,
    );
  });

  it('rejects duplicate or unknown multipart fields before creating a task', async () => {
    const duplicateIntent = await POST(
      request(true, [
        ['intent', JSON.stringify(intent)],
        ['intent', JSON.stringify(intent)],
      ]),
    );
    expect(duplicateIntent.status).toBe(400);

    const unknownField = await POST(
      request(true, [
        ['intent', JSON.stringify(intent)],
        ['unexpected', 'value'],
      ]),
    );
    expect(unknownField.status).toBe(400);
    expect(createQuickTask).not.toHaveBeenCalled();
  });
});
