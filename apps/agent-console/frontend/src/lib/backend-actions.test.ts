import {
  cancelWorkflowRun,
  clearHumanNeededLabel,
  closeIssue,
  createQuickTask,
  deriveQuickTaskTitle,
  dispatchUnstickPrs,
  evictNxCache,
} from './backend-actions';
import { getGithubClient } from './github-client';

jest.mock('./github-client', () => ({
  getGithubClient: jest.fn(),
  REPO_OWNER: 'supersprinklesracing',
  REPO_NAME: 'members',
}));

describe('closeIssue', () => {
  it('closes the given issue on the console repo', async () => {
    const update = jest.fn().mockResolvedValue({});
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: { issues: { update } },
    });

    await closeIssue(2709);

    expect(update).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'members',
      issue_number: 2709,
      state: 'closed',
    });
  });

  it('propagates a GitHub API error', async () => {
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        issues: {
          update: jest
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
      },
    });

    await expect(closeIssue(2709)).rejects.toThrow('Not Found');
  });
});

describe('clearHumanNeededLabel', () => {
  it('removes the human-needed label from the given issue', async () => {
    const removeLabel = jest.fn().mockResolvedValue({});
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: { issues: { removeLabel } },
    });

    await clearHumanNeededLabel(2709);

    expect(removeLabel).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'members',
      issue_number: 2709,
      name: 'human-needed',
    });
  });

  it('swallows a 404 (label was already absent)', async () => {
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        issues: {
          removeLabel: jest
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
      },
    });

    await expect(clearHumanNeededLabel(2709)).resolves.toBeUndefined();
  });
});

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

describe('deriveQuickTaskTitle', () => {
  it('takes the first line and collapses internal whitespace', () => {
    expect(
      deriveQuickTaskTitle('Fix the   flaky   test\nmore detail here'),
    ).toBe('Fix the flaky test');
  });

  it('truncates long first lines with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const title = deriveQuickTaskTitle(long);
    expect(title.length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('leaves short first lines untouched', () => {
    expect(deriveQuickTaskTitle('short task')).toBe('short task');
  });
});

describe('createQuickTask', () => {
  function mockOctokit(overrides: {
    createLabel?: jest.Mock;
    createIssue?: jest.Mock;
    addLabels?: jest.Mock;
  }) {
    const createLabel =
      overrides.createLabel ?? jest.fn().mockResolvedValue({});
    const createIssue =
      overrides.createIssue ??
      jest.fn().mockResolvedValue({
        data: { number: 99, html_url: 'https://github.com/x/y/issues/99' },
      });
    const addLabels = overrides.addLabels ?? jest.fn().mockResolvedValue({});
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        issues: { createLabel, create: createIssue, addLabels },
      },
    });
    return { createLabel, createIssue, addLabels };
  }

  it('rejects a blank description without calling GitHub', async () => {
    const { createIssue } = mockOctokit({});

    await expect(createQuickTask('   ')).rejects.toThrow(
      'Task description is required',
    );
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('creates the quick-task label, files the issue, then adds claude as a follow-up call', async () => {
    const { createLabel, createIssue, addLabels } = mockOctokit({});

    const result = await createQuickTask(
      '  Fix the flaky test\nmore context  ',
    );

    expect(createLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'supersprinklesracing',
        repo: 'members',
        name: 'quick-task',
      }),
    );
    expect(createIssue).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'members',
      title: 'Fix the flaky test',
      body: 'Fix the flaky test\nmore context',
      labels: ['quick-task'],
    });
    expect(addLabels).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'members',
      issue_number: 99,
      labels: ['claude'],
    });
    // The claude label must be added AFTER the issue is created, and via a
    // separate call - not folded into the create() labels - or the
    // `issues: labeled` webhook claude.yml listens for never fires.
    expect(addLabels.mock.invocationCallOrder[0]).toBeGreaterThan(
      createIssue.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({
      url: 'https://github.com/x/y/issues/99',
      number: 99,
    });
  });

  it('tolerates the quick-task label already existing (422)', async () => {
    const { createIssue } = mockOctokit({
      createLabel: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('exists'), { status: 422 })),
    });

    await createQuickTask('Some task');

    expect(createIssue).toHaveBeenCalled();
  });

  it('propagates a non-422 label creation failure', async () => {
    mockOctokit({
      createLabel: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Forbidden'), { status: 403 }),
        ),
    });

    await expect(createQuickTask('Some task')).rejects.toThrow('Forbidden');
  });
});
