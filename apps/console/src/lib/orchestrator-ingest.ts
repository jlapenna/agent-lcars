import {
  AGENT_LABELS,
  parseTerminalQuickTaskBody,
  REPLY_COMMANDS,
  REVIEW_LABELS,
} from '@agent-lcars/dispatch-contracts';
import {
  type RequestBinding,
  type TaskId,
  taskIdSchema,
} from '@agent-lcars/orchestrator';
import { type WorkPayload } from '@agent-lcars/work';
import { z } from 'zod';

import { isControlPlaneRepository } from '@/lib/deployment';
import { matchReplyTrigger } from '@/lib/reply-trigger';
import { hasCrossRepoOption, repoKey } from '@/lib/watched-repo';
import { getWatchedRepos } from '@/lib/watched-repos-config';

import { isConsoleReply } from './console-reply-marker';
import {
  checkGithubLabelRouting,
  type GithubLabelRouting,
  type RoutingLabelConflict,
} from './github-routing-labels';
import {
  detectPullRequestAuthorPipeline,
  isAutomatedReviewExcludedAuthor,
  parseAttemptClaimRunId,
  selectCrossModelReviewer,
  UNIFIED_REVIEW_COMMAND,
  UNIFIED_REVIEW_LABEL,
} from './pr-review-routing';
import { workPayloadFromGithub } from './work-from-github';

/**
 * Interprets one GitHub webhook delivery and decides whether it is a
 * request to work a task. Pure: no I/O, no throwing on malformed input --
 * parse failures and non-matching payloads become an `IngestIgnore`,
 * while ambiguous label intent returns an actionable conflict. Callers own dispatch; this
 * module only decides *whether* and *what*.
 */

export type Pipeline = 'claude' | 'codex' | 'opencode' | 'agy';

export interface IngestReviewContext {
  requestedPipeline?: Pipeline;
  authorPipeline?: Pipeline;
  claimRunId?: string;
  actor: string;
  title: string;
  body?: string | null;
}

export interface IngestDecision {
  kind: 'request';
  taskId: TaskId;
  /** The `x-github-delivery` GUID; doubles as the orchestrator's
   *  idempotency key for this request. */
  requestId: string;
  /** Optional opaque durable binding for a first delivery that must converge
   * with another admission path. The store, not this pure interpreter,
   * atomically decides whether this source delivery owns that binding. */
  requestBinding?: RequestBinding;
  pipeline: Pipeline;
  /** Always includes `mode`; includes `reply` when `mode` is `'reply'`. */
  params: Record<string, string>;
  /** Every admitted GitHub anchor supplies the Work specification its
   * direct runner will execute. */
  work: WorkPayload;
  labelRouting?: GithubLabelRouting;
  fallbackPipelines?: readonly Pipeline[];
  reviewContext?: IngestReviewContext;
}

export interface IngestIgnore {
  kind: 'ignore';
  /** Short machine-readable reason, e.g. 'wrong-repo', 'no-trigger-label'. */
  reason: string;
}

export type IngestResult = IngestDecision | IngestIgnore | RoutingLabelConflict;

export interface GithubAnchorClosure {
  taskId: TaskId;
  /** GitHub's source timestamp for this exact close transition. */
  closedAt: string;
}

function ignore(reason: string): IngestIgnore {
  return { kind: 'ignore', reason };
}

const repositorySchema = z.object({ full_name: z.string().min(1) });
const labelSchema = z.object({ name: z.string().min(1) });
/** GitHub sends the actor who triggered this specific delivery (whoever
 * applied the label or posted the comment). A delivery without it is
 * malformed: Work origin is never inferred from a label or an unknown
 * placeholder. */
const senderSchema = z.object({ login: z.string().min(1) });
/** GitHub always sends `title`; `body` may be `null`. A title is required
 * because the Work specification is required at admission. */
const issueBodySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  // GitHub always sends the anchor's full current label set on every
  // `issues`/`pull_request`/`issue_comment` delivery, not just the one
  // label that triggered this specific event (`label.name` below covers
  // that). Optional/defaulted so a malformed or older-shaped payload still
  // parses -- absent labels reads as "no agent-option present", never a
  // parse failure. See `hasCrossRepoOption` (watched-repo.ts).
  labels: z.array(labelSchema).optional().default([]),
  pull_request: z.record(z.string(), z.unknown()).optional(),
  user: z
    .object({
      login: z.string().min(1),
      type: z.string().optional(),
    })
    .optional(),
});

// Label routing requires lifecycle evidence. Tagged-comment follow-ups have
// their own resume policy and deliberately keep the comment schema below.
const labelAnchorSchema = issueBodySchema.extend({
  updated_at: z.iso.datetime({ offset: false }).optional(),
  state: z.enum(['open', 'closed']),
  // Missing full-set evidence must not become a fabricated empty snapshot.
  labels: z.array(labelSchema).optional(),
});

const pullRequestAnchorSchema = labelAnchorSchema.extend({
  draft: z.boolean().optional(),
  head: z
    .object({
      ref: z.string().min(1).optional(),
      sha: z.string().min(1).optional(),
    })
    .optional(),
});

const issuesEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  issue: labelAnchorSchema,
  label: labelSchema.optional(),
  sender: senderSchema,
});

const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  pull_request: pullRequestAnchorSchema,
  label: labelSchema.optional(),
  sender: senderSchema,
});

const closedAnchorEventSchema = z.object({
  action: z.literal('closed'),
  repository: repositorySchema,
  issue: z
    .object({
      number: z.number().int().positive(),
      closed_at: z.iso.datetime({ offset: false }),
    })
    .optional(),
  pull_request: z
    .object({
      number: z.number().int().positive(),
      closed_at: z.iso.datetime({ offset: false }),
    })
    .optional(),
});

/** Exported for `tagged-reply-resume.ts`'s stateful second pass over a
 *  `mode: 'reply'` decision this pure interpreter already accepted --
 *  deciding "is this anchor parked or done, ready to resume" needs the
 *  store, which this module deliberately never touches, so that check
 *  happens in the route instead. */
export const issueCommentEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  issue: issueBodySchema,
  comment: z.object({
    body: z.string(),
    author_association: z.string(),
    user: z.object({ type: z.string() }).optional(),
    /** GitHub always sends this; optional here so a malformed or
     *  future-shaped payload still parses for the existing explicit-trigger
     *  path, which never reads it. `tagged-reply-resume.ts` uses it to
     *  derive an idempotent request id -- absent, it falls back to a less
     *  precise one. */
    html_url: z.string().min(1).optional(),
  }),
  sender: senderSchema,
});

function matchReplyCommand(body: string): Pipeline | undefined {
  const trigger = matchReplyTrigger(body, [...REPLY_COMMANDS.keys()]);
  return trigger ? REPLY_COMMANDS.get(trigger) : undefined;
}

/** `params.crossRepo` is present, and `'true'`, iff the anchor's labels
 *  (as delivered on this exact webhook event) carry
 *  `agent-option:cross-repo` -- never inferred later, and never from a
 *  followup delivery. `runs-router.ts`'s `checkoutToken` reads this exact
 *  string value back off `Run.params`. */
function crossRepoParams(
  labels: readonly { name: string }[],
): Record<string, string> {
  return hasCrossRepoOption(labels.map((label) => label.name))
    ? { crossRepo: 'true' }
    : {};
}

function checkRepository(fullName: string): IngestIgnore | undefined {
  if (!isControlPlaneRepository(fullName)) return ignore('wrong-repo');
  const watched = getWatchedRepos().find((repo) => repoKey(repo) === fullName);
  return watched?.agents === false ? ignore('agents-disabled') : undefined;
}

/** Builds the decision, re-validating the assembled task identifier against
 *  the orchestrator's own schema rather than trusting the webhook shape. */
function buildRequestDecision(
  repo: string,
  issue: number,
  requestId: string,
  pipeline: Pipeline,
  params: Record<string, string>,
  work: WorkPayload,
  requestBinding?: RequestBinding,
  labelRouting?: GithubLabelRouting,
  fallbackPipelines?: readonly Pipeline[],
  reviewContext?: IngestReviewContext,
): IngestResult {
  const taskId = taskIdSchema.safeParse({ repo, issue });
  if (!taskId.success) return ignore('malformed-payload');
  return {
    kind: 'request',
    taskId: taskId.data,
    requestId,
    ...(requestBinding === undefined ? {} : { requestBinding }),
    pipeline,
    params,
    work,
    ...(labelRouting === undefined ? {} : { labelRouting }),
    ...(fallbackPipelines === undefined ? {} : { fallbackPipelines }),
    ...(reviewContext === undefined ? {} : { reviewContext }),
  };
}

/** A Quick Task marker names the browser intent that created its issue. The
 * shared admission transaction binds the first webhook source that presents
 * this opaque key, rather than relying on a non-atomic route pre-read. */
function terminalQuickTaskBinding(
  body: string | null | undefined,
): RequestBinding | undefined {
  const quickTask = parseTerminalQuickTaskBody(body);
  if (!quickTask) return undefined;
  const canonicalRequestId = `console-quick-task:${quickTask.requestId}`;
  return { bindingKey: canonicalRequestId, canonicalRequestId };
}

function buildReviewRequestDecision(input: {
  repo: string;
  issue: number;
  deliveryId: string;
  title: string;
  body: string | null | undefined;
  actor: string;
  labels: readonly { name: string }[];
  userLogin?: string;
  headRef?: string;
  requestedPipeline?: Pipeline;
  labelRouting?: GithubLabelRouting;
}): IngestResult {
  const authorPipeline = detectPullRequestAuthorPipeline({
    labels: input.labels,
    userLogin: input.userLogin,
    body: input.body,
    headRef: input.headRef,
  });
  const selection = selectCrossModelReviewer({
    repo: input.repo,
    authorPipeline,
    requestedPipeline: input.requestedPipeline,
  });
  const labelRouting =
    input.labelRouting === undefined
      ? undefined
      : {
          ...input.labelRouting,
          ...(selection.crossModelOverride ? { crossModelOverride: true } : {}),
        };
  if (labelRouting !== undefined) {
    const conflict = checkGithubLabelRouting(labelRouting);
    if (conflict) return conflict;
  }
  const work = workPayloadFromGithub({
    title: input.title,
    body: input.body,
    pipeline: selection.pipeline,
    repo: input.repo,
    actor: input.actor,
  });
  const claimRunId = parseAttemptClaimRunId(input.body);
  return buildRequestDecision(
    input.repo,
    input.issue,
    input.deliveryId,
    selection.pipeline,
    { mode: 'review', ...crossRepoParams(input.labels) },
    work,
    undefined,
    labelRouting,
    selection.fallbackPipelines,
    {
      ...(input.requestedPipeline === undefined
        ? {}
        : { requestedPipeline: input.requestedPipeline }),
      ...(authorPipeline === undefined ? {} : { authorPipeline }),
      ...(claimRunId === undefined ? {} : { claimRunId }),
      actor: input.actor,
      title: input.title,
      body: input.body,
    },
  );
}

function interpretIssuesEvent(
  payload: unknown,
  deliveryId: string,
): IngestResult {
  const parsed = issuesEventSchema.safeParse(payload);
  if (!parsed.success) return ignore('malformed-payload');
  const { action, repository, issue, label, sender } = parsed.data;

  const repoIgnore = checkRepository(repository.full_name);
  if (repoIgnore) return repoIgnore;
  if (action !== 'labeled') return ignore('unhandled-action');
  if (issue.state !== 'open') return ignore('anchor-closed');

  if (!label) return ignore('no-trigger-label');
  const pipeline = AGENT_LABELS.get(label.name);
  if (!pipeline) return ignore('no-trigger-label');
  const labelRouting: GithubLabelRouting = {
    mode: 'implement',
    trigger: label.name,
    labels: issue.labels,
    requestedAt: issue.updated_at,
    actor: sender.login,
  };
  const conflict = checkGithubLabelRouting(labelRouting);
  if (conflict) return conflict;

  const work = workPayloadFromGithub({
    title: issue.title,
    body: issue.body,
    pipeline,
    repo: repository.full_name,
    actor: sender.login,
  });

  return buildRequestDecision(
    repository.full_name,
    issue.number,
    deliveryId,
    pipeline,
    {
      mode: 'implement',
      ...crossRepoParams(issue.labels ?? []),
    },
    work,
    terminalQuickTaskBinding(issue.body),
    labelRouting,
  );
}

function interpretPullRequestEvent(
  payload: unknown,
  deliveryId: string,
): IngestResult {
  const parsed = pullRequestEventSchema.safeParse(payload);
  if (!parsed.success) return ignore('malformed-payload');
  const {
    action,
    repository,
    pull_request: pullRequest,
    label,
    sender,
  } = parsed.data;

  const repoIgnore = checkRepository(repository.full_name);
  if (repoIgnore) return repoIgnore;

  if (action === 'opened' || action === 'ready_for_review') {
    if (pullRequest.state !== 'open') return ignore('anchor-closed');
    if (pullRequest.draft === true) return ignore('draft-pull-request');
    if (pullRequest.draft !== false || pullRequest.user === undefined) {
      return ignore('unhandled-action');
    }
    const labels = pullRequest.labels ?? [];
    if (
      isAutomatedReviewExcludedAuthor(pullRequest.user.login) ||
      labels.some(
        (item) =>
          item.name === 'status:needs-human' || item.name === 'bot:renovate',
      )
    ) {
      return ignore('excluded-review-author');
    }
    if (
      labels.some(
        (item) =>
          REVIEW_LABELS.has(item.name) || item.name === UNIFIED_REVIEW_LABEL,
      )
    ) {
      return ignore('explicit-review-label-present');
    }
    return buildReviewRequestDecision({
      repo: repository.full_name,
      issue: pullRequest.number,
      deliveryId,
      title: pullRequest.title,
      body: pullRequest.body,
      actor: sender.login,
      labels,
      userLogin: pullRequest.user.login,
      headRef: pullRequest.head?.ref,
    });
  }

  if (action !== 'labeled') return ignore('unhandled-action');
  if (pullRequest.state !== 'open') return ignore('anchor-closed');

  if (!label) return ignore('no-trigger-label');
  const labelName = label.name;
  const implementPipeline = AGENT_LABELS.get(labelName);
  if (implementPipeline) {
    const labelRouting: GithubLabelRouting = {
      mode: 'implement',
      trigger: labelName,
      labels: pullRequest.labels,
      requestedAt: pullRequest.updated_at,
      actor: sender.login,
    };
    const conflict = checkGithubLabelRouting(labelRouting);
    if (conflict) return conflict;
    const work = workPayloadFromGithub({
      title: pullRequest.title,
      body: pullRequest.body,
      pipeline: implementPipeline,
      repo: repository.full_name,
      actor: sender.login,
    });
    return buildRequestDecision(
      repository.full_name,
      pullRequest.number,
      deliveryId,
      implementPipeline,
      { mode: 'implement', ...crossRepoParams(pullRequest.labels ?? []) },
      work,
      undefined,
      labelRouting,
    );
  }

  const reviewPipeline = REVIEW_LABELS.get(labelName);
  if (reviewPipeline !== undefined || labelName === UNIFIED_REVIEW_LABEL) {
    return buildReviewRequestDecision({
      repo: repository.full_name,
      issue: pullRequest.number,
      deliveryId,
      title: pullRequest.title,
      body: pullRequest.body,
      actor: sender.login,
      labels: pullRequest.labels ?? [],
      userLogin: pullRequest.user?.login,
      headRef: pullRequest.head?.ref,
      requestedPipeline: reviewPipeline,
      labelRouting: {
        mode: 'review',
        trigger: labelName,
        labels: pullRequest.labels,
        requestedAt: pullRequest.updated_at,
        actor: sender.login,
      },
    });
  }

  return ignore('no-trigger-label');
}

function interpretIssueCommentEvent(
  payload: unknown,
  deliveryId: string,
): IngestResult {
  const parsed = issueCommentEventSchema.safeParse(payload);
  if (!parsed.success) return ignore('malformed-payload');
  const { action, repository, issue, comment, sender } = parsed.data;

  const repoIgnore = checkRepository(repository.full_name);
  if (repoIgnore) return repoIgnore;
  if (action !== 'created') return ignore('unhandled-action');
  // The console posted this reply as the operator and already decided its
  // dispatch (backend-actions.ts postComment); admitting it here would run
  // the same reply twice.
  if (isConsoleReply(comment.body)) return ignore('console-reply');

  const isUnifiedReviewCommand =
    issue.pull_request !== undefined &&
    matchReplyTrigger(comment.body, [UNIFIED_REVIEW_COMMAND]) ===
      UNIFIED_REVIEW_COMMAND;

  if (isUnifiedReviewCommand) {
    if (
      comment.user?.type === 'Bot' ||
      (comment.author_association !== 'OWNER' &&
        comment.author_association !== 'MEMBER')
    ) {
      return ignore('untrusted-author');
    }
    return buildReviewRequestDecision({
      repo: repository.full_name,
      issue: issue.number,
      deliveryId,
      title: issue.title,
      body: issue.body,
      actor: sender.login,
      labels: issue.labels,
      userLogin: issue.user?.login,
    });
  }

  const pipeline = matchReplyCommand(comment.body);
  if (!pipeline) return ignore('no-reply-command');

  if (
    comment.user?.type === 'Bot' ||
    (comment.author_association !== 'OWNER' &&
      comment.author_association !== 'MEMBER')
  ) {
    return ignore('untrusted-author');
  }

  // Derived from the ISSUE being replied to, not the comment -- the
  // comment text is already `params.reply`, a separate field the brief
  // reads independently (see the design spec's "brief is built from
  // work" note).
  const work = workPayloadFromGithub({
    title: issue.title,
    body: issue.body,
    pipeline,
    repo: repository.full_name,
    actor: sender.login,
  });

  return buildRequestDecision(
    repository.full_name,
    issue.number,
    deliveryId,
    pipeline,
    {
      mode: 'reply',
      reply: comment.body,
      ...crossRepoParams(issue.labels),
    },
    work,
  );
}

export function interpretDelivery(input: {
  event: string;
  deliveryId: string;
  payload: unknown;
}): IngestResult {
  switch (input.event) {
    case 'issues':
      return interpretIssuesEvent(input.payload, input.deliveryId);
    case 'pull_request':
      return interpretPullRequestEvent(input.payload, input.deliveryId);
    case 'issue_comment':
      return interpretIssueCommentEvent(input.payload, input.deliveryId);
    default:
      return ignore('unhandled-event');
  }
}

/**
 * Extracts the source-ordered lifecycle transition that can retire queued
 * implementation work. This is intentionally narrower than projection
 * refresh: only GitHub's actual `closed` action is authoritative, and review
 * or reply policy remains a stateful route concern.
 */
export function githubAnchorClosureFromDelivery(input: {
  event: string;
  payload: unknown;
}): GithubAnchorClosure | undefined {
  if (input.event !== 'issues' && input.event !== 'pull_request') {
    return undefined;
  }
  const parsed = closedAnchorEventSchema.safeParse(input.payload);
  if (
    !parsed.success ||
    !isControlPlaneRepository(parsed.data.repository.full_name)
  ) {
    return undefined;
  }
  const anchor =
    input.event === 'issues' ? parsed.data.issue : parsed.data.pull_request;
  if (anchor === undefined) return undefined;
  const taskId = taskIdSchema.safeParse({
    repo: parsed.data.repository.full_name,
    issue: anchor.number,
  });
  return taskId.success
    ? { taskId: taskId.data, closedAt: anchor.closed_at }
    : undefined;
}
