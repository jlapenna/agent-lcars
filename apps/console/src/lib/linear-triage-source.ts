import 'server-only';

import type { TriageAnchor } from '@agent-lcars/dispatch-contracts';
import type { OrchestratorStore } from '@agent-lcars/orchestrator';
import { z } from 'zod';

import { readTrackerIssueOwner } from './anchor-owner';
import { getCliSessions } from './cli-sessions';
import { getGithubClient } from './github-client';
import {
  linearQuery,
  readLinearComments,
  readLinearIssue,
} from './linear-client';
import {
  linearConfig,
  linearIssueRepository,
  linearTeam,
  linearTriageDispatchRoute,
} from './linear-config';
import type { TriageSource } from './triage-source-types';
import { getWatchedRepos } from './watched-repos-config';
import { sessionsForRuns } from './work-sessions';

/** Linked PRs are evidence even when they were created outside LCARS. An
 * incomplete attachment read defers triage instead of assuming no owner. */
async function hasOpenPullRequest(
  issueId: string,
  repository: string,
): Promise<boolean> {
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const data = z
      .object({
        issue: z.object({
          attachments: z.object({
            nodes: z.array(z.object({ url: z.string() })),
            pageInfo: z.object({
              hasNextPage: z.boolean(),
              endCursor: z.string().nullable(),
            }),
          }),
        }),
      })
      .parse(
        await linearQuery(
          `query LcarsIssueAttachments($id: String!, $after: String) { issue(id: $id) { attachments(first: 100, after: $after) { nodes { url } pageInfo { hasNextPage endCursor } } } }`,
          { id: issueId, after },
        ),
      );
    for (const attachment of data.issue.attachments.nodes) {
      const match =
        /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/u.exec(
          attachment.url,
        );
      if (!match || match[1]?.toLowerCase() !== repository.toLowerCase())
        continue;
      const [owner = '', repo = ''] = repository.split('/');
      const pr = await getGithubClient().pulls.get({
        owner,
        repo,
        pull_number: Number(match[2]),
      });
      if (pr.data.state === 'open') return true;
    }
    if (!data.issue.attachments.pageInfo.hasNextPage) return false;
    after = data.issue.attachments.pageInfo.endCursor;
    if (!after) throw new Error('Linear attachment pagination is incomplete');
  }
  throw new Error('Linear attachments exceed the bounded read');
}

export async function loadLinearTriageSource(
  store: OrchestratorStore,
  anchor: Extract<TriageAnchor, { source: unknown }>,
): Promise<TriageSource> {
  const observedAt = new Date().toISOString();
  const config = linearConfig();
  if (!config || config.organizationId !== anchor.source.organizationId)
    throw new Error('Linear triage organization is unavailable');
  const issue = await readLinearIssue(
    config.organizationId,
    anchor.source.issueId,
  );
  if (!issue) throw new Error('Linear triage issue no longer exists');
  const team = linearTeam(config, issue.teamId ?? '');
  const triage = team && 'triage' in team ? team.triage : undefined;
  const routes = config.routes.filter(
    (route) =>
      route.teamId === issue.teamId &&
      issue.labels.some((label) => label.id === route.labelId),
  );
  const repository = linearIssueRepository(config, issue);
  const readyRoute = linearTriageDispatchRoute(
    config,
    issue.teamId ?? '',
    anchor.repo,
  );
  const [comments, ownership, openFixPr] = await Promise.all([
    readLinearComments(anchor.source.issueId),
    readTrackerIssueOwner(
      {
        runtime: { store },
        now: () => new Date(),
        sessionsFor: sessionsForRuns,
        cliSessions: (repository) => getCliSessions({ repo: repository }),
      },
      issue,
      anchor.repo,
    ),
    hasOpenPullRequest(anchor.source.issueId, anchor.repo),
  ]);
  if (!ownership.complete)
    throw new Error('Linear triage ownership read incomplete');
  return {
    anchor,
    issue,
    pipeline: triage?.pipeline,
    observedAt,
    title: issue.title,
    body: issue.description,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    labelIds: issue.labels.map((label) => label.id),
    dispatchLabel: readyRoute?.labelId,
    bug:
      triage?.bugLabelIds.some((id) =>
        issue.labels.some((label) => label.id === id),
      ) ?? false,
    routed: routes.length > 0,
    assignees: issue.assignees.map((user) => user.id),
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      updatedAt: comment.updatedAt,
    })),
    openFixPr,
    owned: ownership.verdict !== 'none',
    parked: ownership.task?.state === 'parked',
    enabled:
      triage !== undefined &&
      readyRoute !== undefined &&
      repository === anchor.repo &&
      getWatchedRepos().some(
        (repo) =>
          `${repo.owner}/${repo.name}` === anchor.repo && repo.agents !== false,
      ),
  };
}
