import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  githubAccessTokenFor,
  createGithubUserClient,
  createIssue,
  getRepository,
  isE2eTesting,
  isOnGoogleCloud,
} = vi.hoisted(() => ({
  githubAccessTokenFor: vi.fn(),
  createGithubUserClient: vi.fn(),
  createIssue: vi.fn(),
  getRepository: vi.fn(),
  isE2eTesting: vi.fn(() => false),
  isOnGoogleCloud: vi.fn(() => false),
}));

vi.mock('../auth', () => ({ githubAccessTokenFor }));
vi.mock('./github-client', () => ({ createGithubUserClient }));
vi.mock('@agent-lcars/util-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-lcars/util-server')>()),
  isE2eTesting,
  isOnGoogleCloud,
}));

import { quickTaskIssueCreatorFor } from './quick-task-author';

const session = {
  user: { isAdmin: true },
  expires: '2026-09-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  githubAccessTokenFor.mockReturnValue('operator-oauth-token');
  createGithubUserClient.mockReturnValue({
    rest: {
      issues: { create: createIssue },
      repos: { get: getRepository },
    },
  });
  getRepository.mockResolvedValue({ data: { permissions: { push: true } } });
  isE2eTesting.mockReturnValue(false);
  isOnGoogleCloud.mockReturnValue(false);
});

describe('quickTaskIssueCreatorFor', () => {
  it('builds the issue creator from the signed-in operator token', async () => {
    createIssue.mockResolvedValue({ data: { number: 42 } });

    const creator = quickTaskIssueCreatorFor(session);
    await creator?.({ owner: 'jlapenna', repo: 'agent-lcars', title: 'Task' });

    expect(createGithubUserClient).toHaveBeenCalledWith('operator-oauth-token');
    expect(getRepository).toHaveBeenCalledWith({
      owner: 'jlapenna',
      repo: 'agent-lcars',
    });
    expect(createIssue).toHaveBeenCalledWith({
      owner: 'jlapenna',
      repo: 'agent-lcars',
      title: 'Task',
    });
  });

  it('rejects before creation when GitHub would silently drop labels', async () => {
    getRepository.mockResolvedValue({ data: { permissions: { push: false } } });

    const creator = quickTaskIssueCreatorFor(session);
    await expect(
      creator?.({ owner: 'jlapenna', repo: 'agent-lcars', title: 'Task' }),
    ).rejects.toThrow(
      'Your GitHub account cannot apply Quick Task labels in jlapenna/agent-lcars',
    );
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('fails closed when a production session predates the OAuth token claim', () => {
    githubAccessTokenFor.mockReturnValue(undefined);

    expect(() => quickTaskIssueCreatorFor(session)).toThrow(
      'Sign out and back in before filing a Quick Task',
    );
    expect(createGithubUserClient).not.toHaveBeenCalled();
  });

  it('keeps the header-backed local E2E fixture path credential-free', () => {
    githubAccessTokenFor.mockReturnValue(undefined);
    isE2eTesting.mockReturnValue(true);

    expect(quickTaskIssueCreatorFor(session)).toBeUndefined();
    expect(createGithubUserClient).not.toHaveBeenCalled();
  });

  it('does not allow the E2E escape hatch on Google Cloud', () => {
    githubAccessTokenFor.mockReturnValue(undefined);
    isE2eTesting.mockReturnValue(true);
    isOnGoogleCloud.mockReturnValue(true);

    expect(() => quickTaskIssueCreatorFor(session)).toThrow(
      'Sign out and back in before filing a Quick Task',
    );
  });
});
