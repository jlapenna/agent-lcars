import { createHash } from 'node:crypto';

import {
  formatQuickTaskMarker,
  parseTerminalQuickTaskBody,
  quickTaskDigest as contractQuickTaskDigest,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  approveAndMergePr,
  approveAndRebasePr,
  assignPipeline,
  cancelWorkflowRun,
  clearHumanNeededLabel,
  closeIssue,
  createQuickTask,
  deriveQuickTaskTitle,
  dispatchUnstickPrs,
  postComment,
  reassignPipeline,
  retriggerIssue,
  updateIssueContent,
  updatePrBranch,
} from './backend-actions';
import { getGithubClient } from './github-client';

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };
const DISPATCH_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('./github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-client')>();
  return {
    ...actual,
    getGithubClient: vi.fn(),
    getWatchedRepos: vi.fn(() => [DEFAULT_REPO]),
  };
});

describe('closeIssue', () => {
  function mockOctokit() {
    const update = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { update }, actions: { createWorkflowDispatch } },
    });
    return { update, createWorkflowDispatch };
  }

  it('closes the given issue on the console repo', async () => {
    const { update } = mockOctokit();

    await closeIssue(DEFAULT_REPO, 2709);

    expect(update).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      issue_number: 2709,
      state: 'closed',
    });
  });

  it('notifies the dispatch controller to reconcile the closed issue', async () => {
    const { createWorkflowDispatch } = mockOctokit();

    await closeIssue(DEFAULT_REPO, 2709);

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      workflow_id: 'agent-router.yml',
      ref: 'main',
      inputs: { kind: 'reconcile', issue: '2709' },
    });
  });

  it('propagates a GitHub API error and never notifies', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          update: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
        actions: { createWorkflowDispatch },
      },
    });

    await expect(closeIssue(DEFAULT_REPO, 2709)).rejects.toThrow('Not Found');
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("does not fail the close when the reconcile ping's dispatch fails outright", async () => {
    const { update, createWorkflowDispatch } = mockOctokit();
    createWorkflowDispatch.mockRejectedValue(
      Object.assign(new Error('Server Error'), { status: 500 }),
    );

    await expect(closeIssue(DEFAULT_REPO, 2709)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalled();
  });

  it("degrades like retriggerIssue's dispatch when the target repo's router predates kind: reconcile", async () => {
    const { createWorkflowDispatch } = mockOctokit();
    createWorkflowDispatch
      .mockRejectedValueOnce(
        Object.assign(new Error('Unexpected inputs provided: ["kind"]'), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce({});

    await expect(closeIssue(DEFAULT_REPO, 2709)).resolves.toBeUndefined();

    expect(createWorkflowDispatch).toHaveBeenCalledTimes(2);
    expect(createWorkflowDispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inputs: { issue: '2709' } }),
    );
  });

  it('still does not fail the close when even the retried reconcile ping fails', async () => {
    const { update, createWorkflowDispatch } = mockOctokit();
    createWorkflowDispatch.mockRejectedValue(
      Object.assign(new Error('Unexpected inputs provided: ["kind"]'), {
        status: 422,
      }),
    );

    await expect(closeIssue(DEFAULT_REPO, 2709)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalled();
    expect(createWorkflowDispatch).toHaveBeenCalledTimes(2);
  });
});

describe('updateIssueContent', () => {
  it('updates the trimmed title and verbatim body without notifying reconciliation', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { title: 'Old title', body: 'Old body' },
    });
    const update = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, update }, actions: { createWorkflowDispatch } },
    });

    await updateIssueContent(DEFAULT_REPO, 2709, {
      title: '  Sharper title  ',
      body: 'Body with intentional trailing space ',
    });

    expect(update).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      issue_number: 2709,
      title: 'Sharper title',
      body: 'Body with intentional trailing space ',
    });
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('hides and rehashes a Quick Task marker when editing its content', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const hash = (input: string) =>
      createHash('sha256').update(input).digest('hex');
    const original = {
      repository: 'supersprinklesracing/sprinkles',
      pipeline: 'claude',
      title: 'Original quick task',
      description: 'Original description',
    };
    const originalDigest = contractQuickTaskDigest(original, hash);
    const get = vi.fn().mockResolvedValue({
      data: {
        title: original.title,
        body: `${original.description}\n\n${formatQuickTaskMarker({ requestId, digest: originalDigest })}`,
      },
    });
    const update = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, update } },
    });

    await updateIssueContent(DEFAULT_REPO, 2709, {
      title: 'Edited quick task',
      body: 'Edited description',
    });

    const persisted = update.mock.calls[0][0].body as string;
    expect(parseTerminalQuickTaskBody(persisted)).toEqual({
      requestId,
      digest: contractQuickTaskDigest(
        {
          ...original,
          title: 'Edited quick task',
          description: 'Edited description',
        },
        hash,
      ),
      description: 'Edited description',
    });
  });

  it('refuses to add a Quick Task marker to an ordinary issue', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { title: 'Ordinary issue', body: 'Ordinary body' },
    });
    const update = vi.fn();
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, update } },
    });

    await expect(
      updateIssueContent(DEFAULT_REPO, 2709, {
        title: 'Ordinary issue',
        body: formatQuickTaskMarker({
          requestId: '11111111-1111-4111-8111-111111111111',
          digest: 'a'.repeat(64),
        }),
      }),
    ).rejects.toThrow('cannot be added');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an empty title before calling GitHub', async () => {
    const update = vi.fn();
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { update } },
    });

    await expect(
      updateIssueContent(DEFAULT_REPO, 2709, { title: '  ', body: '' }),
    ).rejects.toThrow('Issue title is required');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('updatePrBranch', () => {
  it('updates the PR branch with the latest base branch changes and never notifies', async () => {
    const updateBranch = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { pulls: { updateBranch }, actions: { createWorkflowDispatch } },
    });

    await updatePrBranch(DEFAULT_REPO, 2709);

    expect(updateBranch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 2709,
    });
    // A branch update doesn't write any fact the dispatch ledger tracks -
    // no reconcile ping should ever follow it.
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('propagates a GitHub API error', async () => {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        pulls: {
          updateBranch: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Merge conflict'), { status: 422 }),
            ),
        },
      },
    });

    await expect(updatePrBranch(DEFAULT_REPO, 2709)).rejects.toThrow(
      'Merge conflict',
    );
  });
});

describe('clearHumanNeededLabel', () => {
  function mockOctokit() {
    const removeLabel = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { removeLabel }, actions: { createWorkflowDispatch } },
    });
    return { removeLabel, createWorkflowDispatch };
  }

  it('removes the needs-human status label from the given issue', async () => {
    const { removeLabel } = mockOctokit();

    await clearHumanNeededLabel(DEFAULT_REPO, 2709);

    expect(removeLabel).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      issue_number: 2709,
      name: 'status:needs-human',
    });
  });

  it('notifies the dispatch controller to reconcile after clearing the park state', async () => {
    const { createWorkflowDispatch } = mockOctokit();

    await clearHumanNeededLabel(DEFAULT_REPO, 2709);

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: { kind: 'reconcile', issue: '2709' },
      }),
    );
  });

  it('swallows a 404 (label was already absent) and does not notify', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          removeLabel: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
        actions: { createWorkflowDispatch },
      },
    });

    await expect(
      clearHumanNeededLabel(DEFAULT_REPO, 2709),
    ).resolves.toBeUndefined();
    // The label write never happened - nothing changed for the ledger to
    // learn about.
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });
});

describe('postComment (mention routing)', () => {
  function mockOctokit() {
    const createComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/1#issuecomment-1' },
    });
    const removeLabel = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: { createComment, removeLabel },
        actions: { createWorkflowDispatch },
      },
    });
    return { createComment, removeLabel, createWorkflowDispatch };
  }

  it('rejects a blank body without calling GitHub', async () => {
    const { createComment } = mockOctokit();

    await expect(postComment(DEFAULT_REPO, 2709, '   ')).rejects.toThrow(
      'Comment body is required',
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it('posts plain text when no agent label is present', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2');

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2' }),
    );
  });

  it('appends @claude for an item carrying only the claude label', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', ['agent:claude']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n@claude' }),
    );
  });

  it('appends /oc for an item carrying only the opencode label', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', ['agent:opencode']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n/oc' }),
    );
  });

  it('appends /codex for an item carrying the codex label', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', ['agent:codex']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n/codex' }),
    );
  });

  it('posts plain text for contradictory multi-agent labels', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', [
      'agent:claude',
      'agent:opencode',
    ]);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2' }),
    );
  });

  it('appends an exact @claude command when prose merely mentions it', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Ping @claude please', [
      'agent:claude',
    ]);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Ping @claude please\n\n@claude' }),
    );
  });

  it('appends an exact /oc command when prose merely mentions /opencode', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Please /opencode this', [
      'agent:opencode',
    ]);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Please /opencode this\n\n/oc' }),
    );
  });

  it('clears the needs-human status after posting', async () => {
    const { removeLabel } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'hi', ['agent:claude']);

    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'status:needs-human' }),
    );
  });

  it('posting a comment alone (no label actually cleared) does not notify the dispatch controller', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({
            data: {
              html_url: 'https://github.com/o/r/issues/1#issuecomment-1',
            },
          }),
          // 404: nothing to clear, so clearNeedsHumanLabel's own notify never
          // fires either - isolates that createComment itself is inert from
          // the ledger's perspective, per the seam's own analysis.
          removeLabel: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
        actions: { createWorkflowDispatch },
      },
    });

    await postComment(DEFAULT_REPO, 2709, 'hi', ['agent:claude']);

    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });
});

describe('approveAndRebasePr', () => {
  function mockOctokit() {
    const createReview = vi.fn().mockResolvedValue({});
    const updateBranch = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({ data: { node_id: 'PR_kwAB' } });
    const graphql = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        pulls: { createReview, updateBranch, get },
        actions: { createWorkflowDispatch },
      },
      graphql,
    });
    return { createReview, updateBranch, get, graphql, createWorkflowDispatch };
  }

  it('approves, updates the branch, then enables squash auto-merge - and never notifies', async () => {
    const { createReview, updateBranch, get, graphql, createWorkflowDispatch } =
      mockOctokit();

    await approveAndRebasePr(DEFAULT_REPO, 42);

    expect(createReview).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
      event: 'APPROVE',
    });
    expect(updateBranch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
    });
    expect(get).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
    });
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('enablePullRequestAutoMerge'),
      { pullRequestId: 'PR_kwAB', mergeMethod: 'SQUASH' },
    );
    // Approving, updating the branch, and merely *enabling* auto-merge
    // write no ledger-tracked fact themselves - the eventual merge is a
    // normal GitHub-initiated event agent-router.yml still observes on its
    // own, so no reconcile ping should follow any of these calls.
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('propagates a GitHub API error from the approval step', async () => {
    const { createReview, updateBranch } = mockOctokit();
    createReview.mockRejectedValue(
      Object.assign(new Error('Review already submitted'), { status: 422 }),
    );

    await expect(approveAndRebasePr(DEFAULT_REPO, 42)).rejects.toThrow(
      'Review already submitted',
    );
    expect(updateBranch).not.toHaveBeenCalled();
  });
});

describe('approveAndMergePr', () => {
  function mockOctokit() {
    const createReview = vi.fn().mockResolvedValue({});
    const merge = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        pulls: { createReview, merge },
        actions: { createWorkflowDispatch },
      },
    });
    return { createReview, merge, createWorkflowDispatch };
  }

  it('approves then squash-merges the PR', async () => {
    const { createReview, merge } = mockOctokit();

    await approveAndMergePr(DEFAULT_REPO, 42);

    expect(createReview).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
      event: 'APPROVE',
    });
    expect(merge).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
      merge_method: 'squash',
    });
  });

  it('notifies the dispatch controller to reconcile the merged PR anchor', async () => {
    const { createWorkflowDispatch } = mockOctokit();

    await approveAndMergePr(DEFAULT_REPO, 42);

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      workflow_id: 'agent-router.yml',
      ref: 'main',
      inputs: { kind: 'reconcile', issue: '42' },
    });
  });

  it('propagates a GitHub API error from the approval step and never merges or notifies', async () => {
    const { createReview, merge, createWorkflowDispatch } = mockOctokit();
    createReview.mockRejectedValue(
      Object.assign(new Error('Review already submitted'), { status: 422 }),
    );

    await expect(approveAndMergePr(DEFAULT_REPO, 42)).rejects.toThrow(
      'Review already submitted',
    );
    expect(merge).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('propagates a GitHub API error from the merge step and never notifies', async () => {
    const { merge, createWorkflowDispatch } = mockOctokit();
    merge.mockRejectedValue(
      Object.assign(new Error('Pull Request is not mergeable'), {
        status: 405,
      }),
    );

    await expect(approveAndMergePr(DEFAULT_REPO, 42)).rejects.toThrow(
      'Pull Request is not mergeable',
    );
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('still resolves the merge when the reconcile ping fails outright', async () => {
    const { merge, createWorkflowDispatch } = mockOctokit();
    createWorkflowDispatch.mockRejectedValue(
      Object.assign(new Error('Server Error'), { status: 500 }),
    );

    await expect(approveAndMergePr(DEFAULT_REPO, 42)).resolves.toBeUndefined();
    expect(merge).toHaveBeenCalled();
  });
});

describe('cancelWorkflowRun', () => {
  function mockOctokit({
    displayTitle = '#4242: Fix the flaky test',
    runStatuses = ['completed'],
  }: { displayTitle?: string; runStatuses?: string[] } = {}) {
    const cancelWorkflowRun_ = vi.fn().mockResolvedValue({});
    const getWorkflowRun = vi.fn().mockImplementation(async () => ({
      data: {
        display_title: displayTitle,
        status: runStatuses.shift() ?? 'completed',
      },
    }));
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        actions: {
          cancelWorkflowRun: cancelWorkflowRun_,
          getWorkflowRun,
          createWorkflowDispatch,
        },
      },
    });
    return { cancelWorkflowRun_, getWorkflowRun, createWorkflowDispatch };
  }

  it('cancels the given run on the console repo', async () => {
    const { cancelWorkflowRun_ } = mockOctokit();

    await cancelWorkflowRun(DEFAULT_REPO, 12345);

    expect(cancelWorkflowRun_).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      run_id: 12345,
    });
  });

  it("notifies the dispatch controller to reconcile the run's anchor issue", async () => {
    const { getWorkflowRun, createWorkflowDispatch } = mockOctokit({
      displayTitle: '#4242: Fix the flaky test',
    });

    await cancelWorkflowRun(DEFAULT_REPO, 12345);

    expect(getWorkflowRun).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      run_id: 12345,
    });
    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      workflow_id: 'agent-router.yml',
      ref: 'main',
      inputs: { kind: 'reconcile', issue: '4242' },
    });
  });

  it('waits for GitHub to finish cancellation before reconciling the run', async () => {
    vi.useFakeTimers();
    try {
      const { getWorkflowRun, createWorkflowDispatch } = mockOctokit({
        runStatuses: ['in_progress', 'completed'],
      });

      const cancellation = cancelWorkflowRun(DEFAULT_REPO, 12345);
      await vi.advanceTimersByTimeAsync(0);
      expect(getWorkflowRun).toHaveBeenCalledTimes(1);
      expect(createWorkflowDispatch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await cancellation;
      expect(getWorkflowRun).toHaveBeenCalledTimes(2);
      expect(createWorkflowDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: { kind: 'reconcile', issue: '4242' },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a slow cancellation to the scheduled sweep without reconciling early', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { getWorkflowRun, createWorkflowDispatch } = mockOctokit({
        runStatuses: Array.from({ length: 6 }, () => 'in_progress'),
      });

      const cancellation = cancelWorkflowRun(DEFAULT_REPO, 12345);
      await vi.runAllTimersAsync();
      await cancellation;

      expect(getWorkflowRun).toHaveBeenCalledTimes(6);
      expect(createWorkflowDispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('scheduled sweep will converge it'),
        12345,
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('parses the anchor from an opencode-prefixed display title the same way the dashboard does', async () => {
    const { createWorkflowDispatch } = mockOctokit({
      displayTitle: 'opencode #777: Investigate the outage',
    });

    await cancelWorkflowRun(DEFAULT_REPO, 12345);

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: { kind: 'reconcile', issue: '777' },
      }),
    );
  });

  it('skips the reconcile ping when the title carries no anchor number', async () => {
    const { createWorkflowDispatch } = mockOctokit({
      displayTitle: 'Manually dispatched run',
    });

    await expect(
      cancelWorkflowRun(DEFAULT_REPO, 12345),
    ).resolves.toBeUndefined();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('still resolves the cancel when looking up the anchor fails', async () => {
    const { cancelWorkflowRun_, createWorkflowDispatch } = mockOctokit();
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        actions: {
          cancelWorkflowRun: cancelWorkflowRun_,
          getWorkflowRun: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
          createWorkflowDispatch,
        },
      },
    });

    await expect(
      cancelWorkflowRun(DEFAULT_REPO, 12345),
    ).resolves.toBeUndefined();
    expect(cancelWorkflowRun_).toHaveBeenCalled();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('propagates a GitHub API error (e.g. the run already completed) and never looks up an anchor', async () => {
    const getWorkflowRun = vi.fn();
    const createWorkflowDispatch = vi.fn();
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        actions: {
          cancelWorkflowRun: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Conflict'), { status: 409 }),
            ),
          getWorkflowRun,
          createWorkflowDispatch,
        },
      },
    });

    await expect(cancelWorkflowRun(DEFAULT_REPO, 12345)).rejects.toThrow(
      'Conflict',
    );
    expect(getWorkflowRun).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });
});

describe('dispatchUnstickPrs', () => {
  it('dispatches playbook-unstick-prs.yml with a trimmed context input', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { actions: { createWorkflowDispatch } },
    });

    await dispatchUnstickPrs('  PR #123 stuck  ');

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      workflow_id: 'playbook-unstick-prs.yml',
      ref: 'main',
      inputs: { context: 'PR #123 stuck' },
    });
  });

  it('omits the context input when none is given', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { actions: { createWorkflowDispatch } },
    });

    await dispatchUnstickPrs();

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: {} }),
    );
  });
});

describe('retriggerIssue (pipeline routing)', () => {
  function mockOctokit(labels: string[]) {
    const get = vi.fn().mockResolvedValue({ data: { labels } });
    const removeLabel = vi.fn().mockResolvedValue({});
    const addLabels = vi.fn().mockResolvedValue({});
    const createComment = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: { get, removeLabel, addLabels, createComment },
        actions: { createWorkflowDispatch },
      },
    });
    return {
      get,
      removeLabel,
      addLabels,
      createComment,
      createWorkflowDispatch,
    };
  }

  it('defaults to cycling the claude label', async () => {
    const { removeLabel, addLabels, createWorkflowDispatch } = mockOctokit([
      'agent:claude',
    ]);

    await retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID);

    expect(removeLabel).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent:claude' }),
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 'agent-router.yml',
        inputs: {
          issue: '2709',
          pipeline: 'claude',
          mode: 'implement',
          caller_id: DISPATCH_ID,
        },
      }),
    );
  });

  it('cycles the opencode label for the opencode pipeline', async () => {
    const { removeLabel, addLabels, createWorkflowDispatch } = mockOctokit([
      'agent:opencode',
    ]);

    await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      undefined,
      'opencode',
    );

    expect(removeLabel).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent:opencode' }),
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: {
          issue: '2709',
          pipeline: 'opencode',
          mode: 'implement',
          caller_id: DISPATCH_ID,
        },
      }),
    );
  });

  it('400s when the issue lacks the target pipeline label', async () => {
    mockOctokit(['agent:claude']);

    await expect(
      retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID, undefined, 'opencode'),
    ).rejects.toThrow(
      'Issue does not carry the agent:opencode label; nothing to retrigger',
    );
  });

  it('posts the steering note and still cycles the label when the note carries no mention', async () => {
    const { createComment, removeLabel, addLabels, createWorkflowDispatch } =
      mockOctokit(['agent:opencode']);

    await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      'try a different approach',
      'opencode',
    );

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'try a different approach' }),
    );
    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'status:needs-human' }),
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).toHaveBeenCalled();
  });

  it('skips the label cycle when the note already carries the pipeline mention (would double-dispatch)', async () => {
    const { createComment, removeLabel, addLabels, createWorkflowDispatch } =
      mockOctokit(['agent:opencode']);

    await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      '/oc please retry this',
      'opencode',
    );

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: '/oc please retry this' }),
    );
    // clearHumanNeededLabel legitimately calls removeLabel for the
    // needs-human label before the note check - the agent label itself is
    // what must be skipped.
    expect(removeLabel).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent:opencode' }),
    );
    expect(addLabels).not.toHaveBeenCalled();
    // clearNeedsHumanLabel's own reconcile ping still fires (the park-state
    // label really was cleared just above), but the agent-triggering intent
    // dispatch must stay skipped, or the /oc mention in the note would run
    // the agent a second time - which is what this test guards against.
    expect(createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: { kind: 'reconcile', issue: '2709' },
      }),
    );
  });

  it('a claude-pipeline note carrying /oc does not trigger the claude early-return', async () => {
    const { removeLabel, addLabels, createWorkflowDispatch } = mockOctokit([
      'agent:claude',
    ]);

    await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      'please /oc retry this',
      'claude',
    );

    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'status:needs-human' }),
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).toHaveBeenCalled();
  });

  it("retries without caller_id when the target repo's router predates that input", async () => {
    const { createWorkflowDispatch } = mockOctokit(['agent:claude']);
    // Simulate a repo whose agent-router.yml specifically doesn't recognize
    // `caller_id` yet (rather than queuing one rejection by call order):
    // clearNeedsHumanLabel's own reconcile ping fires first and carries no
    // `caller_id`, so it must not be the call that trips this 422.
    createWorkflowDispatch.mockImplementation(
      async ({ inputs }: { inputs: Record<string, string> }) => {
        if ('caller_id' in inputs) {
          throw Object.assign(
            new Error('Unexpected inputs provided: ["caller_id"]'),
            { status: 422 },
          );
        }
        return {};
      },
    );

    await retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID);

    expect(createWorkflowDispatch).toHaveBeenCalledTimes(3);
    expect(createWorkflowDispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        inputs: { kind: 'reconcile', issue: '2709' },
      }),
    );
    expect(createWorkflowDispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        inputs: {
          issue: '2709',
          pipeline: 'claude',
          mode: 'implement',
          caller_id: DISPATCH_ID,
        },
      }),
    );
    expect(createWorkflowDispatch).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        inputs: { issue: '2709', pipeline: 'claude', mode: 'implement' },
      }),
    );
  });

  it('propagates a GitHub error unrelated to unexpected inputs', async () => {
    const { createWorkflowDispatch } = mockOctokit(['agent:claude']);
    createWorkflowDispatch.mockRejectedValue(
      Object.assign(new Error('Server Error'), { status: 500 }),
    );

    await expect(
      retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID),
    ).rejects.toThrow('Server Error');
    // clearNeedsHumanLabel's reconcile ping attempts and fails first (its
    // own failure is swallowed - see the closeIssue/clearHumanNeededLabel
    // notify tests), then the real intent dispatch attempts and fails,
    // which is what actually propagates out of retriggerIssue.
    expect(createWorkflowDispatch).toHaveBeenCalledTimes(2);
  });
});

describe('reassignPipeline', () => {
  function mockOctokit(labels: string[]) {
    const get = vi.fn().mockResolvedValue({ data: { labels } });
    const setLabels = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, setLabels } },
    });
    return { get, setLabels };
  }

  it('drops the current pipeline label and adds the target', async () => {
    const { setLabels } = mockOctokit(['agent:codex', 'type:bug']);

    await reassignPipeline(DEFAULT_REPO, 2709, 'claude');

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['type:bug', 'agent:claude'] }),
    );
  });

  it('drops every pipeline label present, not just one', async () => {
    const { setLabels } = mockOctokit([
      'agent:claude',
      'agent:opencode',
      'status:needs-human',
      'type:feature',
    ]);

    await reassignPipeline(DEFAULT_REPO, 2709, 'codex');

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['type:feature', 'agent:codex'] }),
    );
  });

  it('400s when the issue already carries the target pipeline label', async () => {
    mockOctokit(['agent:claude']);

    await expect(
      reassignPipeline(DEFAULT_REPO, 2709, 'claude'),
    ).rejects.toThrow('Issue is already assigned to claude');
  });

  it('400s when the issue carries no pipeline label at all', async () => {
    mockOctokit(['intake:quick-task']);

    await expect(
      reassignPipeline(DEFAULT_REPO, 2709, 'claude'),
    ).rejects.toThrow('Issue does not carry a pipeline label');
  });
});

describe('assignPipeline', () => {
  function mockOctokit(
    labels: string[],
    overrides: Record<string, unknown> = {},
  ) {
    const get = vi.fn().mockResolvedValue({
      data: { state: 'open', pull_request: undefined, labels, ...overrides },
    });
    const setLabels = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, setLabels } },
    });
    return { get, setLabels };
  }

  it('adds the target pipeline label to an unclaimed issue', async () => {
    const { setLabels } = mockOctokit(['type:bug']);

    await assignPipeline(DEFAULT_REPO, 2709, 'claude');

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['type:bug', 'agent:claude'] }),
    );
  });

  // The primary production path for this action: assigning straight from a
  // status:ready-for-agent Inbox item. Leaving that label in place would
  // have action-items.ts keep classifying the now-dispatched issue as
  // ready-for-agent even though it already carries an agent label (#859
  // review).
  it('clears status:ready-for-agent as part of the same label write', async () => {
    const { setLabels } = mockOctokit(['status:ready-for-agent', 'type:bug']);

    await assignPipeline(DEFAULT_REPO, 2709, 'codex');

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['type:bug', 'agent:codex'] }),
    );
  });

  it('400s when the issue already has an agent assignment', async () => {
    mockOctokit(['agent:claude']);

    await expect(assignPipeline(DEFAULT_REPO, 2709, 'codex')).rejects.toThrow(
      'Issue already has an agent assignment',
    );
  });

  it('400s for a closed issue', async () => {
    mockOctokit([], { state: 'closed' });

    await expect(assignPipeline(DEFAULT_REPO, 2709, 'claude')).rejects.toThrow(
      'Only open issues can be assigned to an agent',
    );
  });

  it('400s for a pull request', async () => {
    mockOctokit([], { pull_request: {} });

    await expect(assignPipeline(DEFAULT_REPO, 2709, 'claude')).rejects.toThrow(
      'Only open issues can be assigned to an agent',
    );
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
  const request = {
    requestId: '11111111-1111-4111-8111-111111111111',
    repository: DEFAULT_REPO,
    pipeline: 'claude' as const,
    description: '  Fix the flaky test\nmore context  ',
  };

  function mockOctokit(
    overrides: {
      createIssue?: Mock;
      listForRepo?: Mock;
      searchIssues?: Mock;
      getRef?: Mock;
      getTag?: Mock;
      createTag?: Mock;
      createRef?: Mock;
      deleteRef?: Mock;
    } = {},
  ) {
    const createIssue =
      overrides.createIssue ??
      vi.fn().mockResolvedValue({
        data: { number: 99, html_url: 'https://github.com/x/y/issues/99' },
      });
    const listForRepo =
      overrides.listForRepo ?? vi.fn().mockResolvedValue({ data: [] });
    const searchIssues =
      overrides.searchIssues ??
      vi.fn().mockResolvedValue({ data: { items: [] } });
    const tagObjects = new Map<string, { message: string }>();
    const claimRefs = new Map<string, string>();
    let tagSequence = 0;
    const getRef =
      overrides.getRef ??
      vi.fn().mockImplementation(async ({ ref }) => {
        if (ref === 'heads/main') {
          return {
            data: { object: { type: 'commit', sha: 'base-commit-sha' } },
          };
        }
        const sha = claimRefs.get(ref);
        if (!sha) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { object: { type: 'tag', sha } } };
      });
    const getTag =
      overrides.getTag ??
      vi.fn().mockImplementation(async ({ tag_sha }) => ({
        data: { message: tagObjects.get(tag_sha)?.message ?? '' },
      }));
    const createTag =
      overrides.createTag ??
      vi.fn().mockImplementation(async ({ message }) => {
        const sha = `claim-tag-${++tagSequence}`;
        tagObjects.set(sha, { message });
        return { data: { sha } };
      });
    const createRef =
      overrides.createRef ??
      vi.fn().mockImplementation(async ({ ref, sha }) => {
        const shortRef = ref.replace(/^refs\//u, '');
        if (claimRefs.has(shortRef)) {
          throw Object.assign(new Error('Reference already exists'), {
            status: 422,
          });
        }
        claimRefs.set(shortRef, sha);
        return { data: { ref, object: { type: 'tag', sha } } };
      });
    const deleteRef =
      overrides.deleteRef ??
      vi.fn().mockImplementation(async ({ ref }) => {
        claimRefs.delete(ref);
        return { data: {} };
      });
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: { create: createIssue, listForRepo },
        search: { issuesAndPullRequests: searchIssues },
        repos: {
          get: vi.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
        },
        git: { getRef, getTag, createTag, createRef, deleteRef },
      },
    });
    return {
      createIssue,
      listForRepo,
      searchIssues,
      getRef,
      getTag,
      createTag,
      createRef,
      deleteRef,
    };
  }

  it('rejects a blank description without calling GitHub', async () => {
    const { createIssue } = mockOctokit({});

    expect(() => createQuickTask({ ...request, description: '   ' })).toThrow(
      'Task description is required',
    );
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('rejects an invalid request ID without calling GitHub', async () => {
    const { createIssue, listForRepo } = mockOctokit();

    expect(() =>
      createQuickTask({ ...request, requestId: 'not-a-uuid' }),
    ).toThrow('A valid Quick Task request ID is required');
    expect(listForRepo).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('creates one immediately-dispatchable issue with a durable request marker', async () => {
    const { createIssue, createTag, createRef } = mockOctokit();

    const result = await createQuickTask(request);

    expect(createIssue).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      title: 'Fix the flaky test',
      body: expect.stringMatching(
        /^Fix the flaky test\nmore context\n\n<!-- agent-lcars:quick-task-request:v1 id=11111111-1111-4111-8111-111111111111 digest=[0-9a-f]{64} -->$/u,
      ),
      labels: ['intake:quick-task', 'agent:claude'],
    });
    expect(createTag).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'agent-lcars/quick-task/11111111-1111-4111-8111-111111111111',
        message: expect.stringMatching(
          /^agent-lcars:quick-task-claim:v1 \{"requestId":"11111111-1111-4111-8111-111111111111","digest":"[0-9a-f]{64}","claimantId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}$/u,
        ),
        object: 'base-commit-sha',
        type: 'commit',
      }),
    );
    expect(createRef).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      ref: 'refs/tags/agent-lcars/quick-task/11111111-1111-4111-8111-111111111111',
      sha: 'claim-tag-1',
    });
    expect(result).toEqual({
      requestId: request.requestId,
      task: { repository: DEFAULT_REPO, issueNumber: 99 },
      url: 'https://github.com/supersprinklesracing/sprinkles/issues/99',
    });
  });

  it('puts the selected pipeline label in the same creation write', async () => {
    const { createIssue } = mockOctokit();

    await createQuickTask({ ...request, pipeline: 'opencode' });

    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['intake:quick-task', 'agent:opencode'],
      }),
    );
  });

  it('returns the original issue when the same request is retried', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      return { data: { number: 99 } };
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [{ number: 99, body: persistedBody }],
      }));
    mockOctokit({ createIssue, listForRepo });

    const first = await createQuickTask(request);
    const retry = await createQuickTask(request);

    expect(retry).toEqual(first);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('ignores a pull request that copied the Quick Task marker', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      return { data: { number: 99 } };
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [
          { number: 123, body: persistedBody, pull_request: { url: 'pr' } },
          { number: 99, body: persistedBody },
        ],
      }));
    mockOctokit({ createIssue, listForRepo });

    const first = await createQuickTask(request);
    const retry = await createQuickTask(request);

    expect(first.task.issueNumber).toBe(99);
    expect(retry).toEqual(first);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('searches beyond the recent issue window for an older retry', async () => {
    const recent = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1000,
      body: 'unrelated',
    }));
    const createIssue = vi.fn();
    const searchIssues = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            number: 99,
            body: expect.anything(),
          },
        ],
      },
    });
    const { listForRepo } = mockOctokit({
      createIssue,
      listForRepo: vi.fn().mockResolvedValue({ data: recent }),
      searchIssues,
    });

    // Obtain the exact digest marker from a normal create request, then use
    // it as the old search result on the second request.
    let body = '';
    createIssue.mockImplementationOnce(async (input) => {
      body = input.body;
      return { data: { number: 99 } };
    });
    listForRepo.mockResolvedValueOnce({ data: [] });
    await createQuickTask(request);
    listForRepo.mockResolvedValue({ data: recent });
    searchIssues.mockResolvedValue({
      data: { items: [{ number: 99, body }] },
    });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(searchIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining(`repo:supersprinklesracing/sprinkles`),
      }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent double submissions', async () => {
    let resolveCreate!: (value: { data: { number: number } }) => void;
    const createIssue = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const { listForRepo } = mockOctokit({ createIssue });

    const first = createQuickTask(request);
    const second = createQuickTask(request);
    resolveCreate({ data: { number: 99 } });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    ]);
    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('reconciles the winner when another instance wins the claim-ref race', async () => {
    let claimMessage = '';
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'winner-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      const prefix = 'agent-lcars:quick-task-claim:v1 ';
      const claim = JSON.parse(input.message.slice(prefix.length));
      claimMessage = `${prefix}${JSON.stringify({
        ...claim,
        claimantId: '22222222-2222-4222-8222-222222222222',
      })}`;
      return { data: { sha: 'loser-tag-sha' } };
    });
    const createRef = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Reference already exists'), { status: 422 }),
      );
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const { createIssue } = mockOctokit({
      getRef,
      getTag,
      createTag,
      createRef,
    });

    await expect(createQuickTask(request)).rejects.toThrow(
      'Quick Task creation is already claimed but no issue is visible yet',
    );
    expect(createRef).toHaveBeenCalledTimes(1);
    expect(getTag).toHaveBeenCalledWith(
      expect.objectContaining({ tag_sha: 'winner-tag-sha' }),
    );
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('returns the issue a claim winner creates after the initial scan', async () => {
    let claimMessage = '';
    let digest = '';
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'winner-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      const prefix = 'agent-lcars:quick-task-claim:v1 ';
      const claim = JSON.parse(input.message.slice(prefix.length));
      digest = claim.digest;
      claimMessage = `${prefix}${JSON.stringify({
        ...claim,
        claimantId: '22222222-2222-4222-8222-222222222222',
      })}`;
      return { data: { sha: 'loser-tag-sha' } };
    });
    const createRef = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Reference already exists'), { status: 422 }),
      );
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [
          {
            number: 101,
            body: `Winner\n\n<!-- agent-lcars:quick-task-request:v1 id=${request.requestId} digest=${digest} -->`,
          },
        ],
      }));
    const { createIssue } = mockOctokit({
      getRef,
      getTag,
      createTag,
      createRef,
      listForRepo,
    });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 101 }),
      }),
    );
    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('retains ownership when GitHub loses the successful claim-ref response', async () => {
    let claimMessage = '';
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'our-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      claimMessage = input.message;
      return { data: { sha: 'our-tag-sha' } };
    });
    const createRef = vi
      .fn()
      .mockRejectedValue(new Error('claim response timed out'));
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const { createIssue } = mockOctokit({
      getRef,
      getTag,
      createTag,
      createRef,
    });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('retries reconciliation when a successful claim write is briefly invisible', async () => {
    let claimMessage = '';
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'our-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      claimMessage = input.message;
      return { data: { sha: 'our-tag-sha' } };
    });
    const createRef = vi
      .fn()
      .mockRejectedValue(new Error('claim response timed out'));
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const { createIssue } = mockOctokit({
      getRef,
      getTag,
      createTag,
      createRef,
    });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(getRef).toHaveBeenCalledTimes(5);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('recovers an issue created before a transport timeout', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      throw new Error('socket timed out');
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [{ number: 99, body: persistedBody }],
      }));
    mockOctokit({ createIssue, listForRepo });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledTimes(2);
  });

  it('reconciles an HTTP 408 instead of releasing the uniqueness claim', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      throw Object.assign(new Error('Request Timeout'), { status: 408 });
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [{ number: 99, body: persistedBody }],
      }));
    const { deleteRef } = mockOctokit({ createIssue, listForRepo });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous claim and blocks a second process from creating', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(new Error('socket timed out'));
    const { createRef } = mockOctokit({ createIssue });

    await expect(createQuickTask(request)).rejects.toThrow('socket timed out');
    await expect(createQuickTask(request)).rejects.toThrow(
      'Quick Task creation is already claimed but no issue is visible yet',
    );

    expect(createRef).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('rejects different content when an ambiguous claim is stranded', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(new Error('socket timed out'));
    mockOctokit({ createIssue });

    await expect(createQuickTask(request)).rejects.toThrow('socket timed out');
    await expect(
      createQuickTask({ ...request, description: 'Different task' }),
    ).rejects.toThrow(
      'Quick Task request ID was already used for different task content',
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a request ID for different content', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      return { data: { number: 99 } };
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [{ number: 99, body: persistedBody }],
      }));
    mockOctokit({ createIssue, listForRepo });

    await createQuickTask(request);
    await expect(
      createQuickTask({ ...request, description: 'Different task' }),
    ).rejects.toThrow(
      'Quick Task request ID was already used for different task content',
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('does not retry a definitive label validation failure', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const { listForRepo, deleteRef } = mockOctokit({ createIssue });

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(deleteRef).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      ref: 'tags/agent-lcars/quick-task/11111111-1111-4111-8111-111111111111',
    });
  });

  it('retries a transient claim-release failure before returning the create error', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      )
      .mockResolvedValueOnce({ data: { number: 99 } });
    const { deleteRef, createRef } = mockOctokit({ createIssue });
    deleteRef.mockRejectedValueOnce(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(deleteRef).toHaveBeenCalledTimes(2);
    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(createRef).toHaveBeenCalledTimes(2);
    expect(createIssue).toHaveBeenCalledTimes(2);
  });

  it('waits for a just-created claim to become visible before releasing it', async () => {
    let claimMessage = '';
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'our-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      claimMessage = input.message;
      return { data: { sha: 'our-tag-sha' } };
    });
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const { deleteRef } = mockOctokit({
      createIssue,
      getRef,
      getTag,
      createTag,
    });

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(getRef).toHaveBeenCalledTimes(5);
    expect(deleteRef).toHaveBeenCalledTimes(1);
  });

  it('reconciles a claim deletion whose successful response was lost', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const { deleteRef } = mockOctokit({ createIssue });
    const deleteImplementation = deleteRef.getMockImplementation();
    deleteRef.mockImplementationOnce(async (input) => {
      await deleteImplementation?.(input);
      throw new Error('delete response timed out');
    });

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(deleteRef).toHaveBeenCalledTimes(1);
  });

  it('never deletes a replacement owner after losing a delete response', async () => {
    let ourClaimMessage = '';
    let replacementClaimMessage = '';
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'our-tag-sha' } },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'replacement-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      const prefix = 'agent-lcars:quick-task-claim:v1 ';
      const claim = JSON.parse(input.message.slice(prefix.length));
      ourClaimMessage = input.message;
      replacementClaimMessage = `${prefix}${JSON.stringify({
        ...claim,
        claimantId: '22222222-2222-4222-8222-222222222222',
      })}`;
      return { data: { sha: 'our-tag-sha' } };
    });
    const getTag = vi.fn().mockImplementation(async ({ tag_sha }) => ({
      data: {
        message:
          tag_sha === 'our-tag-sha' ? ourClaimMessage : replacementClaimMessage,
      },
    }));
    const deleteRef = vi.fn().mockRejectedValue(new Error('response lost'));
    mockOctokit({ createIssue, getRef, getTag, createTag, deleteRef });

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(deleteRef).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when a definitive failure claim cannot be released', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const { deleteRef } = mockOctokit({ createIssue });
    deleteRef.mockRejectedValue(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );

    await expect(createQuickTask(request)).rejects.toThrow(
      'claim could not be released; manual reconciliation is required',
    );
    expect(deleteRef).toHaveBeenCalledTimes(3);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });
});
