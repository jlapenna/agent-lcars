import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  cancelWorkflowRun,
  clearHumanNeededLabel,
  closeIssue,
  createQuickTask,
  deriveQuickTaskTitle,
  dispatchUnstickPrs,
  evictNxCache,
  postComment,
  retriggerIssue,
} from './backend-actions';
import { getGithubClient } from './github-client';

vi.mock('./github-client', () => ({
  getGithubClient: vi.fn(),
  REPO_OWNER: 'supersprinklesracing',
  REPO_NAME: 'members',
}));

describe('closeIssue', () => {
  it('closes the given issue on the console repo', async () => {
    const update = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
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
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          update: vi
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
    const removeLabel = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
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
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          removeLabel: vi
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

describe('postComment (mention routing)', () => {
  function mockOctokit() {
    const createComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/1#issuecomment-1' },
    });
    const removeLabel = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { createComment, removeLabel } },
    });
    return { createComment, removeLabel };
  }

  it('rejects a blank body without calling GitHub', async () => {
    const { createComment } = mockOctokit();

    await expect(postComment(2709, '   ')).rejects.toThrow(
      'Comment body is required',
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it('appends @claude by default when no labels are given', async () => {
    const { createComment } = mockOctokit();

    await postComment(2709, 'Use option 2');

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n@claude' }),
    );
  });

  it('appends @claude for an item carrying only the claude label', async () => {
    const { createComment } = mockOctokit();

    await postComment(2709, 'Use option 2', ['claude']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n@claude' }),
    );
  });

  it('appends /oc for an item carrying only the opencode label', async () => {
    const { createComment } = mockOctokit();

    await postComment(2709, 'Use option 2', ['opencode']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n/oc' }),
    );
  });

  it('appends @claude (not /oc) when both labels are present - never dispatch two pipelines from one reply', async () => {
    const { createComment } = mockOctokit();

    await postComment(2709, 'Use option 2', ['claude', 'opencode']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n@claude' }),
    );
  });

  it('does not double-append @claude when the body already contains it', async () => {
    const { createComment } = mockOctokit();

    await postComment(2709, 'Ping @claude please', ['claude']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Ping @claude please' }),
    );
  });

  it('does not double-append /oc when the body already contains /opencode', async () => {
    const { createComment } = mockOctokit();

    await postComment(2709, 'Please /opencode this', ['opencode']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Please /opencode this' }),
    );
  });

  it('clears the human-needed label after posting', async () => {
    const { removeLabel } = mockOctokit();

    await postComment(2709, 'hi', ['claude']);

    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'human-needed' }),
    );
  });
});

describe('cancelWorkflowRun', () => {
  it('cancels the given run on the console repo', async () => {
    const cancelWorkflowRun_ = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
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
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        actions: {
          cancelWorkflowRun: vi
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
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
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

describe('evictNxCache', () => {
  it('dispatches playbook-evict-nx-cache.yml with the capture flag stringified', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
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

describe('retriggerIssue (pipeline routing)', () => {
  function mockOctokit(labels: string[]) {
    const get = vi.fn().mockResolvedValue({ data: { labels } });
    const removeLabel = vi.fn().mockResolvedValue({});
    const addLabels = vi.fn().mockResolvedValue({});
    const createComment = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, removeLabel, addLabels, createComment } },
    });
    return { get, removeLabel, addLabels, createComment };
  }

  it('defaults to cycling the claude label', async () => {
    const { removeLabel, addLabels } = mockOctokit(['claude']);

    await retriggerIssue(2709);

    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'claude' }),
    );
    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['claude'] }),
    );
  });

  it('cycles the opencode label for the opencode pipeline', async () => {
    const { removeLabel, addLabels } = mockOctokit(['opencode']);

    await retriggerIssue(2709, undefined, 'opencode');

    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'opencode' }),
    );
    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['opencode'] }),
    );
  });

  it('400s when the issue lacks the target pipeline label', async () => {
    mockOctokit(['claude']);

    await expect(retriggerIssue(2709, undefined, 'opencode')).rejects.toThrow(
      'Issue does not carry the opencode label; nothing to retrigger',
    );
  });

  it('posts the steering note and still cycles the label when the note carries no mention', async () => {
    const { createComment, removeLabel, addLabels } = mockOctokit(['opencode']);

    await retriggerIssue(2709, 'try a different approach', 'opencode');

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'try a different approach' }),
    );
    expect(removeLabel).toHaveBeenCalled();
    expect(addLabels).toHaveBeenCalled();
  });

  it('skips the label cycle when the note already carries the pipeline mention (would double-dispatch)', async () => {
    const { createComment, removeLabel, addLabels } = mockOctokit(['opencode']);

    await retriggerIssue(2709, 'please /oc retry this', 'opencode');

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'please /oc retry this' }),
    );
    // clearHumanNeededLabel legitimately calls removeLabel for the
    // human-needed label before the note check - the label CYCLE (the
    // opencode label itself) is what must be skipped.
    expect(removeLabel).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'opencode' }),
    );
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('a claude-pipeline note carrying /oc does not trigger the claude early-return', async () => {
    const { removeLabel, addLabels } = mockOctokit(['claude']);

    await retriggerIssue(2709, 'please /oc retry this', 'claude');

    // /oc means nothing to claude.yml's trigger - the label still cycles.
    expect(removeLabel).toHaveBeenCalled();
    expect(addLabels).toHaveBeenCalled();
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
    createLabel?: Mock;
    createIssue?: Mock;
    addLabels?: Mock;
  }) {
    const createLabel = overrides.createLabel ?? vi.fn().mockResolvedValue({});
    const createIssue =
      overrides.createIssue ??
      vi.fn().mockResolvedValue({
        data: { number: 99, html_url: 'https://github.com/x/y/issues/99' },
      });
    const addLabels = overrides.addLabels ?? vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
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

  it('uses the explicit title instead of deriving one when provided', async () => {
    const { createIssue } = mockOctokit({});

    await createQuickTask(
      'Fix the flaky test\nmore context',
      '  Custom title  ',
    );

    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Custom title' }),
    );
  });

  it('falls back to the derived title when the explicit title is blank', async () => {
    const { createIssue } = mockOctokit({});

    await createQuickTask('Fix the flaky test\nmore context', '   ');

    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fix the flaky test' }),
    );
  });

  it('tolerates the quick-task label already existing (422)', async () => {
    const { createIssue } = mockOctokit({
      createLabel: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('exists'), { status: 422 })),
    });

    await createQuickTask('Some task');

    expect(createIssue).toHaveBeenCalled();
  });

  it('propagates a non-422 label creation failure', async () => {
    mockOctokit({
      createLabel: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Forbidden'), { status: 403 }),
        ),
    });

    await expect(createQuickTask('Some task')).rejects.toThrow('Forbidden');
  });
});
