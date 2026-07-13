import {
  cancelWorkflowRun,
  dispatchUnstickPrs,
  evictNxCache,
} from './backend-actions';
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

describe('dispatchUnstickPrs', () => {
  it('dispatches playbook-unstick-prs.yml with a trimmed context input', async () => {
    const createWorkflowDispatch = jest.fn().mockResolvedValue({});
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: { actions: { createWorkflowDispatch } },
    });

    await dispatchUnstickPrs('  PR #123 stuck  ');

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'members',
      workflow_id: 'playbook-unstick-prs.yml',
      ref: 'main',
      inputs: { context: 'PR #123 stuck' },
    });
  });

  it('omits the context input when none is given', async () => {
    const createWorkflowDispatch = jest.fn().mockResolvedValue({});
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: { actions: { createWorkflowDispatch } },
    });

    await dispatchUnstickPrs();

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: {} }),
    );
  });
});

describe('evictNxCache', () => {
  it('dispatches playbook-evict-nx-cache.yml with the capture flag stringified', async () => {
    const createWorkflowDispatch = jest.fn().mockResolvedValue({});
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: { actions: { createWorkflowDispatch } },
    });

    await evictNxCache(true);

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'members',
      workflow_id: 'playbook-evict-nx-cache.yml',
      ref: 'main',
      inputs: { capture: 'true' },
    });
  });
});
