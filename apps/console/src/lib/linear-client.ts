import 'server-only';

import {
  type TrackerIssue,
  trackerIssueSchema,
} from '@agent-lcars/dispatch-contracts';
import { z } from 'zod';

/** Shared transport for intake, current-source reads and durable publication. */
export async function linearQuery(
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4_000,
): Promise<unknown> {
  const token = process.env['AGENT_LCARS_LINEAR_API_KEY']?.trim();
  if (!token)
    throw new Error('AGENT_LCARS_LINEAR_API_KEY is required for Linear');
  const response = await fetchImpl('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Linear API returned ${response.status}`);
  const result = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.unknown()).optional(),
    })
    .parse(await response.json());
  if (result.errors?.length || result.data === undefined)
    throw new Error('Linear GraphQL operation failed');
  return result.data;
}

const identity = z.object({ id: z.uuid(), name: z.string() });
const issueSchema = z.object({
  id: z.uuid(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  url: z.url(),
  updatedAt: z.iso.datetime(),
  team: z.object({ id: z.uuid() }),
  state: z.object({ id: z.uuid(), name: z.string(), type: z.string() }),
  archivedAt: z.string().nullish(),
  trashed: z.boolean().nullish(),
  assignee: identity.nullable(),
  labels: z.object({
    nodes: z.array(identity),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
const ISSUE_FIELDS = `id identifier title description url updatedAt archivedAt trashed team { id } state { id name type } assignee { id name } labels(first: 250) { nodes { id name } pageInfo { hasNextPage } }`;

export function linearIssueSnapshot(
  organizationId: string,
  value: unknown,
): TrackerIssue {
  const issue = issueSchema.parse(value);
  if (issue.labels.pageInfo.hasNextPage)
    throw new Error('Linear issue labels exceed the supported bound');
  if (new URL(issue.url).origin !== 'https://linear.app')
    throw new Error('Unexpected Linear issue URL');
  return trackerIssueSchema.parse({
    reference: { tracker: 'linear', organizationId, issueId: issue.id },
    identifier: issue.identifier,
    title: issue.title.slice(0, 256),
    description: (issue.description ?? '').slice(0, 65_536),
    url: issue.url,
    updatedAt: issue.updatedAt,
    teamId: issue.team.id,
    status: issue.state,
    state:
      issue.archivedAt ||
      issue.trashed ||
      ['completed', 'canceled', 'duplicate'].includes(issue.state.type)
        ? 'closed'
        : 'open',
    labels: issue.labels.nodes,
    assignees: issue.assignee ? [issue.assignee] : [],
  });
}

export async function readLinearIssue(
  organizationId: string,
  issue: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TrackerIssue | undefined> {
  const result = z
    .object({
      organization: z.object({ id: z.uuid() }),
      issue: issueSchema.nullable(),
    })
    .parse(
      await linearQuery(
        `query LcarsIssue($id: String!) { organization { id } issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id: issue },
        fetchImpl,
      ),
    );
  if (result.organization.id !== organizationId)
    throw new Error('Linear token belongs to a different organization');
  return result.issue === null
    ? undefined
    : linearIssueSnapshot(organizationId, result.issue);
}

export async function listLinearIssues(
  organizationId: string,
  teamId: string,
  cursor?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ issues: TrackerIssue[]; nextCursor?: string }> {
  const result = z
    .object({
      organization: z.object({ id: z.uuid() }),
      team: z.object({
        issues: z.object({
          nodes: z.array(issueSchema),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      }),
    })
    .parse(
      await linearQuery(
        `query LcarsTeamIssues($team: String!, $after: String) { organization { id } team(id: $team) { issues(first: 50, after: $after, includeArchived: true) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
        { team: teamId, after: cursor ?? null },
        fetchImpl,
      ),
    );
  if (result.organization.id !== organizationId)
    throw new Error('Linear token belongs to a different organization');
  const page = result.team.issues;
  if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
    throw new Error('Linear issue pagination is incomplete');
  return {
    issues: page.nodes.map((issue) =>
      linearIssueSnapshot(organizationId, issue),
    ),
    ...(page.pageInfo.hasNextPage
      ? { nextCursor: page.pageInfo.endCursor as string }
      : {}),
  };
}

export const linearCommentSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  url: z.url(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  user: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  issue: z.object({ id: z.uuid() }).nullable(),
});
export type LinearComment = z.infer<typeof linearCommentSchema>;
export async function readLinearComment(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearComment | undefined> {
  const result = z
    .object({ comment: linearCommentSchema.nullable() })
    .parse(
      await linearQuery(
        `query LcarsComment($id: String!) { comment(id: $id) { id body url createdAt updatedAt user { id name } issue { id } } }`,
        { id },
        fetchImpl,
      ),
    );
  return result.comment ?? undefined;
}

export async function readLinearCommentsPage(
  issueId: string,
  after?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ comments: LinearComment[]; nextCursor?: string }> {
  const data = z
    .object({
      issue: z.object({
        comments: z.object({
          nodes: z.array(linearCommentSchema),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      }),
    })
    .parse(
      await linearQuery(
        `query LcarsIssueComments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after, includeArchived: true) { nodes { id body url createdAt updatedAt user { id name } issue { id } } pageInfo { hasNextPage endCursor } } } }`,
        { id: issueId, after: after ?? null },
        fetchImpl,
      ),
    );
  const page = data.issue.comments;
  if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
    throw new Error('Linear comment pagination is incomplete');
  return {
    comments: page.nodes,
    ...(page.pageInfo.hasNextPage
      ? { nextCursor: page.pageInfo.endCursor as string }
      : {}),
  };
}

export async function readLinearComments(
  issueId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearComment[]> {
  const comments: LinearComment[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const data = await readLinearCommentsPage(issueId, after, fetchImpl);
    comments.push(...data.comments);
    if (!data.nextCursor) return comments;
    after = data.nextCursor;
  }
  throw new Error('Linear comments exceed the bounded read');
}

export async function readLinearLabels(
  teamId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; name: string }[]> {
  const labels: { id: string; name: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const data = z
      .object({
        issueLabels: z.object({
          nodes: z.array(
            z.object({
              id: z.uuid(),
              name: z.string(),
              team: z.object({ id: z.uuid() }).nullable(),
            }),
          ),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      })
      .parse(
        await linearQuery(
          `query LcarsLabels($after: String) { issueLabels(first: 100, after: $after) { nodes { id name team { id } } pageInfo { hasNextPage endCursor } } }`,
          { after },
          fetchImpl,
        ),
      );
    labels.push(
      ...data.issueLabels.nodes
        .filter((label) => label.team === null || label.team.id === teamId)
        .map(({ id, name }) => ({ id, name })),
    );
    if (!data.issueLabels.pageInfo.hasNextPage) return labels;
    after = data.issueLabels.pageInfo.endCursor;
    if (!after) throw new Error('Linear label pagination is incomplete');
  }
  throw new Error('Linear labels exceed the bounded read');
}

export async function updateLinearIssue(
  organizationId: string,
  issueId: string,
  input: {
    stateId?: string;
    addedLabelIds?: string[];
    removedLabelIds?: string[];
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!(await readLinearIssue(organizationId, issueId, fetchImpl)))
    throw new Error('Linear issue no longer exists');
  const result = z
    .object({
      issueUpdate: z.object({
        success: z.boolean(),
        issue: z.object({ id: z.uuid() }).nullable(),
      }),
    })
    .parse(
      await linearQuery(
        `mutation LcarsIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }`,
        { id: issueId, input },
        fetchImpl,
      ),
    );
  if (!result.issueUpdate.success || result.issueUpdate.issue?.id !== issueId)
    throw new Error('Linear issue update was not confirmed');
}
