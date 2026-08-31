import { type GithubAnchorProjection } from '@agent-lcars/orchestrator';
import { z } from 'zod';

import { isControlPlaneRepository } from './deployment';

/**
 * Converts a complete GitHub webhook anchor into the bounded server-side
 * projection the console reads. It intentionally has no GitHub client: a
 * delivery is the only queue-ingress source, so render-time code cannot turn
 * a cache miss into repository enumeration.
 */
const userSchema = z.object({ login: z.string().min(1).max(256) });
const commentSchema = z.object({
  body: z.string().max(65_536),
  html_url: z.string().min(1).max(2_048),
  user: userSchema.optional().nullable(),
});
const labelSchema = z.union([
  z.string().min(1).max(256),
  z.object({ name: z.string().min(1).max(256) }),
]);
const anchorSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(256),
  body: z.string().nullable(),
  html_url: z.string().min(1).max(2_048),
  state: z.enum(['open', 'closed']),
  updated_at: z.iso.datetime({ offset: false }),
  user: userSchema.optional().nullable(),
  labels: z.array(labelSchema).max(256),
  assignees: z.array(userSchema.nullable()).max(256).optional().nullable(),
  parent_issue_url: z.string().max(2_048).optional().nullable(),
  sub_issues_summary: z
    .object({
      total: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
    })
    .optional()
    .nullable(),
  draft: z.boolean().optional(),
  mergeable_state: z.string().max(64).optional().nullable(),
  requested_reviewers: z
    .array(userSchema.nullable())
    .max(256)
    .optional()
    .nullable(),
  pull_request: z.unknown().optional(),
});

const issuesPayloadSchema = z.object({
  repository: z.object({ full_name: z.string().min(1).max(140) }),
  issue: anchorSchema,
  comment: commentSchema.optional(),
});
const pullRequestPayloadSchema = z.object({
  repository: z.object({ full_name: z.string().min(1).max(140) }),
  pull_request: anchorSchema,
  comment: commentSchema.optional(),
});

const CLOSING_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;
const MERGE_STATES = new Set([
  'clean',
  'dirty',
  'blocked',
  'unstable',
  'behind',
  'draft',
  'unknown',
]);

function labelsFrom(labels: z.infer<typeof anchorSchema>['labels']): string[] {
  return labels.map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}

function linkedIssueNumbers(
  body: string,
  selfNumber: number,
): number[] | undefined {
  const numbers = new Set<number>();
  for (const match of body.matchAll(CLOSING_KEYWORD_RE)) {
    const number = Number(match[1]);
    if (number !== selfNumber) numbers.add(number);
  }
  return numbers.size === 0 ? undefined : [...numbers];
}

function parentNumber(url: string | null | undefined): number | undefined {
  const match = url?.match(/\/issues\/(\d+)$/u);
  return match === undefined || match === null ? undefined : Number(match[1]);
}

function toProjection(input: {
  repo: string;
  anchor: z.infer<typeof anchorSchema>;
  kind: 'issue' | 'pr';
  observedAt: string;
  comment?: z.infer<typeof commentSchema>;
}): GithubAnchorProjection {
  const mergeableState = input.anchor.mergeable_state?.toLowerCase();
  const linked = linkedIssueNumbers(
    input.anchor.body ?? '',
    input.anchor.number,
  );
  const parent = parentNumber(input.anchor.parent_issue_url);
  return {
    anchor: { repo: input.repo, issue: input.anchor.number },
    kind: input.kind,
    state: input.anchor.state,
    title: input.anchor.title,
    body: input.anchor.body ?? '',
    url: input.anchor.html_url,
    ...(input.anchor.user?.login === undefined
      ? {}
      : { author: input.anchor.user.login }),
    labels: labelsFrom(input.anchor.labels),
    assigneeLogins: (input.anchor.assignees ?? []).flatMap((assignee) =>
      assignee?.login === undefined ? [] : [assignee.login],
    ),
    ...(input.comment === undefined
      ? {}
      : {
          lastComment: {
            body: input.comment.body,
            url: input.comment.html_url,
            ...(input.comment.user?.login === undefined
              ? {}
              : { author: input.comment.user.login }),
          },
        }),
    ...(parent === undefined ? {} : { parentNumber: parent }),
    ...(input.anchor.sub_issues_summary === undefined ||
    input.anchor.sub_issues_summary === null
      ? {}
      : { subIssues: input.anchor.sub_issues_summary }),
    ...(linked === undefined ? {} : { linkedIssueNumbers: linked }),
    ...(input.kind === 'pr' && input.anchor.draft !== undefined
      ? { draft: input.anchor.draft }
      : {}),
    ...(input.kind === 'pr' && mergeableState !== undefined
      ? {
          mergeableState: MERGE_STATES.has(mergeableState)
            ? (mergeableState as GithubAnchorProjection['mergeableState'])
            : 'unknown',
        }
      : {}),
    ...(input.kind === 'pr'
      ? {
          requestedReviewerLogins: (
            input.anchor.requested_reviewers ?? []
          ).flatMap((reviewer) =>
            reviewer?.login === undefined ? [] : [reviewer.login],
          ),
        }
      : {}),
    sourceUpdatedAt: input.anchor.updated_at,
    observedAt: input.observedAt,
  };
}

/**
 * Returns a projection only for configured repositories and complete current
 * webhook payloads. A malformed delivery remains admission-parser territory;
 * it never causes a render-time GitHub fallback.
 */
export function githubAnchorProjectionFromDelivery(input: {
  event: string;
  payload: unknown;
  observedAt: string;
}): GithubAnchorProjection | undefined {
  const parse =
    input.event === 'pull_request'
      ? pullRequestPayloadSchema.safeParse(input.payload)
      : input.event === 'issues' || input.event === 'issue_comment'
        ? issuesPayloadSchema.safeParse(input.payload)
        : undefined;
  if (
    !parse?.success ||
    !isControlPlaneRepository(parse.data.repository.full_name)
  ) {
    return undefined;
  }

  if ('pull_request' in parse.data) {
    return toProjection({
      repo: parse.data.repository.full_name,
      anchor: parse.data.pull_request,
      kind: 'pr',
      observedAt: input.observedAt,
      ...(parse.data.comment === undefined
        ? {}
        : { comment: parse.data.comment }),
    });
  }
  return toProjection({
    repo: parse.data.repository.full_name,
    anchor: parse.data.issue,
    kind: parse.data.issue.pull_request === undefined ? 'issue' : 'pr',
    observedAt: input.observedAt,
    ...(parse.data.comment === undefined
      ? {}
      : { comment: parse.data.comment }),
  });
}

const checkRunPayloadSchema = z.object({
  repository: z.object({ full_name: z.string().min(1).max(140) }),
  check_run: z.object({
    name: z.string().min(1).max(256),
    html_url: z.string().min(1).max(2_048),
    status: z.string().min(1).max(64),
    conclusion: z.string().max(64).nullable(),
    pull_requests: z
      .array(z.object({ number: z.number().int().positive() }))
      .max(8),
  }),
});

export interface GithubAnchorProjectionSignal {
  anchor: GithubAnchorProjection['anchor'];
  checkRun?: NonNullable<GithubAnchorProjection['checkRuns']>[number];
  reviewThread?: { id: string; resolved: boolean };
}

const reviewThreadPayloadSchema = z.object({
  repository: z.object({ full_name: z.string().min(1).max(140) }),
  pull_request: z.object({ number: z.number().int().positive() }),
  thread: z.object({
    id: z.string().min(1).max(256),
    is_resolved: z.boolean(),
  }),
});

/**
 * Check-run deliveries update an existing server-owned PR projection. They
 * have no complete issue payload, so they can never create an anchor or
 * trigger a GitHub read from rendering.
 */
export function githubAnchorProjectionSignalFromDelivery(input: {
  event: string;
  payload: unknown;
}): GithubAnchorProjectionSignal[] {
  if (input.event === 'check_run') {
    const parsed = checkRunPayloadSchema.safeParse(input.payload);
    if (
      !parsed.success ||
      !isControlPlaneRepository(parsed.data.repository.full_name)
    ) {
      return [];
    }
    return parsed.data.check_run.pull_requests.map((pullRequest) => ({
      anchor: {
        repo: parsed.data.repository.full_name,
        issue: pullRequest.number,
      },
      checkRun: {
        name: parsed.data.check_run.name,
        url: parsed.data.check_run.html_url,
        status: parsed.data.check_run.status.toLowerCase(),
        conclusion: parsed.data.check_run.conclusion?.toLowerCase() ?? null,
      },
    }));
  }
  if (input.event !== 'pull_request_review_thread') return [];
  const parsed = reviewThreadPayloadSchema.safeParse(input.payload);
  if (
    !parsed.success ||
    !isControlPlaneRepository(parsed.data.repository.full_name)
  ) {
    return [];
  }
  return [
    {
      anchor: {
        repo: parsed.data.repository.full_name,
        issue: parsed.data.pull_request.number,
      },
      reviewThread: {
        id: parsed.data.thread.id,
        resolved: parsed.data.thread.is_resolved,
      },
    },
  ];
}
