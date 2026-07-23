'use server';

import { revalidatePath } from 'next/cache';

import { createAdminAction } from '@/lib/auth-guards';

import { auth } from '../auth';
import {
  type ActionItemsResult,
  getActionItems as fetchActionItems,
} from '../lib/action-items';
import {
  ActionError,
  approveAndMergePr,
  cancelWorkflowRun as cancelWorkflowRunLib,
  clearHumanNeededLabel,
  closeIssue as closeIssueLib,
  createQuickTask as createQuickTaskLib,
  dispatchUnstickPrs as dispatchUnstickPrsLib,
  evictNxCache as evictNxCacheLib,
  postComment,
  retriggerIssue as retriggerIssueLib,
} from '../lib/backend-actions';
import { resolveWatchedRepo, type WatchedRepo } from '../lib/github-client';
import type { Pipeline } from '../lib/primary-action';

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
function toUserErrorMessage(error: unknown): string {
  if (error instanceof ActionError) return error.message;
  if (isGithubRequestError(error)) {
    return error.response?.data?.message ?? 'GitHub API request failed';
  }
  return error instanceof Error ? error.message : 'Unexpected error';
}

// Next.js redacts the message of any Error *thrown* out of a Server Action
// in production builds (client only gets a generic digest) - independent of
// how well-formed the message is. So toUserErrorMessage()'s result has to
// come back as a normal return value, not a thrown Error, to survive to the
// client in prod. See #2628.
export type ActionResult = { ok: true } | { ok: false; message: string };

export type QuickTaskResult =
  { ok: true; url: string; number: number } | { ok: false; message: string };

export async function getActionItems(): Promise<ActionItemsResult> {
  await requireAdmin();
  return fetchActionItems();
}

export async function replyToItem(
  repo: WatchedRepo,
  number: number,
  body: string,
  labels: string[] = [],
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await postComment(resolveWatchedRepo(repo), number, body, labels);
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function mergePr(
  repo: WatchedRepo,
  number: number,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await approveAndMergePr(resolveWatchedRepo(repo), number);
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function retriggerIssue(
  repo: WatchedRepo,
  number: number,
  note?: string,
  pipeline?: Pipeline,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await retriggerIssueLib(resolveWatchedRepo(repo), number, note, pipeline);
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function cancelRun(
  repo: WatchedRepo,
  runId: number,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await cancelWorkflowRunLib(resolveWatchedRepo(repo), runId);
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function dispatchUnstickPrs(
  context?: string,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await dispatchUnstickPrsLib(context);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function evictNxCache(capture: boolean): Promise<ActionResult> {
  await requireAdmin();
  try {
    await evictNxCacheLib(capture);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function createQuickTask(
  description: string,
  title?: string,
): Promise<QuickTaskResult> {
  await requireAdmin();
  try {
    const { url, number } = await createQuickTaskLib(description, title);
    revalidatePath('/');
    return { ok: true, url, number };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function closeIssue(
  repo: WatchedRepo,
  number: number,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await closeIssueLib(resolveWatchedRepo(repo), number);
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function clearHumanNeeded(
  repo: WatchedRepo,
  number: number,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await clearHumanNeededLabel(resolveWatchedRepo(repo), number);
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}
