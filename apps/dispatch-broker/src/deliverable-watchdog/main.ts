import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  createGitHubApi,
  mapWithConcurrency,
  repositoryPath,
  splitRepository,
} from '../github-api.js';
import {
  type DeliverableCheckRun,
  type DeliverablePullRequest,
  evaluateDeliverable,
  normalizeGraphqlBotLogin,
  parseAgentBotLogins,
  renderAttentionComment,
  renderRecoveredComment,
  WATCHDOG_ATTENTION_STATE,
  watchdogMarker,
} from './detect.js';

type GitHubApiClient = ReturnType<typeof createGitHubApi>;

const DEFAULT_REQUIRED_CHECK = 'Verify';
const DEFAULT_STALE_HOURS = 6;
const MAX_PAGES = 10;
const SCAN_CONCURRENCY = 3;
const GITHUB_ACTIONS_LOGIN = 'github-actions[bot]';

const OPEN_PULL_REQUESTS_QUERY = `
  query DeliverableWatchdog($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 50, after: $after, states: OPEN, orderBy: {field: UPDATED_AT, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          url
          createdAt
          isDraft
          headRefOid
          author { login }
          commits(last: 1) { nodes { commit { committedDate } } }
          closingIssuesReferences(first: 20) {
            totalCount
            nodes { number state }
          }
        }
      }
    }
  }
`;

interface GraphqlPullRequestNode {
  number: number;
  url: string;
  createdAt: string;
  isDraft: boolean;
  headRefOid: string;
  author?: { login?: string } | null;
  commits?: { nodes?: { commit?: { committedDate?: string } }[] };
  closingIssuesReferences?: {
    totalCount?: number;
    nodes?: { number: number; state: string }[];
  };
}

interface GraphqlPullRequestConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: GraphqlPullRequestNode[];
}

interface GraphqlPullRequestResponse {
  data?: {
    repository?: {
      pullRequests?: GraphqlPullRequestConnection;
    } | null;
  };
  errors?: { message?: string }[];
}

interface CheckRunsResponse {
  check_runs?: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
    html_url: string;
  }[];
}

interface IssueComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
}

interface IssueDetail {
  labels?: (string | { name?: string })[];
  assignees?: { login?: string }[];
}

export interface DeliverableWatchdogResult {
  scanned: number;
  agentPullRequests: number;
  needsAttention: number;
  recovered: number;
  failed: { pr: number; anchor?: number; message: string }[];
}

function env(name: string, required = true): string {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? '';
}

async function output(name: string, value: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  await fs.appendFile(outputPath, `${name}=${value}\n`, 'utf8');
}

function parseStaleHours(raw: string): number {
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error('STALE_HOURS must be greater than 0 and at most 168');
  }
  return hours;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listOpenPullRequests(
  api: GitHubApiClient,
  repository: string,
): Promise<DeliverablePullRequest[]> {
  const { owner, repo: name } = splitRepository(repository);
  const pullRequests: DeliverablePullRequest[] = [];
  let after: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response: GraphqlPullRequestResponse =
      await api.requestOk<GraphqlPullRequestResponse>('/graphql', {
        method: 'POST',
        body: {
          query: OPEN_PULL_REQUESTS_QUERY,
          variables: { owner, name, after },
        },
      });
    if (response.errors?.length) {
      throw new Error(
        `GitHub GraphQL pull-request listing failed: ${response.errors.map((error) => error.message ?? 'unknown error').join('; ')}`,
      );
    }
    const connection: GraphqlPullRequestConnection | undefined =
      response.data?.repository?.pullRequests;
    if (!connection)
      throw new Error('GitHub GraphQL response omitted pullRequests');
    for (const node of connection.nodes ?? []) {
      const closing = node.closingIssuesReferences;
      if ((closing?.totalCount ?? 0) > (closing?.nodes?.length ?? 0)) {
        throw new Error(
          `PR #${node.number} has more than 20 closing issue references; refusing to silently omit anchors`,
        );
      }
      const headCommittedAt = node.commits?.nodes?.[0]?.commit?.committedDate;
      if (!headCommittedAt) {
        throw new Error(`PR #${node.number} omitted its head commit timestamp`);
      }
      const anchors = (closing?.nodes ?? [])
        .filter((issue) => issue.state === 'OPEN')
        .map((issue) => issue.number);
      pullRequests.push({
        number: node.number,
        url: node.url,
        authorLogin: normalizeGraphqlBotLogin(node.author?.login ?? ''),
        createdAt: node.createdAt,
        headCommittedAt,
        headSha: node.headRefOid,
        isDraft: node.isDraft,
        anchors: anchors.length > 0 ? anchors : [node.number],
      });
    }
    if (!connection.pageInfo?.hasNextPage) return pullRequests;
    after = connection.pageInfo.endCursor ?? null;
    if (!after) throw new Error('GitHub GraphQL pagination omitted endCursor');
  }
  throw new Error('GitHub pull-request pagination exceeded safety bound');
}

async function listCheckRuns(
  api: GitHubApiClient,
  root: string,
  headSha: string,
): Promise<DeliverableCheckRun[]> {
  const checks: DeliverableCheckRun[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await api.requestOk<CheckRunsResponse>(
      `${root}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
    );
    const pageChecks = response.check_runs ?? [];
    checks.push(
      ...pageChecks.map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        startedAt: check.started_at,
        completedAt: check.completed_at,
        url: check.html_url,
      })),
    );
    if (pageChecks.length < 100) return checks;
  }
  throw new Error('GitHub check-run pagination exceeded safety bound');
}

async function listComments(
  api: GitHubApiClient,
  root: string,
  issue: number,
): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pageComments = await api.requestOk<IssueComment[]>(
      `${root}/issues/${issue}/comments?per_page=100&page=${page}`,
    );
    comments.push(...pageComments);
    if (pageComments.length < 100) return comments;
  }
  throw new Error(`Comment pagination for #${issue} exceeded safety bound`);
}

function findWatchdogComment(
  comments: IssueComment[],
  prNumber: number,
): IssueComment | undefined {
  const marker = watchdogMarker(prNumber);
  const matches = comments
    .filter(
      (comment) =>
        comment.user?.login === GITHUB_ACTIONS_LOGIN &&
        (comment.body ?? '').includes(marker),
    )
    .sort((left, right) => left.id - right.id);
  if (matches.length > 1) {
    console.log(
      `::warning::Found ${matches.length} watchdog comments for PR #${prNumber}; updating the oldest (#${matches[0].id}).`,
    );
  }
  return matches[0];
}

function hasLabel(issue: IssueDetail, label: string): boolean {
  return (issue.labels ?? []).some((candidate) =>
    typeof candidate === 'string'
      ? candidate === label
      : candidate.name === label,
  );
}

function hasAssignee(issue: IssueDetail, login: string): boolean {
  return (issue.assignees ?? []).some((assignee) => assignee.login === login);
}

async function ensureAttention(
  api: GitHubApiClient,
  root: string,
  anchor: number,
  pullRequest: DeliverablePullRequest,
  commentBody: string,
  maintainer: string,
): Promise<void> {
  const [comments, issue] = await Promise.all([
    listComments(api, root, anchor),
    api.requestOk<IssueDetail>(`${root}/issues/${anchor}`),
  ]);
  const comment = findWatchdogComment(comments, pullRequest.number);
  if (!comment) {
    await api.requestOk(`${root}/issues/${anchor}/comments`, {
      method: 'POST',
      body: { body: commentBody },
    });
  } else if (!(comment.body ?? '').includes(WATCHDOG_ATTENTION_STATE)) {
    await api.requestOk(`${root}/issues/comments/${comment.id}`, {
      method: 'PATCH',
      body: { body: commentBody },
    });
  }
  if (!hasLabel(issue, 'status:needs-human')) {
    await api.requestOk(`${root}/issues/${anchor}/labels`, {
      method: 'POST',
      body: { labels: ['status:needs-human'] },
    });
  }
  if (!hasAssignee(issue, maintainer)) {
    await api.requestOk(`${root}/issues/${anchor}/assignees`, {
      method: 'POST',
      body: { assignees: [maintainer] },
    });
  }
}

async function recoverAttention(
  api: GitHubApiClient,
  root: string,
  anchor: number,
  pullRequest: DeliverablePullRequest,
  commentBody: string,
): Promise<boolean> {
  const comment = findWatchdogComment(
    await listComments(api, root, anchor),
    pullRequest.number,
  );
  if (!comment || !(comment.body ?? '').includes(WATCHDOG_ATTENTION_STATE)) {
    return false;
  }
  await api.requestOk(`${root}/issues/comments/${comment.id}`, {
    method: 'PATCH',
    body: { body: commentBody },
  });
  return true;
}

export async function scanDeliverables({
  api,
  repository,
  agentBotLogins,
  maintainer,
  requiredCheck = DEFAULT_REQUIRED_CHECK,
  staleHours = DEFAULT_STALE_HOURS,
  now = new Date(),
}: {
  api: GitHubApiClient;
  repository: string;
  agentBotLogins: Set<string>;
  maintainer: string;
  requiredCheck?: string;
  staleHours?: number;
  now?: Date;
}): Promise<DeliverableWatchdogResult> {
  if (!maintainer) throw new Error('maintainer is required');
  if (!requiredCheck) throw new Error('requiredCheck is required');
  if (!Number.isFinite(staleHours) || staleHours <= 0 || staleHours > 168) {
    throw new Error('staleHours must be greater than 0 and at most 168');
  }
  const root = repositoryPath({ repository });
  const allPullRequests = await listOpenPullRequests(api, repository);
  const agentPullRequests = allPullRequests.filter((pullRequest) =>
    agentBotLogins.has(pullRequest.authorLogin),
  );
  const result: DeliverableWatchdogResult = {
    scanned: allPullRequests.length,
    agentPullRequests: agentPullRequests.length,
    needsAttention: 0,
    recovered: 0,
    failed: [],
  };
  const outcomes = await mapWithConcurrency(
    agentPullRequests,
    SCAN_CONCURRENCY,
    async (pullRequest) => {
      const checks = await listCheckRuns(api, root, pullRequest.headSha);
      const evaluation = evaluateDeliverable(
        pullRequest,
        checks,
        requiredCheck,
        staleHours * 60 * 60 * 1000,
        now,
      );
      if (evaluation.needsAttention) result.needsAttention += 1;
      for (const anchor of pullRequest.anchors) {
        try {
          if (evaluation.needsAttention) {
            await ensureAttention(
              api,
              root,
              anchor,
              pullRequest,
              renderAttentionComment(pullRequest, evaluation, requiredCheck),
              maintainer,
            );
          } else if (
            await recoverAttention(
              api,
              root,
              anchor,
              pullRequest,
              renderRecoveredComment(pullRequest, evaluation),
            )
          ) {
            result.recovered += 1;
          }
        } catch (error) {
          result.failed.push({
            pr: pullRequest.number,
            anchor,
            message: errorMessage(error),
          });
        }
      }
    },
  );
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      result.failed.push({
        pr: agentPullRequests[index].number,
        message: errorMessage(outcome.reason),
      });
    }
  });
  return result;
}

async function run(): Promise<void> {
  const staleHours = parseStaleHours(
    env('STALE_HOURS', false) || String(DEFAULT_STALE_HOURS),
  );
  const result = await scanDeliverables({
    api: createGitHubApi({ token: env('GITHUB_TOKEN') }),
    repository: env('GITHUB_REPOSITORY'),
    agentBotLogins: parseAgentBotLogins(env('AGENT_BOT_LOGINS')),
    maintainer: env('MAINTAINER_LOGIN'),
    requiredCheck: env('REQUIRED_CHECK', false) || DEFAULT_REQUIRED_CHECK,
    staleHours,
  });
  console.log(
    `deliverable-watchdog: scanned ${result.scanned} open PR(s), ${result.agentPullRequests} agent-authored, ${result.needsAttention} need attention, ${result.recovered} resumed, ${result.failed.length} failed operation(s).`,
  );
  await output('scanned', String(result.scanned));
  await output('needs-attention', String(result.needsAttention));
  await output('recovered', String(result.recovered));
  if (result.failed.length > 0) {
    throw new Error(
      `Deliverable watchdog failed: ${result.failed.map((failure) => `PR #${failure.pr}${failure.anchor ? ` anchor #${failure.anchor}` : ''}: ${failure.message}`).join(' | ')}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await run();
}
