import { REPLY_COMMANDS } from '@agent-lcars/dispatch-contracts';
import { type TaskId, taskIdSchema } from '@agent-lcars/orchestrator';
import { type WorkPayload } from '@agent-lcars/work';
import { z } from 'zod';

import { isControlPlaneRepository } from '@/lib/deployment';
import { matchReplyTrigger } from '@/lib/reply-trigger';

import { workPayloadFromGithub } from './work-from-github';

/**
 * Interprets one GitHub webhook delivery and decides whether it is a
 * request to work a task. Pure: no I/O, no throwing on malformed input --
 * every parse failure and every non-matching payload becomes an
 * `IngestIgnore` with a short reason instead. Callers own dispatch; this
 * module only decides *whether* and *what*.
 */

export type Pipeline = 'claude' | 'codex' | 'opencode';

export interface IngestDecision {
  kind: 'request';
  taskId: TaskId;
  /** The `x-github-delivery` GUID; doubles as the orchestrator's
   *  idempotency key for this request. */
  requestId: string;
  pipeline: Pipeline;
  /** Always includes `mode`; includes `reply` when `mode` is `'reply'`. */
  params: Record<string, string>;
  /** Present when the anchor (issue or PR) carried a title -- absent for a
   *  payload shape this parser could not read one from, which dispatches
   *  exactly as it did before sub-project 5 (no `work` on the task, or the
   *  task's already-set `work` carried forward -- see `decide.ts`'s
   *  `baseTask`). */
  work?: WorkPayload;
}

export interface IngestIgnore {
  kind: 'ignore';
  /** Short machine-readable reason, e.g. 'wrong-repo', 'no-trigger-label'. */
  reason: string;
}

export type IngestResult = IngestDecision | IngestIgnore;

function ignore(reason: string): IngestIgnore {
  return { kind: 'ignore', reason };
}

const repositorySchema = z.object({ full_name: z.string().min(1) });
const labelSchema = z.object({ name: z.string().min(1) });
/** GitHub always sends a top-level `sender` -- the actor who triggered
 *  this specific delivery (whoever applied the label, whoever posted the
 *  comment). Optional here only so a malformed/legacy-shaped test fixture
 *  degrades to the label fallback instead of failing to parse. */
const senderSchema = z.object({ login: z.string().min(1) }).optional();
/** GitHub always sends `title`; `body` may be `null`. Both optional here
 *  so a payload shape this parser has not seen before still admits the
 *  dispatch -- it just derives no `work` for it (see the `issue.title`
 *  guard in each `interpret*Event` below), matching how a legacy task
 *  (pre-sub-project-5) already dispatches with no `work` payload. */
const issueBodySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).optional(),
  body: z.string().nullable().optional(),
});

const issuesEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  issue: issueBodySchema,
  label: labelSchema.optional(),
  sender: senderSchema,
});

const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  pull_request: issueBodySchema,
  label: labelSchema.optional(),
  sender: senderSchema,
});

const issueCommentEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  issue: issueBodySchema,
  comment: z.object({
    body: z.string(),
    author_association: z.string(),
    user: z.object({ type: z.string() }).optional(),
  }),
  sender: senderSchema,
});

/** `issues`/`pull_request` `labeled` action, label `agent:<pipeline>` ->
 *  work the issue/PR, mode `implement`. */
const IMPLEMENT_LABELS: Readonly<Record<string, Pipeline>> = {
  'agent:claude': 'claude',
  'agent:codex': 'codex',
  'agent:opencode': 'opencode',
};

/** `pull_request` `labeled` action, label `review:<pipeline>` -> work that
 *  PR, mode `review`. Issues have no review-label trigger. */
const REVIEW_LABELS: Readonly<Record<string, Pipeline>> = {
  'review:claude': 'claude',
  'review:codex': 'codex',
  'review:opencode': 'opencode',
};

function matchReplyCommand(body: string): Pipeline | undefined {
  const trigger = matchReplyTrigger(body, [...REPLY_COMMANDS.keys()]);
  return trigger ? REPLY_COMMANDS.get(trigger) : undefined;
}

function checkRepository(fullName: string): IngestIgnore | undefined {
  return isControlPlaneRepository(fullName) ? undefined : ignore('wrong-repo');
}

/** Builds the decision, re-validating the assembled task identifier against
 *  the orchestrator's own schema rather than trusting the webhook shape. */
function buildRequestDecision(
  repo: string,
  issue: number,
  requestId: string,
  pipeline: Pipeline,
  params: Record<string, string>,
  work?: WorkPayload,
): IngestResult {
  const taskId = taskIdSchema.safeParse({ repo, issue });
  if (!taskId.success) return ignore('malformed-payload');
  return {
    kind: 'request',
    taskId: taskId.data,
    requestId,
    pipeline,
    params,
    ...(work === undefined ? {} : { work }),
  };
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

  const pipeline = label && IMPLEMENT_LABELS[label.name];
  if (!pipeline) return ignore('no-trigger-label');

  const work = issue.title
    ? workPayloadFromGithub({
        title: issue.title,
        body: issue.body,
        pipeline,
        repo: repository.full_name,
        actor: sender?.login,
        label: label?.name,
      })
    : undefined;

  return buildRequestDecision(
    repository.full_name,
    issue.number,
    deliveryId,
    pipeline,
    {
      mode: 'implement',
    },
    work,
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
  if (action !== 'labeled') return ignore('unhandled-action');

  const labelName = label?.name;
  const implementPipeline = labelName && IMPLEMENT_LABELS[labelName];
  if (implementPipeline) {
    const work = pullRequest.title
      ? workPayloadFromGithub({
          title: pullRequest.title,
          body: pullRequest.body,
          pipeline: implementPipeline,
          repo: repository.full_name,
          actor: sender?.login,
          label: labelName,
        })
      : undefined;
    return buildRequestDecision(
      repository.full_name,
      pullRequest.number,
      deliveryId,
      implementPipeline,
      { mode: 'implement' },
      work,
    );
  }

  const reviewPipeline = labelName && REVIEW_LABELS[labelName];
  if (reviewPipeline) {
    const work = pullRequest.title
      ? workPayloadFromGithub({
          title: pullRequest.title,
          body: pullRequest.body,
          pipeline: reviewPipeline,
          repo: repository.full_name,
          actor: sender?.login,
          label: labelName,
        })
      : undefined;
    return buildRequestDecision(
      repository.full_name,
      pullRequest.number,
      deliveryId,
      reviewPipeline,
      { mode: 'review' },
      work,
    );
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
  const work = issue.title
    ? workPayloadFromGithub({
        title: issue.title,
        body: issue.body,
        pipeline,
        repo: repository.full_name,
        actor: sender?.login,
      })
    : undefined;

  return buildRequestDecision(
    repository.full_name,
    issue.number,
    deliveryId,
    pipeline,
    {
      mode: 'reply',
      reply: comment.body,
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
