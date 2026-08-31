'use server';

import { revalidatePath, updateTag } from 'next/cache';

import { createAdminAction } from '@/lib/auth-guards';

import { auth } from '../auth';
import {
  type AuthoritativeTaskState,
  readAuthoritativeTaskState,
} from '../lib/authoritative-task-state';
import {
  ActionError,
  approveAndMergePr,
  approveAndRebasePr,
  assignPipeline as assignPipelineLib,
  clearHumanNeededLabel,
  closeIssue as closeIssueLib,
  createQuickTask as createQuickTaskLib,
  dispatchUnstickPrs as dispatchUnstickPrsLib,
  postComment,
  reassignPipeline as reassignPipelineLib,
  retriggerIssue as retriggerIssueLib,
  updateIssueContent as updateIssueContentLib,
  updatePrBranch,
} from '../lib/backend-actions';
import { AUTHORITATIVE_QUEUE_TAG } from '../lib/cache-tags';
import { resolveWatchedRepo, type WatchedRepo } from '../lib/github-client';
import type { Pipeline } from '../lib/primary-action';
import { quickTaskIssueCreatorFor } from '../lib/quick-task-author';
import type {
  QuickTaskReceipt,
  QuickTaskRequest,
} from '../lib/quick-task-contract';
import { repoKey } from '../lib/watched-repo';

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
// `note` is an optional, informational aside on success, distinct from
// `message`, which is reserved for the failure case.
export type ActionResult =
  { ok: true; note?: string } | { ok: false; message: string };

export type QuickTaskResult =
  ({ ok: true } & QuickTaskReceipt) | { ok: false; message: string };

/**
 * Everything a mutation has to invalidate. `revalidatePath` alone would
 * re-render the page against the still-cached authoritative projection (see
 * lib/dashboard-data.ts), so a queued webhook update could appear not to
 * have happened until the cache lifetime elapsed.
 *
 * `updateTag`, not `revalidateTag`: this runs inside a Server Action, and
 * read-your-own-writes is exactly the semantic a mutation needs - the
 * caller must see its own effect on the very next render.
 */
function revalidateDashboard() {
  updateTag(AUTHORITATIVE_QUEUE_TAG);
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
  callerId: string,
  note?: string,
): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    await retriggerIssueLib(
      resolveWatchedRepo(repo),
      number,
      callerId,
      note,
      session.user.login,
    );
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function dispatchUnstickPrs(
  context?: string,
  repo?: { owner: string; name: string },
): Promise<ActionResult> {
  await requireAdmin();
  try {
    // resolveWatchedRepo: never forward a client-supplied repo unvalidated
    // (see its doc comment) - unknown repos throw instead of dispatching.
    await dispatchUnstickPrsLib(
      context,
      repo ? resolveWatchedRepo(repo) : undefined,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function createQuickTask(
  request: QuickTaskRequest,
): Promise<QuickTaskResult> {
  const session = await requireAdmin();
  try {
    if (!request?.repository) {
      throw new ActionError('Quick Task repository is required', 400);
    }
    const receipt = await createQuickTaskLib(
      {
        ...request,
        repository: resolveWatchedRepo(request.repository),
      },
      undefined,
      quickTaskIssueCreatorFor(session),
    );
    revalidateDashboard();
    return { ok: true, ...receipt };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

/**
 * Post-creation read for the Quick Task button's success notification: the
 * orchestrator-authoritative lifecycle state for the issue Quick Task just
 * filed, so the badge can show what actually happened next rather than
 * treating issue creation alone as the whole outcome. A missing read (the
 * repo is outside the orchestrator's control-plane coverage, or the ingest
 * webhook simply hasn't landed yet) is not an error - `undefined` here
 * just means the caller shows no state badge yet.
 */
export async function readQuickTaskState(
  task: QuickTaskReceipt['task'],
): Promise<AuthoritativeTaskState | undefined> {
  await requireAdmin();
  const repository = resolveWatchedRepo(task.repository);
  return readAuthoritativeTaskState({
    repository: repoKey(repository),
    issue: task.issueNumber,
  });
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

export async function updateIssueContent(
  repo: WatchedRepo,
  number: number,
  content: { title: string; body: string },
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await updateIssueContentLib(resolveWatchedRepo(repo), number, content);
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
  callerId: string,
): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    await reassignPipelineLib(
      resolveWatchedRepo(repo),
      number,
      pipeline,
      callerId,
      session.user.login,
    );
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}

export async function assignPipeline(
  repo: WatchedRepo,
  number: number,
  pipeline: Pipeline,
): Promise<ActionResult> {
  await requireAdmin();
  try {
    await assignPipelineLib(resolveWatchedRepo(repo), number, pipeline);
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}
