import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  githubAccessTokenFor,
  createGithubUserClient,
  createIssue,
  isE2eTesting,
  isOnGoogleCloud,
} = vi.hoisted(() => ({
  githubAccessTokenFor: vi.fn(),
  createGithubUserClient: vi.fn(),
  createIssue: vi.fn(),
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
    rest: { issues: { create: createIssue } },
  });
  isE2eTesting.mockReturnValue(false);
  isOnGoogleCloud.mockReturnValue(false);
});

describe('quickTaskIssueCreatorFor', () => {
  it('builds the issue creator from the signed-in operator token', async () => {
    createIssue.mockResolvedValue({ data: { number: 42 } });

    const creator = quickTaskIssueCreatorFor(session);
    await creator?.({ owner: 'jlapenna', repo: 'agent-lcars', title: 'Task' });

    expect(createGithubUserClient).toHaveBeenCalledWith('operator-oauth-token');
    expect(createIssue).toHaveBeenCalledWith({
      owner: 'jlapenna',
      repo: 'agent-lcars',
      title: 'Task',
    });
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
