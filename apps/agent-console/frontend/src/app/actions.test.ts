import { revalidatePath } from 'next/cache';

import { auth } from '../auth';
import {
  ActionError,
  approveAndMergePr,
  cancelWorkflowRun,
  dispatchUnstickPrs as dispatchUnstickPrsLib,
  evictNxCache as evictNxCacheLib,
  postComment,
  retriggerIssue as retriggerIssueLib,
} from '../lib/backend-actions';
import {
  cancelRun,
  dispatchUnstickPrs,
  evictNxCache,
  mergePr,
  replyToItem,
  retriggerIssue,
} from './actions';

jest.mock('next/cache', () => ({
  revalidatePath: jest.fn(),
}));

jest.mock('../lib/action-items', () => ({
  getActionItems: jest.fn(),
}));

// Mocked in full (rather than jest.requireActual) because the real module
// transitively pulls in @octokit/rest, which ships ESM Jest isn't
// configured to transform.
jest.mock('../lib/backend-actions', () => {
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
    approveAndMergePr: jest.fn(),
    cancelWorkflowRun: jest.fn(),
    dispatchUnstickPrs: jest.fn(),
    evictNxCache: jest.fn(),
    postComment: jest.fn(),
    retriggerIssue: jest.fn(),
  };
});

// Mocked in full (rather than jest.requireActual) because the real barrel
// re-exports app-auth.ts, which transitively pulls in next-auth/next-server
// and needs a `Request` global this test environment doesn't provide. The
// factory below reimplements createAdminAction's actual guard logic.
jest.mock('@repo/auth/server', () => ({
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

jest.mock('../auth', () => ({ auth: jest.fn() }));

describe('agent-console Server Actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as jest.Mock).mockResolvedValue({
      user: { id: 'admin-1', isAdmin: true },
    });
  });

  // Server Actions must not `throw` for expected/user-facing errors: Next.js
  // redacts thrown Error messages to a generic digest in production builds,
  // so GitHub's real message has to come back as a normal return value. #2628
  describe('when the underlying GitHub call fails', () => {
    it('mergePr returns { ok: false, message } instead of throwing', async () => {
      (approveAndMergePr as jest.Mock).mockRejectedValue(
        new ActionError('Pull Request has merge conflicts', 405),
      );

      await expect(mergePr(42)).resolves.toEqual({
        ok: false,
        message: 'Pull Request has merge conflicts',
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('replyToItem returns { ok: false, message } instead of throwing', async () => {
      (postComment as jest.Mock).mockRejectedValue(
        new ActionError('Comment body is required', 400),
      );

      await expect(replyToItem(42, '')).resolves.toEqual({
        ok: false,
        message: 'Comment body is required',
      });
    });

    it('retriggerIssue returns { ok: false, message } instead of throwing', async () => {
      (retriggerIssueLib as jest.Mock).mockRejectedValue(
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
      (cancelWorkflowRun as jest.Mock).mockRejectedValue(
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
      (approveAndMergePr as jest.Mock).mockRejectedValue('boom');

      await expect(mergePr(42)).resolves.toEqual({
        ok: false,
        message: 'Unexpected error',
      });
    });

    it('dispatchUnstickPrs returns { ok: false, message } instead of throwing', async () => {
      (dispatchUnstickPrsLib as jest.Mock).mockRejectedValue(
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
      (evictNxCacheLib as jest.Mock).mockRejectedValue(
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
  });

  describe('when the underlying call succeeds', () => {
    it('mergePr returns { ok: true } and revalidates', async () => {
      (approveAndMergePr as jest.Mock).mockResolvedValue(undefined);

      await expect(mergePr(42)).resolves.toEqual({ ok: true });
      expect(revalidatePath).toHaveBeenCalledWith('/');
    });

    it('replyToItem returns { ok: true } and revalidates', async () => {
      (postComment as jest.Mock).mockResolvedValue({ url: 'https://x' });

      await expect(replyToItem(42, 'hi')).resolves.toEqual({ ok: true });
      expect(revalidatePath).toHaveBeenCalledWith('/');
    });

    it('dispatchUnstickPrs returns { ok: true } and forwards the context', async () => {
      (dispatchUnstickPrsLib as jest.Mock).mockResolvedValue(undefined);

      await expect(dispatchUnstickPrs('PR #123 stuck')).resolves.toEqual({
        ok: true,
      });
      expect(dispatchUnstickPrsLib).toHaveBeenCalledWith('PR #123 stuck');
    });

    it('evictNxCache returns { ok: true } and forwards the capture flag', async () => {
      (evictNxCacheLib as jest.Mock).mockResolvedValue(undefined);

      await expect(evictNxCache(true)).resolves.toEqual({ ok: true });
      expect(evictNxCacheLib).toHaveBeenCalledWith(true);
    });
  });

  describe('when the caller is not an admin', () => {
    beforeEach(() => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: 'not-admin', isAdmin: false },
      });
    });

    it('rejects (does not silently return a result)', async () => {
      await expect(mergePr(42)).rejects.toThrow();
      expect(approveAndMergePr).not.toHaveBeenCalled();
    });
  });
});
