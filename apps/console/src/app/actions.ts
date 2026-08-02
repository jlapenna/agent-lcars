'use server';

import { revalidatePath, updateTag } from 'next/cache';

import { createAdminAction } from '@/lib/auth-guards';

import { auth } from '../auth';
import {
  type ActionItemsResult,
  getActionItems as fetchActionItems,
} from '../lib/action-items';
import {
  ActionError,
  approveAndMergePr,
  approveAndRebasePr,
  cancelWorkflowRun as cancelWorkflowRunLib,
  clearHumanNeededLabel,
  closeIssue as closeIssueLib,
  createQuickTask as createQuickTaskLib,
  dispatchUnstickPrs as dispatchUnstickPrsLib,
  postComment,
  reassignPipeline as reassignPipelineLib,
  retriggerIssue as retriggerIssueLib,
  updatePrBranch,
} from '../lib/backend-actions';
import { GITHUB_DATA_TAG } from '../lib/cache-tags';
import { resolveWatchedRepo, type WatchedRepo } from '../lib/github-client';
import type { Pipeline } from '../lib/primary-action';
import type {
  QuickTaskReceipt,
  QuickTaskRequest,
} from '../lib/quick-task-contract';

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
  ({ ok: true } & QuickTaskReceipt) | { ok: false; message: string };

export async function getActionItems(): Promise<ActionItemsResult> {
  await requireAdmin();
  return fetchActionItems();
}

/**
 * Everything a mutation has to invalidate. `revalidatePath` alone would
 * re-render the page against the still-cached GitHub read (see
 * lib/dashboard-data.ts), so a merge or a reply could appear not to have
 * happened until the cache lifetime elapsed.
 *
 * `updateTag`, not `revalidateTag`: this runs inside a Server Action, and
 * read-your-own-writes is exactly the semantic a mutation needs - the
 * caller must see its own effect on the very next render.
 */
function revalidateDashboard() {
  updateTag(GITHUB_DATA_TAG);
  revalidatePath('/');
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
    revalidateDashboard();
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
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function rebasePr(
  repo: WatchedRepo,
  number: number,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await updatePrBranch(resolveWatchedRepo(repo), number);
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function approveAndRebase(
  repo: WatchedRepo,
  number: number,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await approveAndRebasePr(resolveWatchedRepo(repo), number);
    revalidateDashboard();
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
    revalidateDashboard();
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
    revalidateDashboard();
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

export async function createQuickTask(
  request: QuickTaskRequest,
): Promise<QuickTaskResult> {
  await requireAdmin();
  try {
    if (!request?.repository) {
      throw new ActionError('Quick Task repository is required', 400);
    }
    const receipt = await createQuickTaskLib({
      ...request,
      repository: resolveWatchedRepo(request.repository),
    });
    revalidateDashboard();
    return { ok: true, ...receipt };
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
    revalidateDashboard();
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
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function reassignPipeline(
  repo: WatchedRepo,
  number: number,
  pipeline: Pipeline,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await reassignPipelineLib(resolveWatchedRepo(repo), number, pipeline);
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}
