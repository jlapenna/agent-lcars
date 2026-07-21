import { revalidatePath } from 'next/cache';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { auth } from '../auth';
import {
  ActionError,
  approveAndMergePr,
  cancelWorkflowRun,
  clearHumanNeededLabel,
  closeIssue as closeIssueLib,
  createQuickTask as createQuickTaskLib,
  dispatchUnstickPrs as dispatchUnstickPrsLib,
  evictNxCache as evictNxCacheLib,
  postComment,
  retriggerIssue as retriggerIssueLib,
} from '../lib/backend-actions';
import {
  cancelRun,
  clearHumanNeeded,
  closeIssue,
  createQuickTask,
  dispatchUnstickPrs,
  evictNxCache,
  mergePr,
  replyToItem,
  retriggerIssue,
} from './actions';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
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
    cancelWorkflowRun: vi.fn(),
    clearHumanNeededLabel: vi.fn(),
    closeIssue: vi.fn(),
    createQuickTask: vi.fn(),
    dispatchUnstickPrs: vi.fn(),
    evictNxCache: vi.fn(),
    postComment: vi.fn(),
    retriggerIssue: vi.fn(),
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

describe('agent-console Server Actions', () => {
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

      await expect(mergePr(42)).resolves.toEqual({
        ok: false,
        message: 'Pull Request has merge conflicts',
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('replyToItem returns { ok: false, message } instead of throwing', async () => {
      (postComment as Mock).mockRejectedValue(
        new ActionError('Comment body is required', 400),
      );

      await expect(replyToItem(42, '')).resolves.toEqual({
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

      await expect(retriggerIssue(42)).resolves.toEqual({
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

      await expect(cancelRun(123)).resolves.toEqual({
        ok: false,
        message: 'Run already completed',
      });
    });

    it('falls back to a generic message for a non-Error, non-GitHub rejection', async () => {
      (approveAndMergePr as Mock).mockRejectedValue('boom');

      await expect(mergePr(42)).resolves.toEqual({
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

    it('evictNxCache returns { ok: false, message } instead of throwing', async () => {
      (evictNxCacheLib as Mock).mockRejectedValue(
        Object.assign(new Error('Forbidden'), {
          status: 403,
          response: { data: { message: 'Resource not accessible' } },
        }),
      );

      await expect(evictNxCache(false)).resolves.toEqual({
        ok: false,
        message: 'Resource not accessible',
      });
    });

    it('createQuickTask returns { ok: false, message } instead of throwing', async () => {
      (createQuickTaskLib as Mock).mockRejectedValue(
        new ActionError('Task description is required', 400),
      );

      await expect(createQuickTask('')).resolves.toEqual({
        ok: false,
        message: 'Task description is required',
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('closeIssue returns { ok: false, message } instead of throwing', async () => {
      (closeIssueLib as Mock).mockRejectedValue(
        new ActionError('Issue not found', 404),
      );

      await expect(closeIssue(2709)).resolves.toEqual({
        ok: false,
        message: 'Issue not found',
      });
    });

    it('clearHumanNeeded returns { ok: false, message } instead of throwing', async () => {
      (clearHumanNeededLabel as Mock).mockRejectedValue(
        new ActionError('Unexpected error', 500),
      );

      await expect(clearHumanNeeded(2709)).resolves.toEqual({
        ok: false,
        message: 'Unexpected error',
      });
    });
  });

  describe('when the underlying call succeeds', () => {
    it('mergePr returns { ok: true } and revalidates', async () => {
      (approveAndMergePr as Mock).mockResolvedValue(undefined);

      await expect(mergePr(42)).resolves.toEqual({ ok: true });
      expect(revalidatePath).toHaveBeenCalledWith('/');
    });

    it('replyToItem returns { ok: true } and revalidates', async () => {
      (postComment as Mock).mockResolvedValue({ url: 'https://x' });

      await expect(replyToItem(42, 'hi')).resolves.toEqual({ ok: true });
      expect(revalidatePath).toHaveBeenCalledWith('/');
    });

    it('replyToItem forwards the item labels to postComment for mention routing', async () => {
      (postComment as Mock).mockResolvedValue({ url: 'https://x' });

      await replyToItem(42, 'hi', ['opencode']);

      expect(postComment).toHaveBeenCalledWith(42, 'hi', ['opencode']);
    });

    it('retriggerIssue forwards the pipeline to retriggerIssueLib', async () => {
      (retriggerIssueLib as Mock).mockResolvedValue(undefined);

      await expect(retriggerIssue(42, undefined, 'opencode')).resolves.toEqual({
        ok: true,
      });
      expect(retriggerIssueLib).toHaveBeenCalledWith(42, undefined, 'opencode');
    });

    it('dispatchUnstickPrs returns { ok: true } and forwards the context', async () => {
      (dispatchUnstickPrsLib as Mock).mockResolvedValue(undefined);

      await expect(dispatchUnstickPrs('PR #123 stuck')).resolves.toEqual({
        ok: true,
      });
      expect(dispatchUnstickPrsLib).toHaveBeenCalledWith('PR #123 stuck');
    });

    it('evictNxCache returns { ok: true } and forwards the capture flag', async () => {
      (evictNxCacheLib as Mock).mockResolvedValue(undefined);

      await expect(evictNxCache(true)).resolves.toEqual({ ok: true });
      expect(evictNxCacheLib).toHaveBeenCalledWith(true);
    });

    it('createQuickTask returns { ok: true, url, number } and revalidates', async () => {
      (createQuickTaskLib as Mock).mockResolvedValue({
        url: 'https://github.com/x/y/issues/99',
        number: 99,
      });

      await expect(
        createQuickTask('Fix the flaky test', 'Custom title'),
      ).resolves.toEqual({
        ok: true,
        url: 'https://github.com/x/y/issues/99',
        number: 99,
      });
      expect(createQuickTaskLib).toHaveBeenCalledWith(
        'Fix the flaky test',
        'Custom title',
      );
    });

    it('closeIssue returns { ok: true } and revalidates', async () => {
      (closeIssueLib as Mock).mockResolvedValue(undefined);

      await expect(closeIssue(2709)).resolves.toEqual({ ok: true });
      expect(closeIssueLib).toHaveBeenCalledWith(2709);
      expect(revalidatePath).toHaveBeenCalledWith('/');
    });

    it('clearHumanNeeded returns { ok: true } and revalidates', async () => {
      (clearHumanNeededLabel as Mock).mockResolvedValue(undefined);

      await expect(clearHumanNeeded(2709)).resolves.toEqual({ ok: true });
      expect(clearHumanNeededLabel).toHaveBeenCalledWith(2709);
      expect(revalidatePath).toHaveBeenCalledWith('/');
    });
  });

  describe('when the caller is not an admin', () => {
    beforeEach(() => {
      (auth as Mock).mockResolvedValue({
        user: { id: 'not-admin', isAdmin: false },
      });
    });

    it('rejects (does not silently return a result)', async () => {
      await expect(mergePr(42)).rejects.toThrow();
      expect(approveAndMergePr).not.toHaveBeenCalled();
    });
  });
});
