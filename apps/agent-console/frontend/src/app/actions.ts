'use server';

import { createAdminAction } from '@repo/auth/server';
import { revalidatePath } from 'next/cache';

import { auth } from '../auth';
import {
  type ActionItemsResult,
  getActionItems as fetchActionItems,
} from '../lib/action-items';
import {
  ActionError,
  approveAndMergePr,
  postComment,
  retriggerIssue as retriggerIssueLib,
} from '../lib/backend-actions';

// LAN preview goes through the shared test-session adapter inside auth()
// (IMPERSONATE_AUTOMATIC_LOGIN), so no bypass is needed here.
const requireAdmin = createAdminAction(auth);

// Duck-typed check for Octokit's RequestError (thrown for any non-2xx
// GitHub API response) - avoids a direct @octokit/request-error dependency
// just for an instanceof check.
function isGithubRequestError(
  error: unknown,
): error is { response?: { data?: { message?: string } } } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

// Surfaces GitHub's own error message (merge conflicts, already merged,
// closed, stale sha, etc.) instead of a generic "Internal error" - #2061's
// real first hit was "Pull Request has merge conflicts" reported to the
// user as just "Internal error", with the actual cause only visible in
// server logs.
function toUserError(error: unknown): Error {
  if (error instanceof ActionError) return new Error(error.message);
  if (isGithubRequestError(error)) {
    return new Error(
      error.response?.data?.message ?? 'GitHub API request failed',
    );
  }
  return error instanceof Error ? error : new Error('Unexpected error');
}

export async function getActionItems(): Promise<ActionItemsResult> {
  await requireAdmin();
  return fetchActionItems();
}

export async function replyToItem(number: number, body: string) {
  await requireAdmin();
  try {
    const result = await postComment(number, body);
    revalidatePath('/');
    return result;
  } catch (error) {
    throw toUserError(error);
  }
}

export async function mergePr(number: number) {
  await requireAdmin();
  try {
    await approveAndMergePr(number);
    revalidatePath('/');
  } catch (error) {
    throw toUserError(error);
  }
}

export async function retriggerIssue(number: number, note?: string) {
  await requireAdmin();
  try {
    await retriggerIssueLib(number, note);
    revalidatePath('/');
  } catch (error) {
    throw toUserError(error);
  }
}
