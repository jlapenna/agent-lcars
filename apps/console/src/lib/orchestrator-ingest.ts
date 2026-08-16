import { type TaskId, taskIdSchema } from '@agent-lcars/orchestrator';
import { z } from 'zod';

import { isControlPlaneRepository } from '@/lib/deployment';

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

const issuesEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  issue: z.object({ number: z.number().int().positive() }),
  label: labelSchema.optional(),
});

const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  pull_request: z.object({ number: z.number().int().positive() }),
  label: labelSchema.optional(),
});

const issueCommentEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  issue: z.object({ number: z.number().int().positive() }),
  comment: z.object({
    body: z.string(),
    author_association: z.string(),
  }),
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

/** Reply commands recognized at the start of a comment body. Order does not
 *  affect matching: a command is only accepted when it is followed by
 *  whitespace or end-of-string, so `/oc` never falsely matches a body that
 *  actually starts with `/opencode`. */
const REPLY_COMMANDS: ReadonlyArray<{ prefix: string; pipeline: Pipeline }> = [
  { prefix: '@claude', pipeline: 'claude' },
  { prefix: '@agent', pipeline: 'claude' },
  { prefix: '/codex', pipeline: 'codex' },
  { prefix: '/opencode', pipeline: 'opencode' },
  { prefix: '/oc', pipeline: 'opencode' },
];

function matchReplyCommand(body: string): Pipeline | undefined {
  const trimmed = body.trimStart();
  for (const { prefix, pipeline } of REPLY_COMMANDS) {
    if (!trimmed.startsWith(prefix)) continue;
    const rest = trimmed.slice(prefix.length);
    if (rest.length === 0 || /^\s/u.test(rest)) return pipeline;
  }
  return undefined;
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
): IngestResult {
  const taskId = taskIdSchema.safeParse({ repo, issue });
  if (!taskId.success) return ignore('malformed-payload');
  return { kind: 'request', taskId: taskId.data, requestId, pipeline, params };
}

function interpretIssuesEvent(
  payload: unknown,
  deliveryId: string,
): IngestResult {
  const parsed = issuesEventSchema.safeParse(payload);
  if (!parsed.success) return ignore('malformed-payload');
  const { action, repository, issue, label } = parsed.data;

  const repoIgnore = checkRepository(repository.full_name);
  if (repoIgnore) return repoIgnore;
  if (action !== 'labeled') return ignore('unhandled-action');

  const pipeline = label && IMPLEMENT_LABELS[label.name];
  if (!pipeline) return ignore('no-trigger-label');

  return buildRequestDecision(
    repository.full_name,
    issue.number,
    deliveryId,
    pipeline,
    {
      mode: 'implement',
    },
  );
}

function interpretPullRequestEvent(
  payload: unknown,
  deliveryId: string,
): IngestResult {
  const parsed = pullRequestEventSchema.safeParse(payload);
  if (!parsed.success) return ignore('malformed-payload');
  const { action, repository, pull_request: pullRequest, label } = parsed.data;

  const repoIgnore = checkRepository(repository.full_name);
  if (repoIgnore) return repoIgnore;
  if (action !== 'labeled') return ignore('unhandled-action');

  const labelName = label?.name;
  const implementPipeline = labelName && IMPLEMENT_LABELS[labelName];
  if (implementPipeline) {
    return buildRequestDecision(
      repository.full_name,
      pullRequest.number,
      deliveryId,
      implementPipeline,
      { mode: 'implement' },
    );
  }

  const reviewPipeline = labelName && REVIEW_LABELS[labelName];
  if (reviewPipeline) {
    return buildRequestDecision(
      repository.full_name,
      pullRequest.number,
      deliveryId,
      reviewPipeline,
      { mode: 'review' },
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
  const { action, repository, issue, comment } = parsed.data;

  const repoIgnore = checkRepository(repository.full_name);
  if (repoIgnore) return repoIgnore;
  if (action !== 'created') return ignore('unhandled-action');

  const pipeline = matchReplyCommand(comment.body);
  if (!pipeline) return ignore('no-reply-command');

  if (
    comment.author_association !== 'OWNER' &&
    comment.author_association !== 'MEMBER'
  ) {
    return ignore('untrusted-author');
  }

  return buildRequestDecision(
    repository.full_name,
    issue.number,
    deliveryId,
    pipeline,
    {
      mode: 'reply',
      reply: comment.body,
    },
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
