import 'server-only';

import {
  type IssueComment,
  type IssueReference,
  issueReferenceSchema,
  type TrackerIssue,
} from '@agent-lcars/dispatch-contracts';
import { logger } from '@agent-lcars/logging';
import {
  type GithubAnchorProjection,
  isWorkAnchor,
  type Task,
} from '@agent-lcars/orchestrator';
import { z } from 'zod';

import { loadGithubAnchorLifecycle } from './github-anchor-lifecycle';
import type { DispatchTokenProvider } from './github-app-tokens';
import {
  linearQuery,
  readLinearCommentsPage,
  readLinearIssue,
  updateLinearIssue,
} from './linear-client';
import {
  linearConfig,
  linearIssueRepository,
  linearTeam,
} from './linear-config';

export interface IssueTrackerDeps {
  tokens?: DispatchTokenProvider;
  githubApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Provider adapters own transport; source identity never doubles as checkout
 * identity. Existing GitHub anchors retain their persisted/public shape. */
export interface IssueTracker {
  read(reference: IssueReference): Promise<TrackerIssue | undefined>;
  lifecycle(
    reference: IssueReference,
    repository?: string,
  ): Promise<{ state: 'open' | 'closed'; sourceUpdatedAt: string } | undefined>;
  comment(reference: IssueReference, id: string, body: string): Promise<void>;
  status(reference: IssueReference, status: string): Promise<void>;
  comments(
    reference: IssueReference,
    cursor?: string,
  ): Promise<{ comments: IssueComment[]; nextCursor?: string }>;
}

export function issueFromGithubProjection(
  projection: GithubAnchorProjection,
): TrackerIssue {
  return {
    reference: { tracker: 'github', ...projection.anchor },
    identifier: `${projection.anchor.repo}#${projection.anchor.issue}`,
    url: projection.url,
    title: projection.title,
    description: projection.body,
    state: projection.state,
    updatedAt: projection.sourceUpdatedAt,
    labels: projection.labels.map((name) => ({ id: name, name })),
    assignees: projection.assigneeLogins.map((name) => ({ id: name, name })),
  };
}

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function issueTracker(deps: IssueTrackerDeps = {}): IssueTracker {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const githubRequest = async (
    ref: Extract<IssueReference, { tracker: 'github' }>,
    suffix: string,
    init?: RequestInit,
  ) => {
    if (!deps.tokens)
      throw new Error('GitHub issue tracker credentials are unavailable');
    const response = await fetchImpl(
      `${deps.githubApiBaseUrl ?? 'https://api.github.com'}/repos/${ref.repo}/issues/${ref.issue}${suffix}`,
      {
        ...init,
        headers: githubHeaders(await deps.tokens.tokenFor(ref.repo)),
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok)
      throw new Error(`GitHub issue tracker returned ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  const read: IssueTracker['read'] = async (ref) => {
    if (ref.tracker === 'linear')
      return readLinearIssue(ref.organizationId, ref.issueId, fetchImpl);
    const data = z
      .object({
        number: z.number(),
        title: z.string(),
        body: z.string().nullable(),
        html_url: z.url(),
        updated_at: z.iso.datetime(),
        state: z.enum(['open', 'closed']),
        labels: z.array(
          z.union([
            z.string(),
            z.object({ name: z.string(), id: z.number().optional() }),
          ]),
        ),
        assignees: z
          .array(z.object({ login: z.string(), id: z.number() }))
          .nullish(),
      })
      .parse(await githubRequest(ref, ''));
    return {
      reference: ref,
      identifier: `${ref.repo}#${ref.issue}`,
      title: data.title,
      description: (data.body ?? '').slice(0, 65_536),
      url: data.html_url,
      updatedAt: data.updated_at,
      state: data.state,
      labels: data.labels.map((label) =>
        typeof label === 'string'
          ? { id: label, name: label }
          : { id: String(label.id ?? label.name), name: label.name },
      ),
      assignees: (data.assignees ?? []).map((user) => ({
        id: String(user.id),
        name: user.login,
      })),
    };
  };
  return {
    read,
    comments: async (ref, cursor) => {
      if (ref.tracker === 'linear') {
        const page = await readLinearCommentsPage(
          ref.issueId,
          cursor,
          fetchImpl,
        );
        return {
          comments: page.comments.map((comment) => ({
            id: comment.id,
            body: comment.body.slice(0, 65_536),
            url: comment.url,
            updatedAt: comment.updatedAt,
            ...(comment.user ? { author: comment.user.name } : {}),
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      }
      const page = cursor ? Number(cursor) : 1;
      if (!Number.isSafeInteger(page) || page < 1)
        throw new Error('Invalid GitHub comment cursor');
      const comments = z
        .array(
          z.object({
            id: z.number().int(),
            body: z.string().nullish(),
            html_url: z.url(),
            updated_at: z.iso.datetime(),
            user: z.object({ login: z.string() }).nullish(),
          }),
        )
        .parse(await githubRequest(ref, `/comments?per_page=100&page=${page}`));
      return {
        comments: comments.map((comment) => ({
          id: String(comment.id),
          body: (comment.body ?? '').slice(0, 65_536),
          url: comment.html_url,
          updatedAt: comment.updated_at,
          ...(comment.user ? { author: comment.user.login } : {}),
        })),
        ...(comments.length === 100 ? { nextCursor: String(page + 1) } : {}),
      };
    },
    lifecycle: async (ref, repository) => {
      try {
        if (ref.tracker === 'github') {
          if (!deps.tokens)
            throw new Error('GitHub credentials are unavailable');
          return loadGithubAnchorLifecycle(
            {
              tokens: deps.tokens,
              fetchImpl,
              githubApiBaseUrl: deps.githubApiBaseUrl,
            },
            ref,
          );
        }
        const issue = await read(ref);
        if (!issue) return undefined;
        const config = linearConfig();
        if (
          issue &&
          (!config ||
            config.organizationId !== ref.organizationId ||
            !linearTeam(config, issue.teamId ?? '') ||
            (repository &&
              (!config.routes.some(
                (route) =>
                  route.teamId === issue.teamId && route.repo === repository,
              ) ||
                (linearIssueRepository(config, issue) !== undefined &&
                  linearIssueRepository(config, issue) !== repository))))
        )
          throw new Error(
            'Linear source moved outside its admitted repository scope',
          );
        return {
          state: issue.state,
          sourceUpdatedAt: issue.updatedAt,
        };
      } catch {
        logger.warn('agent-lcars: issue lifecycle lookup unavailable', {
          tracker: ref.tracker,
        });
        return undefined;
      }
    },
    comment: async (ref, id, body) => {
      if (ref.tracker === 'github') {
        await githubRequest(ref, '/comments', {
          method: 'POST',
          body: JSON.stringify({ body }),
        });
        return;
      }
      if (!(await read(ref))) throw new Error('Linear issue no longer exists');
      const result = z
        .object({
          commentCreate: z.object({
            success: z.boolean(),
            comment: z
              .object({
                id: z.uuid(),
                issue: z.object({ id: z.uuid() }).nullable(),
              })
              .nullable(),
          }),
        })
        .parse(
          await linearQuery(
            `mutation LcarsTrackerComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id issue { id } } } }`,
            { input: { id, issueId: ref.issueId, body } },
            fetchImpl,
          ),
        );
      if (
        !result.commentCreate.success ||
        result.commentCreate.comment?.id !== id ||
        result.commentCreate.comment.issue?.id !== ref.issueId
      )
        throw new Error('Linear outcome comment was not confirmed');
    },
    status: async (ref, status) => {
      if (ref.tracker === 'github') {
        if (!['open', 'closed'].includes(status))
          throw new Error('Unsupported GitHub issue state');
        await githubRequest(ref, '', {
          method: 'PATCH',
          body: JSON.stringify({ state: status }),
        });
      } else
        await updateLinearIssue(
          ref.organizationId,
          ref.issueId,
          { stateId: status },
          fetchImpl,
        );
    },
  };
}

/** Older persisted Linear work used an opaque return address. Read it only
 * to recover its existing identity; normal refresh persists the typed source. */
export function issueReferenceForTask(task: Task): IssueReference | undefined {
  if (task.issue) return task.issue.reference;
  if (!isWorkAnchor(task.task)) return { tracker: 'github', ...task.task };
  const origin = task.work['origin'] as
    { channel?: string; thread?: string } | undefined;
  if (origin?.channel !== 'linear' || !origin.thread) return undefined;
  try {
    return issueReferenceSchema.parse({
      tracker: 'linear',
      ...JSON.parse(origin.thread),
    });
  } catch {
    return undefined;
  }
}
