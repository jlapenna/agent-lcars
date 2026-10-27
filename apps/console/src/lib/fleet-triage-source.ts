import 'server-only';

import { createHash } from 'node:crypto';

import type { TriagePublication } from '@agent-lcars/dispatch-contracts';
import type {
  GithubAnchor,
  OrchestratorStore,
} from '@agent-lcars/orchestrator';

import { readAnchorOwner } from './anchor-owner';
import { getCliSessions } from './cli-sessions';
import { getGithubClient } from './github-client';
import { getWatchedRepos } from './watched-repos-config';
import { sessionsForRuns } from './work-sessions';

export const triageSourceKey = (anchor: GithubAnchor) =>
  `fleet-triage:v1:${anchor.repo}:${anchor.issue}`;
export const triageMarker = (anchor: GithubAnchor) =>
  `<!-- ${triageSourceKey(anchor)} -->`;
export const triageDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface TriageSource {
  anchor: GithubAnchor;
  observedAt: string;
  title: string;
  body: string;
  state: string;
  labels: string[];
  assignees: string[];
  comments: { id: number; body: string; updatedAt: string }[];
  openFixPr: boolean;
  owned: boolean;
  parked: boolean;
  enabled: boolean;
}

export function triageEligible(source: TriageSource): boolean {
  return (
    source.enabled &&
    source.state === 'open' &&
    source.labels.some((label) => label === 'bug' || label === 'type:bug') &&
    source.assignees.length === 0 &&
    !source.openFixPr &&
    !source.owned &&
    !source.parked &&
    !source.labels.some((label) => /^(agent|review):/u.test(label))
  );
}

/** Non-triggering metadata labels are deliberately absent. Only an exact
 * recorded comment is owned output: a human edit becomes source input. */
export function triageFingerprint(
  source: TriageSource,
  owned?: TriagePublication,
): string {
  return triageDigest({
    title: source.title,
    body: source.body,
    state: source.state,
    labels: source.labels
      .filter(
        (label) =>
          label === 'bug' ||
          label === 'type:bug' ||
          /^(agent|review):/u.test(label),
      )
      .sort(),
    assignees: [...source.assignees].sort(),
    openFixPr: source.openFixPr,
    owned: source.owned,
    parked: source.parked,
    enabled: source.enabled,
    comments: source.comments
      .flatMap((comment) =>
        comment.id === owned?.commentId && comment.body === owned.commentBody
          ? owned.sourceComment === undefined
            ? []
            : [owned.sourceComment]
          : [comment],
      )
      .sort((a, b) => a.id - b.id),
  });
}

interface ReferencesPage {
  repository: {
    issue: {
      timelineItems: {
        nodes: ({
          source?: {
            __typename: string;
            state?: string;
            closingIssuesReferences?: {
              nodes: {
                number: number;
                repository: { nameWithOwner: string };
              }[];
              pageInfo: { hasNextPage: boolean };
            };
          };
        } | null)[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  } | null;
}

async function hasOpenFixPr(anchor: GithubAnchor): Promise<boolean> {
  const [owner = '', name = ''] = anchor.repo.split('/');
  const github = getGithubClient();
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const response: ReferencesPage = await github.graphql<ReferencesPage>(
      `
      query($owner:String!,$name:String!,$number:Int!,$after:String) {
        repository(owner:$owner,name:$name) { issue(number:$number) {
          timelineItems(itemTypes:[CROSS_REFERENCED_EVENT],first:100,after:$after) {
            nodes { ... on CrossReferencedEvent { source { __typename
              ... on PullRequest { state closingIssuesReferences(first:100) {
                nodes { number repository { nameWithOwner } } pageInfo { hasNextPage }
              } }
            } } }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }`,
      { owner, name, number: anchor.issue, after },
    );
    const timeline = response.repository?.issue?.timelineItems;
    if (timeline === undefined)
      throw new Error('Triage issue references unavailable');
    for (const node of timeline.nodes) {
      const pr = node?.source;
      if (pr?.__typename !== 'PullRequest' || pr.state !== 'OPEN') continue;
      if (
        pr.closingIssuesReferences?.pageInfo.hasNextPage ||
        pr.closingIssuesReferences?.nodes.some(
          (issue) =>
            issue.number === anchor.issue &&
            issue.repository.nameWithOwner === anchor.repo,
        )
      )
        return true;
    }
    if (!timeline.pageInfo.hasNextPage) return false;
    after = timeline.pageInfo.endCursor;
  }
  throw new Error('Triage issue references exceed the bounded read');
}

/** Fresh read starts the observation watermark. A slower older read cannot
 * replace a newer decision even if its webhook was delivered later. */
export async function loadTriageSource(
  store: OrchestratorStore,
  anchor: GithubAnchor,
): Promise<TriageSource> {
  const observedAt = new Date().toISOString();
  const [owner = '', repo = ''] = anchor.repo.split('/');
  const github = getGithubClient();
  const [issue, ownership, openFixPr] = await Promise.all([
    github.issues.get({ owner, repo, issue_number: anchor.issue }),
    readAnchorOwner(
      {
        runtime: { store },
        now: () => new Date(),
        sessionsFor: sessionsForRuns,
        cliSessions: (repository) => getCliSessions({ repo: repository }),
      },
      anchor,
    ),
    hasOpenFixPr(anchor),
  ]);
  if (!ownership.complete) throw new Error('Triage ownership read incomplete');
  const comments: TriageSource['comments'] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await github.issues.listComments({
      owner,
      repo,
      issue_number: anchor.issue,
      per_page: 100,
      page,
    });
    comments.push(
      ...batch.data.map((comment) => ({
        id: comment.id,
        body: comment.body ?? '',
        updatedAt: comment.updated_at,
      })),
    );
    if (batch.data.length < 100) break;
    if (page === 5) throw new Error('Triage comments exceed the bounded read');
  }
  return {
    anchor,
    observedAt,
    title: issue.data.title,
    body: issue.data.body ?? '',
    state:
      issue.data.pull_request === undefined ? issue.data.state : 'pull-request',
    labels: issue.data.labels.map((label) =>
      typeof label === 'string' ? label : (label.name ?? ''),
    ),
    assignees: (issue.data.assignees ?? []).map((assignee) => assignee.login),
    comments,
    openFixPr,
    owned: ownership.verdict !== 'none',
    parked: ownership.task?.state === 'parked',
    enabled: getWatchedRepos().some(
      (item) =>
        `${item.owner}/${item.name}` === anchor.repo && item.agents !== false,
    ),
  };
}
