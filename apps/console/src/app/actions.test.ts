import { revalidatePath, updateTag } from 'next/cache';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { auth } from '../auth';
import {
  ActionError,
  approveAndMergePr,
  approveAndRebasePr,
  cancelWorkflowRun,
  clearHumanNeededLabel,
  closeIssue as closeIssueLib,
  createQuickTask as createQuickTaskLib,
  dispatchUnstickPrs as dispatchUnstickPrsLib,
  postComment,
  retriggerIssue as retriggerIssueLib,
  updateIssueContent as updateIssueContentLib,
  updatePrBranch,
} from '../lib/backend-actions';
import { GITHUB_DATA_TAG } from '../lib/cache-tags';
import {
  approveAndRebase,
  cancelRun,
  clearHumanNeeded,
  closeIssue,
  createQuickTask,
  dispatchUnstickPrs,
  mergePr,
  rebasePr,
  replyToItem,
  retriggerIssue,
  updateIssueContent,
} from './actions';

const DISPATCH_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));

vi.mock('../lib/action-items', () => ({
  getActionItems: vi.fn(),
}));

// Mocked in full (rather than jest.requireActual) because the real module
// transitively pulls in @octokit/rest, which ships ESM Jest isn't
// configured to transform.
vi.mock('../lib/backend-actions', () => {
  class ActionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = 'ActionError';
    }
  }
  return {
    ActionError,
    approveAndMergePr: vi.fn(),
    approveAndRebasePr: vi.fn(),
    cancelWorkflowRun: vi.fn(),
    clearHumanNeededLabel: vi.fn(),
    closeIssue: vi.fn(),
    createQuickTask: vi.fn(),
    dispatchUnstickPrs: vi.fn(),
    postComment: vi.fn(),
    retriggerIssue: vi.fn(),
    updateIssueContent: vi.fn(),
    updatePrBranch: vi.fn(),
  };
});

// Mocked in full (rather than jest.requireActual) because the real barrel
// re-exports app-auth.ts, which transitively pulls in next-auth/next-server
// and needs a `Request` global this test environment doesn't provide. The
// factory below reimplements createAdminAction's actual guard logic.
vi.mock('@/lib/auth-guards', () => ({
  createAdminAction:
    (authFn: () => Promise<{ user?: { isAdmin?: boolean } } | null>) =>
    async () => {
      const session = await authFn();
      if (!session?.user?.isAdmin) {
        throw new Error('Unauthorized');
      }
      return session;
    },
}));

vi.mock('../auth', () => ({ auth: vi.fn() }));

const DEFAULT_REPO = {
  owner: 'supersprinklesracing',
  name: 'sprinkles',
  alias: 'sprinkles',
};
const QUICK_TASK_REQUEST = {
  requestId: '11111111-1111-4111-8111-111111111111',
  repository: DEFAULT_REPO,
  pipeline: 'claude' as const,
  description: 'Fix the flaky test',
};
const QUICK_TASK_RECEIPT = {
  requestId: QUICK_TASK_REQUEST.requestId,
  task: { repository: DEFAULT_REPO, issueNumber: 99 },
  url: 'https://github.com/supersprinklesracing/sprinkles/issues/99',
};

describe('agent-lcars Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (auth as Mock).mockResolvedValue({
      user: { id: 'admin-1', isAdmin: true },
    });
  });

  // Server Actions must not `throw` for expected/user-facing errors: Next.js
  // redacts thrown Error messages to a generic digest in production builds,
  // so GitHub's real message has to come back as a normal return value. #2628
  describe('when the underlying GitHub call fails', () => {
    it('mergePr returns { ok: false, message } instead of throwing', async () => {
      (approveAndMergePr as Mock).mockRejectedValue(
        new ActionError('Pull Request has merge conflicts', 405),
      );

      await expect(mergePr(DEFAULT_REPO, 42)).resolves.toEqual({
        ok: false,
        message: 'Pull Request has merge conflicts',
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('approveAndRebase returns { ok: false, message } instead of throwing', async () => {
      (approveAndRebasePr as Mock).mockRejectedValue(
        new ActionError('Update is not permitted', 403),
      );

      await expect(approveAndRebase(DEFAULT_REPO, 42)).resolves.toEqual({
        ok: false,
        message: 'Update is not permitted',
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('replyToItem returns { ok: false, message } instead of throwing', async () => {
      (postComment as Mock).mockRejectedValue(
        new ActionError('Comment body is required', 400),
      );

      await expect(replyToItem(DEFAULT_REPO, 42, '')).resolves.toEqual({
        ok: false,
        message: 'Comment body is required',
      });
    });

    it('retriggerIssue returns { ok: false, message } instead of throwing', async () => {
      (retriggerIssueLib as Mock).mockRejectedValue(
        new ActionError(
          'Issue does not carry the claude label; nothing to retrigger',
          400,
        ),
      );

      await expect(
        retriggerIssue(DEFAULT_REPO, 42, DISPATCH_ID),
      ).resolves.toEqual({
        ok: false,
        message: 'Issue does not carry the claude label; nothing to retrigger',
      });
    });

    it('cancelRun returns { ok: false, message } instead of throwing', async () => {
      (cancelWorkflowRun as Mock).mockRejectedValue(
        Object.assign(new Error('Conflict'), {
          status: 409,
          response: { data: { message: 'Run already completed' } },
        }),
      );

      await expect(cancelRun(DEFAULT_REPO, 123)).resolves.toEqual({
        ok: false,
        message: 'Run already completed',
      });
    });

    it('rebasePr returns { ok: false, message } instead of throwing', async () => {
      (updatePrBranch as Mock).mockRejectedValue(
        new ActionError('Merge conflict', 422),
      );

      await expect(rebasePr(DEFAULT_REPO, 42)).resolves.toEqual({
        ok: false,
        message: 'Merge conflict',
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('falls back to a generic message for a non-Error, non-GitHub rejection', async () => {
      (approveAndMergePr as Mock).mockRejectedValue('boom');

      await expect(mergePr(DEFAULT_REPO, 42)).resolves.toEqual({
        ok: false,
        message: 'Unexpected error',
      });
    });

    it('dispatchUnstickPrs returns { ok: false, message } instead of throwing', async () => {
      (dispatchUnstickPrsLib as Mock).mockRejectedValue(
        Object.assign(new Error('Forbidden'), {
          status: 403,
          response: { data: { message: 'Resource not accessible' } },
        }),
      );

      await expect(dispatchUnstickPrs()).resolves.toEqual({
        ok: false,
        message: 'Resource not accessible',
      });
    });

    it('createQuickTask returns { ok: false, message } instead of throwing', async () => {
      (createQuickTaskLib as Mock).mockRejectedValue(
        new ActionError('Task description is required', 400),
      );

      await expect(
        createQuickTask({ ...QUICK_TASK_REQUEST, description: '' }),
      ).resolves.toEqual({
        ok: false,
        message: 'Task description is required',
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('closeIssue returns { ok: false, message } instead of throwing', async () => {
      (closeIssueLib as Mock).mockRejectedValue(
        new ActionError('Issue not found', 404),
      );

      await expect(closeIssue(DEFAULT_REPO, 2709)).resolves.toEqual({
        ok: false,
        message: 'Issue not found',
      });
    });

    it('updateIssueContent returns { ok: false, message } instead of throwing', async () => {
      (updateIssueContentLib as Mock).mockRejectedValue(
        new ActionError('Validation Failed', 422),
      );

      await expect(
        updateIssueContent(DEFAULT_REPO, 2709, {
          title: 'Updated title',
          body: 'Updated body',
        }),
      ).resolves.toEqual({
        ok: false,
        message: 'Validation Failed',
      });
    });

    it('clearHumanNeeded returns { ok: false, message } instead of throwing', async () => {
      (clearHumanNeededLabel as Mock).mockRejectedValue(
        new ActionError('Unexpected error', 500),
      );

      await expect(clearHumanNeeded(DEFAULT_REPO, 2709)).resolves.toEqual({
        ok: false,
        message: 'Unexpected error',
      });
    });
  });

  describe('when the underlying call succeeds', () => {
    it('mergePr returns { ok: true } and revalidates', async () => {
      (approveAndMergePr as Mock).mockResolvedValue(undefined);

      await expect(mergePr(DEFAULT_REPO, 42)).resolves.toEqual({ ok: true });
      expect(revalidatePath).toHaveBeenCalledWith('/');
      expect(updateTag).toHaveBeenCalledWith(GITHUB_DATA_TAG);
    });

    it('rebasePr returns { ok: true } and revalidates', async () => {
      (updatePrBranch as Mock).mockResolvedValue(undefined);

      await expect(rebasePr(DEFAULT_REPO, 42)).resolves.toEqual({ ok: true });
      expect(updatePrBranch).toHaveBeenCalledWith(DEFAULT_REPO, 42);
      expect(revalidatePath).toHaveBeenCalledWith('/');
      expect(updateTag).toHaveBeenCalledWith(GITHUB_DATA_TAG);
    });

    it('approveAndRebase returns { ok: true } and revalidates', async () => {
      (approveAndRebasePr as Mock).mockResolvedValue(undefined);

      await expect(approveAndRebase(DEFAULT_REPO, 42)).resolves.toEqual({
        ok: true,
      });
      expect(revalidatePath).toHaveBeenCalledWith('/');
      expect(updateTag).toHaveBeenCalledWith(GITHUB_DATA_TAG);
    });

    it('replyToItem returns { ok: true } and revalidates', async () => {
      (postComment as Mock).mockResolvedValue({ url: 'https://x' });

      await expect(replyToItem(DEFAULT_REPO, 42, 'hi')).resolves.toEqual({
        ok: true,
      });
      expect(revalidatePath).toHaveBeenCalledWith('/');
      expect(updateTag).toHaveBeenCalledWith(GITHUB_DATA_TAG);
    });

    it('replyToItem forwards the item labels to postComment for mention routing', async () => {
      (postComment as Mock).mockResolvedValue({ url: 'https://x' });

      await replyToItem(DEFAULT_REPO, 42, 'hi', ['opencode']);

      expect(postComment).toHaveBeenCalledWith(DEFAULT_REPO, 42, 'hi', [
        'opencode',
      ]);
    });

    it('retriggerIssue forwards the pipeline to retriggerIssueLib', async () => {
      (retriggerIssueLib as Mock).mockResolvedValue(undefined);

      await expect(
        retriggerIssue(DEFAULT_REPO, 42, DISPATCH_ID, undefined, 'opencode'),
      ).resolves.toEqual({
        ok: true,
      });
      expect(retriggerIssueLib).toHaveBeenCalledWith(
        DEFAULT_REPO,
        42,
        DISPATCH_ID,
        undefined,
        'opencode',
      );
    });

    it('dispatchUnstickPrs returns { ok: true } and forwards the context', async () => {
      (dispatchUnstickPrsLib as Mock).mockResolvedValue(undefined);

      await expect(dispatchUnstickPrs('PR #123 stuck')).resolves.toEqual({
        ok: true,
      });
      expect(dispatchUnstickPrsLib).toHaveBeenCalledWith(
        'PR #123 stuck',
        undefined,
      );
    });

    it('createQuickTask returns the canonical receipt and revalidates', async () => {
      (createQuickTaskLib as Mock).mockResolvedValue(QUICK_TASK_RECEIPT);

      await expect(createQuickTask(QUICK_TASK_REQUEST)).resolves.toEqual({
        ok: true,
        ...QUICK_TASK_RECEIPT,
      });
      expect(createQuickTaskLib).toHaveBeenCalledWith(QUICK_TASK_REQUEST);
      expect(revalidatePath).toHaveBeenCalledWith('/');
      expect(updateTag).toHaveBeenCalledWith(GITHUB_DATA_TAG);
    });

    it('createQuickTask forwards an explicit pipeline', async () => {
      (createQuickTaskLib as Mock).mockResolvedValue(QUICK_TASK_RECEIPT);

      await createQuickTask({ ...QUICK_TASK_REQUEST, pipeline: 'opencode' });

      expect(createQuickTaskLib).toHaveBeenCalledWith({
        ...QUICK_TASK_REQUEST,
        pipeline: 'opencode',
      });
    });

    it('createQuickTask preserves the previewed evidence body across the Server Action boundary', async () => {
      (createQuickTaskLib as Mock).mockResolvedValue(QUICK_TASK_RECEIPT);
      const description = `Fix the session page refresh

## Problem details

### Observed
The loading state never clears.

### Done when
The refresh path has browser coverage.

## Source context

- Repository: \`supersprinklesracing/sprinkles\`
- Console route: \`/sessions/session-123\`
- Session: session-123`;

      await createQuickTask({ ...QUICK_TASK_REQUEST, description });

      expect(createQuickTaskLib).toHaveBeenCalledWith({
        ...QUICK_TASK_REQUEST,
        description,
      });
    });

    it('closeIssue returns { ok: true } and revalidates', async () => {
      (closeIssueLib as Mock).mockResolvedValue(undefined);

      await expect(closeIssue(DEFAULT_REPO, 2709)).resolves.toEqual({
        ok: true,
      });
      expect(closeIssueLib).toHaveBeenCalledWith(DEFAULT_REPO, 2709);
      expect(revalidatePath).toHaveBeenCalledWith('/');
      expect(updateTag).toHaveBeenCalledWith(GITHUB_DATA_TAG);
    });

    it('updateIssueContent returns { ok: true } and revalidates', async () => {
      (updateIssueContentLib as Mock).mockResolvedValue(undefined);
      const content = { title: 'Updated title', body: 'Updated body' };

      await expect(
        updateIssueContent(DEFAULT_REPO, 2709, content),
      ).resolves.toEqual({ ok: true });
      expect(updateIssueContentLib).toHaveBeenCalledWith(
        DEFAULT_REPO,
        2709,
        content,
      );
      expect(revalidatePath).toHaveBeenCalledWith('/');
      expect(updateTag).toHaveBeenCalledWith(GITHUB_DATA_TAG);
    });

    it('clearHumanNeeded returns { ok: true } and revalidates', async () => {
      (clearHumanNeededLabel as Mock).mockResolvedValue(undefined);

      await expect(clearHumanNeeded(DEFAULT_REPO, 2709)).resolves.toEqual({
        ok: true,
      });
      expect(clearHumanNeededLabel).toHaveBeenCalledWith(DEFAULT_REPO, 2709);
      expect(revalidatePath).toHaveBeenCalledWith('/');
      expect(updateTag).toHaveBeenCalledWith(GITHUB_DATA_TAG);
    });
  });

  describe('dispatchUnstickPrs repo scoping', () => {
    it('forwards a watched repo resolved against the config', async () => {
      (dispatchUnstickPrsLib as Mock).mockResolvedValue(undefined);

      await expect(
        dispatchUnstickPrs('stuck #42', {
          owner: DEFAULT_REPO.owner,
          name: DEFAULT_REPO.name,
        }),
      ).resolves.toEqual({ ok: true });
      expect(dispatchUnstickPrsLib).toHaveBeenCalledWith(
        'stuck #42',
        expect.objectContaining({
          owner: DEFAULT_REPO.owner,
          name: DEFAULT_REPO.name,
        }),
      );
    });
  });

  // Security-critical (see the resolveWatchedRepo doc comment in
  // github-client.ts): Server Action arguments are client-controlled at the
  // HTTP boundary regardless of their TS signature, so a client-supplied
  // repo outside the configured watched list must be rejected server-side
  // rather than trusted straight through to the GitHub client.
  describe('repo validation rejects an unwatched repo', () => {
    const UNWATCHED_REPO = { owner: 'someone-elses', name: 'private-repo' };

    it('mergePr rejects without calling approveAndMergePr', async () => {
      const result = await mergePr(UNWATCHED_REPO, 42);
      expect(result).toEqual({
        ok: false,
        message: 'someone-elses/private-repo is not a watched repo',
      });
      expect(approveAndMergePr).not.toHaveBeenCalled();
    });

    it('rebasePr rejects without calling updatePrBranch', async () => {
      const result = await rebasePr(UNWATCHED_REPO, 42);
      expect(result).toEqual({
        ok: false,
        message: 'someone-elses/private-repo is not a watched repo',
      });
      expect(updatePrBranch).not.toHaveBeenCalled();
    });

    it('approveAndRebase rejects without calling approveAndRebasePr', async () => {
      const result = await approveAndRebase(UNWATCHED_REPO, 42);
      expect(result).toEqual({
        ok: false,
        message: 'someone-elses/private-repo is not a watched repo',
      });
      expect(approveAndRebasePr).not.toHaveBeenCalled();
    });

    it('replyToItem rejects without calling postComment', async () => {
      const result = await replyToItem(UNWATCHED_REPO, 42, 'hi');
      expect(result.ok).toBe(false);
      expect(postComment).not.toHaveBeenCalled();
    });

    it('retriggerIssue rejects without calling retriggerIssueLib', async () => {
      const result = await retriggerIssue(UNWATCHED_REPO, 42, DISPATCH_ID);
      expect(result.ok).toBe(false);
      expect(retriggerIssueLib).not.toHaveBeenCalled();
    });

    it('dispatchUnstickPrs rejects without calling the lib', async () => {
      const result = await dispatchUnstickPrs('ctx', UNWATCHED_REPO);
      expect(result.ok).toBe(false);
      expect(dispatchUnstickPrsLib).not.toHaveBeenCalled();
    });

    it('cancelRun rejects without calling cancelWorkflowRun', async () => {
      const result = await cancelRun(UNWATCHED_REPO, 123);
      expect(result.ok).toBe(false);
      expect(cancelWorkflowRun).not.toHaveBeenCalled();
    });

    it('closeIssue rejects without calling closeIssueLib', async () => {
      const result = await closeIssue(UNWATCHED_REPO, 2709);
      expect(result.ok).toBe(false);
      expect(closeIssueLib).not.toHaveBeenCalled();
    });

    it('updateIssueContent rejects without calling the lib', async () => {
      const result = await updateIssueContent(UNWATCHED_REPO, 2709, {
        title: 'Updated title',
        body: 'Updated body',
      });
      expect(result.ok).toBe(false);
      expect(updateIssueContentLib).not.toHaveBeenCalled();
    });

    it('clearHumanNeeded rejects without calling clearHumanNeededLabel', async () => {
      const result = await clearHumanNeeded(UNWATCHED_REPO, 2709);
      expect(result.ok).toBe(false);
      expect(clearHumanNeededLabel).not.toHaveBeenCalled();
    });

    it('createQuickTask rejects an unwatched repo without calling createQuickTaskLib', async () => {
      const result = await createQuickTask({
        ...QUICK_TASK_REQUEST,
        repository: UNWATCHED_REPO,
      });
      expect(result.ok).toBe(false);
      expect(createQuickTaskLib).not.toHaveBeenCalled();
    });

    it('createQuickTask rejects a missing repo without falling back', async () => {
      const result = await createQuickTask({
        ...QUICK_TASK_REQUEST,
        repository: undefined,
      } as unknown as Parameters<typeof createQuickTask>[0]);
      expect(result).toEqual({
        ok: false,
        message: 'Quick Task repository is required',
      });
      expect(createQuickTaskLib).not.toHaveBeenCalled();
    });
  });

  describe('when the caller is not an admin', () => {
    beforeEach(() => {
      (auth as Mock).mockResolvedValue({
        user: { id: 'not-admin', isAdmin: false },
      });
    });

    it('rejects (does not silently return a result)', async () => {
      await expect(mergePr(DEFAULT_REPO, 42)).rejects.toThrow();
      expect(approveAndMergePr).not.toHaveBeenCalled();
    });

    it('rejects approveAndRebase too (does not silently return a result)', async () => {
      await expect(approveAndRebase(DEFAULT_REPO, 42)).rejects.toThrow();
      expect(approveAndRebasePr).not.toHaveBeenCalled();
    });
  });
});
