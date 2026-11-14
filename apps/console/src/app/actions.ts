'use server';

import { revalidatePath, updateTag } from 'next/cache';
import type { Session } from 'next-auth';

import { createAdminAction } from '@/lib/auth-guards';

import {
  auth,
  githubAccessTokenFor,
  githubAccessTokenIssuedAtFor,
  signIn,
  withFreshGithubAccessToken,
} from '../auth';
import {
  ActionError,
  approveAndMergePr,
  approveAndRebasePr,
  assignPipeline as assignPipelineLib,
  clearNeedsHumanLabel,
  closeIssue as closeIssueLib,
  type CommentActor,
  dispatchUnstickPrs as dispatchUnstickPrsLib,
  GithubReauthRequiredError,
  postComment,
  retriggerIssue as retriggerIssueLib,
  retryPostedComment,
  updateIssueContent as updateIssueContentLib,
  updatePrBranch,
} from '../lib/backend-actions';
import { AUTHORITATIVE_QUEUE_TAG } from '../lib/cache-tags';
import { resolveWatchedRepo, type WatchedRepo } from '../lib/github-client';
import { safeReturnPath } from '../lib/github-reauth';
import type { Pipeline } from '../lib/primary-action';

// LAN preview goes through the shared test-session adapter inside auth()
// (E2E_TESTING + the x-e2e-auth-user request header), so no bypass is
// needed here.
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
export type ActionResult = { ok: true; note?: string } | ActionFailure;

/**
 * `reauth` marks the one failure the browser can repair by itself: GitHub
 * refused the operator's user token, and a fresh GitHub authorization
 * (`refreshGithubSignIn`) replaces it without a manual sign-out.
 */
export interface ActionFailure {
  ok: false;
  message: string;
  reauth?: true;
}

function toFailure(error: unknown): ActionFailure {
  return {
    ok: false,
    message: toUserErrorMessage(error),
    ...(error instanceof GithubReauthRequiredError
      ? { reauth: true as const }
      : {}),
  };
}

/** The signed-in operator a GitHub write is attributed to, with a token
 * renewed first if GitHub's expiry has passed. An empty token is rejected by
 * the write itself with a re-authorization prompt. */
async function operatorFor(signedIn: Session): Promise<CommentActor> {
  const login = signedIn.user.login;
  if (!login) {
    throw new ActionError('Authenticated GitHub login is required', 401);
  }
  const session = await withFreshGithubAccessToken(signedIn);
  const issuedAt = githubAccessTokenIssuedAtFor(session);
  return {
    login,
    githubToken: githubAccessTokenFor(session) ?? '',
    ...(issuedAt === undefined ? {} : { githubTokenIssuedAt: issuedAt }),
  };
}

/**
 * Replaces the session's GitHub user token by sending the browser through
 * GitHub's authorization again. The console is already authorized, so GitHub
 * returns at once and the operator lands back on `returnTo` with a working
 * token: no sign-out, and nothing to click.
 */
export async function refreshGithubSignIn(returnTo: string): Promise<void> {
  await signIn('github', { redirectTo: safeReturnPath(returnTo) });
}

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

/**
 * A reply's outcome. `dispatched` distinguishes the two very different
 * things "Reply posted" used to cover: a real handoff to an agent, and a
 * comment on an item nobody owns (#1869).
 */
export type ReplyResult =
  | {
      ok: true;
      dispatched: boolean;
      note: string;
      warning?: true;
      retry?: { commentId: number; pipeline: Pipeline; handoff?: true };
    }
  | ActionFailure;

export async function replyToItem(
  repo: WatchedRepo,
  number: number,
  body: string,
  assignedPipeline?: Pipeline,
  /** The operator chose `assignedPipeline` in the reply's hand-off control. */
  handoff = false,
): Promise<ReplyResult> {
  const session = await requireAdmin();
  try {
    const { dispatched, dispatchWarning, retryCommentId } = await postComment(
      resolveWatchedRepo(repo),
      number,
      body,
      await operatorFor(session),
      assignedPipeline,
      handoff,
    );
    revalidateDashboard();
    // A reply that dispatched nobody is a success, but not the one the
    // maintainer meant when the queue told them to reply - say which of the
    // two happened rather than reporting a uniform "Reply posted" (#1869).
    return {
      ok: true,
      dispatched,
      ...(dispatchWarning === undefined ? {} : { warning: true as const }),
      ...(retryCommentId !== undefined && assignedPipeline !== undefined
        ? {
            retry: {
              commentId: retryCommentId,
              pipeline: assignedPipeline,
              ...(handoff ? { handoff: true as const } : {}),
            },
          }
        : {}),
      note:
        dispatchWarning === 'assignment-update-failed' && dispatched
          ? 'Reply posted and agent dispatched, but updating the GitHub assignment failed.'
          : dispatchWarning === 'projection-refresh-failed'
            ? 'Reply posted and agent dispatched, but the queue may take a moment to refresh.'
            : dispatchWarning === 'dispatch-failed'
              ? 'Reply posted, but dispatch failed. Use Retry dispatch to send the posted reply without posting it again.'
              : dispatchWarning === 'provider-handoff-requested'
                ? `Reply posted and the ${assignedPipeline ?? 'agent'} label applied as you; LCARS hands this item over once that label is admitted.`
                : dispatchWarning === 'provider-handoff-failed'
                  ? `Reply posted, but applying the ${assignedPipeline ?? 'agent'} label as you failed. Add the label on GitHub, or sign in again if your session expired.`
                  : dispatchWarning === 'admitted-pipeline-mismatch'
                    ? 'Reply posted as a comment only: this item already ran with a different agent.'
                    : dispatched
                      ? `Dispatched ${assignedPipeline ?? 'agent'}`
                      : 'No agent assigned - posted as a comment only',
    };
  } catch (error) {
    return toFailure(error);
  }
}

export async function retryReplyToItem(
  repo: WatchedRepo,
  number: number,
  commentId: number,
  pipeline: Pipeline,
  handoff = false,
): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    if (!session.user.login)
      throw new ActionError('Authenticated GitHub login is required', 401);
    const result = await retryPostedComment(
      resolveWatchedRepo(repo),
      number,
      commentId,
      session.user.login,
      pipeline,
      handoff,
    );
    revalidateDashboard();
    if (!result.dispatched) {
      return {
        ok: false,
        message:
          result.dispatchWarning === 'dispatch-failed'
            ? 'Dispatch failed. You can retry without reposting your reply.'
            : result.dispatchWarning === 'admitted-pipeline-mismatch'
              ? 'This item already ran with a different agent; only that agent can take this reply.'
              : 'The current assignment no longer permits this reply dispatch. Refresh the item to check its assignment.',
      };
    }
    return {
      ok: true,
      note:
        result.dispatchWarning === 'assignment-update-failed'
          ? 'Agent dispatched, but updating the GitHub assignment failed.'
          : result.dispatchWarning
            ? 'Agent dispatched, but the queue may take a moment to refresh.'
            : `Dispatched ${pipeline}`,
    };
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
      await operatorFor(session),
      note,
    );
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

export async function dispatchUnstickPrs(
  context: string | undefined,
  repo: { owner: string; name: string },
): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    // resolveWatchedRepo: never forward a client-supplied repo unvalidated
    // (see its doc comment) - unknown repos throw instead of dispatching.
    await dispatchUnstickPrsLib(
      context,
      resolveWatchedRepo(repo),
      await operatorFor(session),
    );
    return { ok: true };
  } catch (error) {
    return toFailure(error);
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
    await clearNeedsHumanLabel(resolveWatchedRepo(repo), number);
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
  const session = await requireAdmin();
  try {
    if (!session.user.login) {
      throw new ActionError('Authenticated GitHub login is required', 401);
    }
    const result = await assignPipelineLib(
      resolveWatchedRepo(repo),
      number,
      pipeline,
      session.user.login,
    );
    revalidateDashboard();
    return {
      ok: true,
      ...(result.warning === undefined
        ? {}
        : {
            note:
              result.warning === 'assignment-update-failed'
                ? 'Agent dispatched, but updating the GitHub assignment failed.'
                : 'Agent dispatched, but the queue may take a moment to refresh.',
          }),
    };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}
