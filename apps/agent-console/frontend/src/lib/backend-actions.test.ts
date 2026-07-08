import { cancelWorkflowRun } from './backend-actions';
import { getGithubClient } from './github-client';

jest.mock('./github-client', () => ({
  getGithubClient: jest.fn(),
  REPO_OWNER: 'supersprinklesracing',
  REPO_NAME: 'members',
}));

describe('cancelWorkflowRun', () => {
  it('cancels the given run on the console repo', async () => {
    const cancelWorkflowRun_ = jest.fn().mockResolvedValue({});
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: { actions: { cancelWorkflowRun: cancelWorkflowRun_ } },
    });

    await cancelWorkflowRun(12345);

    expect(cancelWorkflowRun_).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'members',
      run_id: 12345,
    });
  });

  it('propagates a GitHub API error (e.g. the run already completed)', async () => {
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        actions: {
          cancelWorkflowRun: jest
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Conflict'), { status: 409 }),
            ),
        },
      },
    });

    await expect(cancelWorkflowRun(12345)).rejects.toThrow('Conflict');
  });
});
