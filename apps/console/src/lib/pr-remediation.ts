import 'server-only';

import { createHash } from 'node:crypto';

import {
  AGENT_BOT_LOGINS,
  AGENT_LABELS,
  type AgentPipeline,
  isDispatchPipeline,
  parseRunGeneration,
  REVIEW_LABELS,
} from '@agent-lcars/dispatch-contracts';
import { logger } from '@agent-lcars/logging';
import {
  type GithubAnchor,
  type GithubAnchorProjection,
  isLive,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
  type VersionedTask,
} from '@agent-lcars/orchestrator';
import { workPayloadSchema } from '@agent-lcars/work';
import { z } from 'zod';

import { isAdminGithubLogin, isControlPlaneRepository } from './deployment';
import type { DispatchTokenProvider } from './github-app-tokens';
import {
  admitGithubWork,
  type GithubWorkAdmissionOutcome,
} from './github-work-admission';
import {
  graphqlActorSchema,
  normalizeGraphqlActorLogin,
} from './graphql-actor';
import {
  type DrainOutboxResult,
  wakeDeliveryMonitor,
} from './orchestrator-dispatch';
import {
  PR_REMEDIATION_STALL_AFTER_MS,
  prRemediationErrorReason,
  PrRemediationGraphqlError,
  type PrRemediationTrigger,
  recordPrRemediationCensus,
  recordPrRemediationOutcome,
} from './pr-remediation-observability';
import {
  detectPullRequestAuthorPipeline,
  isAutomatedReviewExcludedAuthor,
  isVerifiedDependencyUpdate,
  parseAttemptClaimRunId,
  selectCrossModelReviewer,
  selectPullRequestRemediation,
} from './pr-review-routing';
import {
  hasCrossRepoOption,
  repoKey,
  supportedAgentPipelines,
} from './watched-repo';
import { getWatchedRepos } from './watched-repos-config';
import { workPayloadFromGithub } from './work-from-github';

/** Maximum consecutive automatic PR remediation rounds without a human reply or
 * manual operator intervention, preventing pathological ping-pong loops. */
export const MAX_AUTO_PR_REMEDIATION_ROUNDS = 4;

const PR_REMEDIATION_REQUEST_PREFIX = 'pr-remediation:';
const PR_REREVIEW_REQUEST_PREFIX = 'pr-rereview:';

const sha = z.string().regex(/^[a-f0-9]{40}$/u);

export interface PrRemediationDeps {
  store: OrchestratorStore;
  orchestrator: Orchestrator;
  drain: (limit?: number) => Promise<DrainOutboxResult>;
  tokens: DispatchTokenProvider;
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
  now?: () => string;
  sleepMs?: (ms: number) => Promise<void>;
}

export type PrRemediationResult =
  | { action: 'ignored'; reason: string }
  | { action: 'remediated'; outcome: GithubWorkAdmissionOutcome }
  | { action: 'rereviewed'; outcome: GithubWorkAdmissionOutcome }
  | { action: 'approved-dependency-update'; head: string };

const pullRequestSnapshotSchema = z.object({
  state: z.string(),
  isDraft: z.boolean(),
  mergedAt: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  headRefOid: sha,
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
  closingIssuesReferences: z
    .object({
      nodes: z.array(
        z
          .object({
            number: z.number().int().positive(),
            repository: z.object({ nameWithOwner: z.string() }),
          })
          .nullable(),
      ),
    })
    .nullable()
    .optional(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  author: graphqlActorSchema.nullable(),
  labels: z.object({
    nodes: z.array(z.object({ name: z.string() }).nullable()),
  }),
  assignees: z.object({
    nodes: z.array(z.object({ login: z.string() }).nullable()),
  }),
  reviews: z.object({
    pageInfo: z.object({ hasPreviousPage: z.boolean() }),
    nodes: z.array(
      z
        .object({
          databaseId: z.number().int().nullable().optional(),
          state: z.string(),
          body: z.string().nullable().optional(),
          authorAssociation: z.string().nullable().optional(),
          author: graphqlActorSchema.nullable(),
          commit: z.object({ oid: sha }).nullable(),
        })
        .nullable(),
    ),
  }),
  commits: z
    .object({
      totalCount: z.number().int(),
      nodes: z.array(
        z
          .object({
            commit: z.object({
              oid: sha,
              author: z
                .object({
                  user: z.object({ login: z.string() }).nullable(),
                })
                .nullable(),
              signature: z
                .object({
                  isValid: z.boolean(),
                  wasSignedByGitHub: z.boolean(),
                })
                .nullable(),
            }),
          })
          .nullable(),
      ),
    })
    .nullable()
    .optional(),
  reviewThreads: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(
      z
        .object({
          id: z.string(),
          isResolved: z.boolean(),
          comments: z.object({
            nodes: z.array(
              z
                .object({
                  authorAssociation: z.string().nullable().optional(),
                  author: graphqlActorSchema.nullable().optional(),
                })
                .nullable(),
            ),
          }),
        })
        .nullable(),
    ),
  }),
});

type PullRequestSnapshot = z.infer<typeof pullRequestSnapshotSchema>;

const TRUSTED_REMEDIATION_ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

const TRUSTED_REMEDIATION_BOTS = new Set([
  ...AGENT_BOT_LOGINS.map((login) => login.toLowerCase()),
  'chatgpt-codex-connector[bot]',
  'gemini-code-assist[bot]',
  'copilot-pull-request-reviewer[bot]',
  'github-actions[bot]',
]);

function isTrustedRemediationReviewer(
  login: string | undefined,
  association: string | null | undefined,
): boolean {
  if (
    login !== undefined &&
    TRUSTED_REMEDIATION_BOTS.has(login.toLowerCase())
  ) {
    return true;
  }
  return (
    association !== undefined &&
    association !== null &&
    TRUSTED_REMEDIATION_ASSOCIATIONS.has(association)
  );
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function hasReviewLineMarker(
  body: string | null | undefined,
  marker: string,
): boolean {
  if (!body) return false;
  return body.split('\n').some((line) => line.replace(/\r$/u, '') === marker);
}

async function applyNeedsHumanLabel(
  deps: PrRemediationDeps,
  anchor: GithubAnchor,
): Promise<void> {
  try {
    const token = await deps.tokens.tokenFor(anchor.repo);
    const response = await (deps.fetchImpl ?? fetch)(
      `${deps.githubApiBaseUrl ?? 'https://api.github.com'}/repos/${anchor.repo}/issues/${anchor.issue}/labels`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ labels: ['status:needs-human'] }),
      },
    );
    if (!response.ok) {
      logger.warn(
        'agent-lcars: failed to apply status:needs-human on %s#%s (%s)',
        anchor.repo,
        anchor.issue,
        response.status,
      );
    }
  } catch (error) {
    logger.warn(
      'agent-lcars: error applying status:needs-human on %s#%s:',
      anchor.repo,
      anchor.issue,
      error,
    );
  }
}

/** LCARS reviewing as itself: an ordinary approving review on the head.
 *  Returns the review's id so a caller can withdraw it. */
async function approveDependencyUpdate(
  deps: PrRemediationDeps,
  anchor: GithubAnchor,
  head: string,
  bot: string,
): Promise<number> {
  const token = await deps.tokens.tokenFor(anchor.repo);
  const response = await (deps.fetchImpl ?? fetch)(
    `${deps.githubApiBaseUrl ?? 'https://api.github.com'}/repos/${anchor.repo}/pulls/${anchor.issue}/reviews`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        commit_id: head,
        event: 'APPROVE',
        body: `Automated dependency update. Every commit on this pull request is authored by ${bot} and signed by GitHub, so LCARS approves it without a review run; CI gates the merge.`,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `approving dependency update ${anchor.repo}#${anchor.issue} failed (${response.status})`,
    );
  }
  return z.object({ id: z.number().int() }).parse(await response.json()).id;
}

async function dismissReview(
  deps: PrRemediationDeps,
  anchor: GithubAnchor,
  reviewId: number,
  message: string,
): Promise<void> {
  const token = await deps.tokens.tokenFor(anchor.repo);
  const response = await (deps.fetchImpl ?? fetch)(
    `${deps.githubApiBaseUrl ?? 'https://api.github.com'}/repos/${anchor.repo}/pulls/${anchor.issue}/reviews/${reviewId}/dismissals`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ message, event: 'DISMISS' }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `dismissing review ${reviewId} on ${anchor.repo}#${anchor.issue} failed (${response.status})`,
    );
  }
}

async function graphql<T>(
  deps: PrRemediationDeps,
  repo: string,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const token = await deps.tokens.tokenFor(repo);
  const response = await (deps.fetchImpl ?? fetch)(
    `${deps.githubApiBaseUrl ?? 'https://api.github.com'}/graphql`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ query, variables }),
    },
  );
  if (!response.ok) {
    throw new Error(`PR remediation GraphQL read failed (${response.status})`);
  }
  // GitHub answers rate limits and query errors with HTTP 200, an `errors`
  // array and no `data`; report those before validating `data`.
  const envelope = z
    .object({
      errors: z
        .array(z.object({ type: z.string().max(64).optional() }).loose())
        .optional(),
      data: z.unknown().optional(),
    })
    .parse(await response.json());
  if (envelope.errors?.length) {
    throw new PrRemediationGraphqlError([
      ...new Set(
        envelope.errors.slice(0, 10).map((error) => error.type ?? 'unknown'),
      ),
    ]);
  }
  return schema.parse(envelope.data);
}

const PR_SNAPSHOT_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        state
        isDraft
        mergedAt
        title
        body
        baseRefName
        headRefName
        headRefOid
        headRepository { nameWithOwner }
        closingIssuesReferences(first: 10) {
          nodes { number repository { nameWithOwner } }
        }
        mergeable
        mergeStateStatus
        author { __typename login }
        labels(first: 100) { nodes { name } }
        assignees(first: 20) { nodes { login } }
        reviews(last: 100) {
          pageInfo { hasPreviousPage }
          nodes { databaseId state body authorAssociation author { __typename login } commit { oid } }
        }
        commits(first: 100) {
          totalCount
          nodes { commit { oid author { user { login } } signature { isValid wasSignedByGitHub } } }
        }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes { authorAssociation author { __typename login } }
            }
          }
        }
      }
    }
  }
`;

async function linkedIssueRunIsLive(
  deps: PrRemediationDeps,
  anchor: GithubAnchor,
  snapshot: PullRequestSnapshot,
): Promise<boolean> {
  const issues = (snapshot.closingIssuesReferences?.nodes ?? []).flatMap(
    (node) =>
      node !== null &&
      node.number !== anchor.issue &&
      node.repository.nameWithOwner.toLowerCase() === anchor.repo.toLowerCase()
        ? [node.number]
        : [],
  );
  const runs = await Promise.all(
    issues.map((issue) =>
      deps.store.readActiveRun({ repo: anchor.repo, issue }),
    ),
  );
  return runs.some((run) => run !== undefined && isLive(run.state));
}

async function readPullRequestSnapshot(
  deps: PrRemediationDeps,
  anchor: GithubAnchor,
): Promise<PullRequestSnapshot | null> {
  const [owner, name] = anchor.repo.split('/');
  const data = await graphql(
    deps,
    anchor.repo,
    PR_SNAPSHOT_QUERY,
    { owner, name, number: anchor.issue },
    z.object({
      repository: z
        .object({ pullRequest: pullRequestSnapshotSchema.nullable() })
        .nullable(),
    }),
  );
  return data.repository?.pullRequest ?? null;
}

function evaluateCurrentHeadReviews(snapshot: PullRequestSnapshot): {
  blockingReviewKeys: string[];
  hasCurrentHeadLcarsReview: boolean;
} {
  const head = snapshot.headRefOid;
  const latestByAuthor = new Map<
    string,
    { verdict: 'blocked' | 'clear'; key: string }
  >();
  let hasCurrentHeadLcarsReview = false;

  for (const review of snapshot.reviews.nodes) {
    if (review === null || review.author === null || review.commit === null) {
      continue;
    }
    if (review.commit.oid !== head) continue;
    const login = normalizeGraphqlActorLogin(review.author);
    if (
      !login ||
      !isTrustedRemediationReviewer(login, review.authorAssociation)
    ) {
      continue;
    }
    const authorKey = login.toLowerCase();
    const isLcarsBot = authorKey === 'agent-lcars[bot]';
    const key =
      review.databaseId !== null && review.databaseId !== undefined
        ? `${login}:${review.databaseId}`
        : `${login}:${review.state}`;

    if (isLcarsBot) {
      if (
        review.state === 'APPROVED' ||
        review.state === 'CHANGES_REQUESTED' ||
        (review.state === 'COMMENTED' &&
          (hasReviewLineMarker(review.body, '<!-- lcars-review:pass -->') ||
            hasReviewLineMarker(review.body, '<!-- lcars-review:block -->')))
      ) {
        hasCurrentHeadLcarsReview = true;
      }
    }

    if (review.state === 'CHANGES_REQUESTED') {
      latestByAuthor.set(authorKey, { verdict: 'blocked', key });
    } else if (review.state === 'APPROVED' || review.state === 'DISMISSED') {
      latestByAuthor.set(authorKey, { verdict: 'clear', key });
    } else if (review.state === 'COMMENTED' && isLcarsBot) {
      if (hasReviewLineMarker(review.body, '<!-- lcars-review:block -->')) {
        latestByAuthor.set(authorKey, { verdict: 'blocked', key });
      } else if (
        hasReviewLineMarker(review.body, '<!-- lcars-review:pass -->')
      ) {
        latestByAuthor.set(authorKey, { verdict: 'clear', key });
      }
    }
  }

  const blockingReviewKeys = [...latestByAuthor.values()]
    .filter((entry) => entry.verdict === 'blocked')
    .map((entry) => entry.key)
    .sort();

  return { blockingReviewKeys, hasCurrentHeadLcarsReview };
}

async function resolveAuthorPipeline(
  store: OrchestratorStore,
  existingTask: VersionedTask | undefined,
  runs: readonly Run[],
  snapshot: PullRequestSnapshot,
  labels: readonly string[],
): Promise<AgentPipeline | undefined> {
  const routed =
    existingTask?.task.providerRouting?.acceptedGeneration?.pipeline;
  if (routed !== undefined && isDispatchPipeline(routed)) {
    return routed;
  }
  const claimRunId = parseAttemptClaimRunId(snapshot.body);
  if (claimRunId !== undefined) {
    const claimedRun = await store.readRun(claimRunId);
    if (claimedRun !== undefined && isDispatchPipeline(claimedRun.pipeline)) {
      return claimedRun.pipeline;
    }
  }
  const pickNewestImplementRun = (
    candidates: readonly Run[],
  ): Run | undefined => {
    let newest: Run | undefined;
    for (const run of candidates) {
      if (run.params?.['mode'] !== 'implement') continue;
      if (
        newest === undefined ||
        (parseRunGeneration(run.runId) ?? 0) >
          (parseRunGeneration(newest.runId) ?? 0)
      ) {
        newest = run;
      }
    }
    return newest;
  };
  const newestImplementRun =
    pickNewestImplementRun(
      runs.filter((run) => run.requestSource !== 'provider-fallback'),
    ) ?? pickNewestImplementRun(runs);
  return detectPullRequestAuthorPipeline({
    authorPipelineFromStore:
      newestImplementRun !== undefined &&
      isDispatchPipeline(newestImplementRun.pipeline)
        ? newestImplementRun.pipeline
        : undefined,
    labels: labels.map((name) => ({ name })),
    userLogin: normalizeGraphqlActorLogin(snapshot.author),
    body: snapshot.body,
    headRef: snapshot.headRefName,
  });
}

function newestNonReviewRunIsParked(runs: readonly Run[]): boolean {
  let newest: Run | undefined;
  for (const run of runs) {
    if (run.params?.['mode'] === 'review') continue;
    if (
      newest === undefined ||
      (parseRunGeneration(run.runId) ?? 0) >
        (parseRunGeneration(newest.runId) ?? 0)
    ) {
      newest = run;
    }
  }
  return newest?.result?.summary === 'park';
}

/** Counts consecutive distinct automatic PR remediation rounds since the last
 * human/operator request, ignoring fallback/retry attempts within one round. */
function countConsecutiveAutoRemediations(runs: readonly Run[]): number {
  const sorted = [...runs].sort(
    (left, right) =>
      (parseRunGeneration(right.runId) ?? 0) -
      (parseRunGeneration(left.runId) ?? 0),
  );
  const distinctRounds = new Set<string>();
  for (const run of sorted) {
    if (run.params?.['mode'] === 'review') continue;
    if (
      run.params?.['mode'] === 'reply' ||
      (run.requestSource === 'caller' &&
        !run.requestId.startsWith(PR_REMEDIATION_REQUEST_PREFIX))
    ) {
      break;
    }
    if (run.requestId.startsWith(PR_REMEDIATION_REQUEST_PREFIX)) {
      distinctRounds.add(run.requestId);
    } else if (run.providerFallback?.originalRunId !== undefined) {
      const origin = runs.find(
        (candidate) => candidate.runId === run.providerFallback?.originalRunId,
      );
      if (origin?.requestId.startsWith(PR_REMEDIATION_REQUEST_PREFIX)) {
        distinctRounds.add(origin.requestId);
      }
    }
  }
  return distinctRounds.size;
}

function buildRemediationContext(input: {
  repo: string;
  number: number;
  headSha: string;
  baseRefName: string;
  headRefName: string;
  hasMergeConflict: boolean;
  unresolvedThreadCount: number;
  blockingReviewCount: number;
}): string {
  const reasons: string[] = [];
  if (input.hasMergeConflict) {
    reasons.push(`merge conflicts with ${input.baseRefName}`);
  }
  if (input.unresolvedThreadCount > 0) {
    reasons.push(
      `${input.unresolvedThreadCount} unresolved review thread${input.unresolvedThreadCount === 1 ? '' : 's'}`,
    );
  }
  if (input.blockingReviewCount > 0) {
    reasons.push('blocking code review feedback');
  }
  return (
    `Remediate pull request https://github.com/${input.repo}/pull/${input.number} ` +
    `at ${input.headSha} (${reasons.join('; ')}). ` +
    `Fetch origin/${input.baseRefName}, resolve any merge conflicts cleanly on ${input.headRefName}, ` +
    `address every actionable review comment and thread, push to ${input.headRefName}, ` +
    `resolve addressed review threads via GraphQL resolveReviewThread, and post or update a ` +
    `deliverable carrying your exact <!-- attempt-claim:$ATTEMPT_ID --> marker.`
  );
}

/**
 * Inspects one open GitHub pull request and automatically dispatches:
 * 1. An `implement` remediation run (with cross-provider quota fallback) when
 *    the PR has merge conflicts, unresolved review threads, or a current-head
 *    blocking review — without looping the human maintainer into the Inbox.
 * 2. A post-remediation cross-model `review` run when an `implement` or `reply`
 *    run just settled on the PR anchor and pushed a new commit while holding
 *    the PR task lock (which caused `pull_request: synchronize` to refuse
 *    `task-busy`).
 */
export async function reconcilePullRequestRemediation(
  deps: PrRemediationDeps,
  anchor: GithubAnchor,
  options?: PrRemediationOptions,
): Promise<PrRemediationResult> {
  const trigger: PrRemediationTrigger =
    options?.trigger ??
    (options?.afterRun === undefined ? 'webhook' : 'run-settled');
  let result: PrRemediationResult;
  try {
    result = await reconcilePullRequestRemediationOnce(deps, anchor, options);
  } catch (error) {
    recordPrRemediationOutcome({
      trigger,
      outcome: 'error',
      reason: prRemediationErrorReason(error),
      repo: anchor.repo,
      number: anchor.issue,
      ...(error instanceof PrRemediationGraphqlError
        ? { graphqlErrorTypes: error.types }
        : {}),
    });
    throw error;
  }
  // Out-of-scope repositories are not remediation checks.
  if (result.action !== 'ignored' || result.reason !== 'wrong-repo') {
    recordPrRemediationOutcome({
      trigger,
      outcome:
        result.action === 'ignored'
          ? 'skipped'
          : result.action === 'approved-dependency-update'
            ? 'approved'
            : result.action,
      reason:
        result.action === 'ignored'
          ? result.reason
          : result.action === 'approved-dependency-update'
            ? 'dependency-update'
            : result.outcome.kind,
      repo: anchor.repo,
      number: anchor.issue,
    });
  }
  return result;
}

interface PrRemediationOptions {
  afterRun?: Run;
  waitForMergeability?: boolean;
  wakeDelivery?: boolean;
  trigger?: PrRemediationTrigger;
}

async function reconcilePullRequestRemediationOnce(
  deps: PrRemediationDeps,
  anchor: GithubAnchor,
  options?: PrRemediationOptions,
): Promise<PrRemediationResult> {
  if (!isControlPlaneRepository(anchor.repo)) {
    return { action: 'ignored', reason: 'wrong-repo' };
  }
  const watchedRepo = getWatchedRepos().find(
    (repo) => repoKey(repo) === anchor.repo,
  );
  if (watchedRepo === undefined || watchedRepo.agents === false) {
    return { action: 'ignored', reason: 'agents-disabled' };
  }
  if (options?.afterRun?.result?.summary === 'park') {
    return { action: 'ignored', reason: 'parked' };
  }

  const activeRun = await deps.store.readActiveRun(anchor);
  if (activeRun !== undefined && isLive(activeRun.state)) {
    return { action: 'ignored', reason: 'task-busy' };
  }

  const waitingDeliveries = await deps.store.readWaitingDeliveryTasks({
    repo: anchor.repo,
    number: anchor.issue,
  });
  if (waitingDeliveries.length > 0) {
    if (options?.wakeDelivery !== false) {
      const woken = await wakeDeliveryMonitor(deps, {
        repo: anchor.repo,
        number: anchor.issue,
      });
      if (woken.length > 0) {
        await deps.drain(Math.max(10, woken.length * 2));
      }
    }
    return { action: 'ignored', reason: 'delivery-owned' };
  }

  let snapshot = await readPullRequestSnapshot(deps, anchor);
  if (snapshot === null) {
    return { action: 'ignored', reason: 'not-pull-request' };
  }
  if (
    options?.waitForMergeability &&
    snapshot.state === 'OPEN' &&
    !snapshot.isDraft &&
    snapshot.mergeable === 'UNKNOWN'
  ) {
    const sleep = deps.sleepMs ?? defaultSleep;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await sleep(2_500);
      snapshot = await readPullRequestSnapshot(deps, anchor);
      if (snapshot === null || snapshot.mergeable !== 'UNKNOWN') break;
    }
    if (snapshot === null) {
      return { action: 'ignored', reason: 'not-pull-request' };
    }
  }

  if (snapshot.state !== 'OPEN' || snapshot.mergedAt !== null) {
    return { action: 'ignored', reason: 'anchor-closed' };
  }
  if (snapshot.isDraft) {
    return { action: 'ignored', reason: 'draft-pull-request' };
  }
  // Never execute privileged coding agents on untrusted fork branches.
  if (
    snapshot.headRepository?.nameWithOwner?.toLowerCase() !==
    anchor.repo.toLowerCase()
  ) {
    return { action: 'ignored', reason: 'fork-pull-request' };
  }

  // The orchestrator lock is per task, so the PR anchor does not contend with
  // the issue-anchored run that is still authoring this branch. Defer while
  // any linked source issue has a live run; its completion binds
  // Task.delivery, and the delivery monitor owns the PR from then on.
  if (await linkedIssueRunIsLive(deps, anchor, snapshot)) {
    return { action: 'ignored', reason: 'author-run-live' };
  }

  const author = normalizeGraphqlActorLogin(snapshot.author);
  if (
    author !== undefined &&
    isVerifiedDependencyUpdate({
      authorLogin: author,
      headRef: snapshot.headRefName,
      headOid: snapshot.headRefOid,
      commits:
        snapshot.commits == null
          ? undefined
          : {
              totalCount: snapshot.commits.totalCount,
              nodes: snapshot.commits.nodes.flatMap((node) =>
                node === null
                  ? []
                  : [
                      {
                        oid: node.commit.oid,
                        authorLogin: node.commit.author?.user?.login,
                        signedByGitHub:
                          node.commit.signature?.isValid === true &&
                          node.commit.signature.wasSignedByGitHub === true,
                      },
                    ],
              ),
            },
    }) &&
    !snapshot.reviews.pageInfo.hasPreviousPage &&
    !evaluateCurrentHeadReviews(snapshot).hasCurrentHeadLcarsReview
  ) {
    const head = snapshot.headRefOid;
    const reviewId = await approveDependencyUpdate(deps, anchor, head, author);
    // A push that lands while the approval is in flight is not dismissed by
    // GitHub: its stale-review rule runs at push time, before this review
    // existed. Read the head again and withdraw an approval it has outrun.
    const after = await readPullRequestSnapshot(deps, anchor);
    if (after === null || after.headRefOid !== head) {
      await dismissReview(
        deps,
        anchor,
        reviewId,
        'The pull request head moved while this approval was being submitted.',
      );
      return { action: 'ignored', reason: 'head-moved' };
    }
    return { action: 'approved-dependency-update', head };
  }
  if (!author || isAutomatedReviewExcludedAuthor(author)) {
    return { action: 'ignored', reason: 'excluded-author' };
  }
  const labels = snapshot.labels.nodes.flatMap((node) =>
    node === null ? [] : [node.name],
  );
  if (
    labels.includes('bot:renovate') ||
    labels.includes('status:needs-human') ||
    labels.includes('status:blocked')
  ) {
    return { action: 'ignored', reason: 'parked-or-excluded-label' };
  }

  const [existingTask, runs] = await Promise.all([
    deps.store.readTask(anchor),
    deps.store.listRuns(anchor),
  ]);
  if (newestNonReviewRunIsParked(runs)) {
    return { action: 'ignored', reason: 'parked' };
  }

  const trustedAuthor =
    AGENT_BOT_LOGINS.some(
      (bot) => bot.toLowerCase() === author.toLowerCase(),
    ) || isAdminGithubLogin(author);
  // Note: `claimGithubAnchor` attaches `agent-lcars-bot` on `mode: 'review'`
  // runs as well, so assignee presence alone does NOT authorize `implement` on
  // an untrusted author's PR. Require an explicit `agent:*` label or a prior
  // non-review run.
  const fleetClaimed =
    labels.some((name) => AGENT_LABELS.has(name)) ||
    runs.some(
      (run) =>
        run.params?.['mode'] === 'implement' ||
        run.params?.['mode'] === 'reply',
    );
  if (!trustedAuthor && !fleetClaimed) {
    return { action: 'ignored', reason: 'untrusted-author' };
  }

  if (
    snapshot.reviews.pageInfo.hasPreviousPage ||
    snapshot.reviewThreads.pageInfo.hasNextPage
  ) {
    logger.warn(
      'agent-lcars: skipping automatic PR remediation on %s#%s due to truncated review pagination',
      anchor.repo,
      anchor.issue,
    );
    // `BLOCKED` is the normal state while checks or approval are pending;
    // only a conflict proves this PR needs a human.
    if (
      snapshot.mergeable === 'CONFLICTING' ||
      snapshot.mergeStateStatus === 'DIRTY'
    ) {
      await applyNeedsHumanLabel(deps, anchor);
    }
    return { action: 'ignored', reason: 'truncated-reviews' };
  }

  const hasMergeConflict =
    snapshot.mergeable === 'CONFLICTING' ||
    snapshot.mergeStateStatus === 'DIRTY';
  const unresolvedThreadIds = snapshot.reviewThreads.nodes
    .flatMap((thread) => {
      if (thread === null || thread.isResolved) return [];
      const firstComment = thread.comments.nodes[0];
      if (
        firstComment === undefined ||
        firstComment === null ||
        !isTrustedRemediationReviewer(
          normalizeGraphqlActorLogin(firstComment.author),
          firstComment.authorAssociation,
        )
      ) {
        return [];
      }
      return [thread.id];
    })
    .sort();
  const { blockingReviewKeys, hasCurrentHeadLcarsReview } =
    evaluateCurrentHeadReviews(snapshot);

  const crossRepo: Record<string, string> = hasCrossRepoOption(labels)
    ? { crossRepo: 'true' }
    : {};
  const supportedPipelines = supportedAgentPipelines(watchedRepo);
  const authorPipeline = await resolveAuthorPipeline(
    deps.store,
    existingTask,
    runs,
    snapshot,
    labels,
  );
  const parsedExistingWork =
    existingTask !== undefined
      ? workPayloadSchema.safeParse(existingTask.task.work)
      : undefined;
  const buildAnchorWork = (pipeline: AgentPipeline) => {
    const derived = workPayloadFromGithub({
      title: snapshot.title,
      body: snapshot.body,
      pipeline,
      repo: anchor.repo,
      actor: author,
    });
    if (
      parsedExistingWork?.success === true &&
      parsedExistingWork.data.spec.priority !== undefined
    ) {
      return {
        ...derived,
        spec: {
          ...derived.spec,
          priority: parsedExistingWork.data.spec.priority,
        },
      };
    }
    return derived;
  };

  if (
    hasMergeConflict ||
    unresolvedThreadIds.length > 0 ||
    blockingReviewKeys.length > 0
  ) {
    if (
      countConsecutiveAutoRemediations(runs) >= MAX_AUTO_PR_REMEDIATION_ROUNDS
    ) {
      logger.warn(
        'agent-lcars: reached %s consecutive automatic PR remediation rounds on %s#%s; stopping automatic dispatch',
        MAX_AUTO_PR_REMEDIATION_ROUNDS,
        anchor.repo,
        anchor.issue,
      );
      await applyNeedsHumanLabel(deps, anchor);
      return { action: 'ignored', reason: 'remediation-cap-reached' };
    }

    const selection = selectPullRequestRemediation({
      authorPipeline,
      supportedPipelines,
    });
    const digest = sha256Hex(
      JSON.stringify({
        head: snapshot.headRefOid,
        conflict: hasMergeConflict,
        threads: unresolvedThreadIds,
        reviews: blockingReviewKeys,
      }),
    ).slice(0, 16);
    const requestId = `${PR_REMEDIATION_REQUEST_PREFIX}${anchor.issue}:${snapshot.headRefOid.slice(0, 12)}:${digest}`;
    const context = buildRemediationContext({
      repo: anchor.repo,
      number: anchor.issue,
      headSha: snapshot.headRefOid,
      baseRefName: snapshot.baseRefName,
      headRefName: snapshot.headRefName,
      hasMergeConflict,
      unresolvedThreadCount: unresolvedThreadIds.length,
      blockingReviewCount: blockingReviewKeys.length,
    });
    const outcome = await admitGithubWork(deps, {
      anchor,
      requestId,
      params: {
        mode: 'implement',
        context,
        ...crossRepo,
      },
      work: buildAnchorWork(selection.pipeline),
      workMirrorsAnchor: true,
      remediationFallback: true,
      fallbackPipelines: selection.fallbackPipelines,
    });
    return { action: 'remediated', outcome };
  }

  // If an implement or reply run on this PR anchor just finished cleanly, a
  // `synchronize` push during that run was refused as `task-busy`. Admit the
  // missing current-head review now that the PR lock is released.
  const settledMode = options?.afterRun?.params?.['mode'];
  if (
    options?.afterRun !== undefined &&
    options.afterRun.result?.ok === true &&
    options.afterRun.result.summary !== 'park' &&
    (settledMode === 'implement' || settledMode === 'reply') &&
    !hasCurrentHeadLcarsReview
  ) {
    const requestedPipeline = labels
      .map((name) => REVIEW_LABELS.get(name))
      .find((pipeline) => pipeline !== undefined);
    const selection = selectCrossModelReviewer({
      repo: anchor.repo,
      authorPipeline,
      requestedPipeline,
      supportedPipelines,
    });
    const requestId = `${PR_REREVIEW_REQUEST_PREFIX}${anchor.issue}:${snapshot.headRefOid.slice(0, 16)}`;
    const outcome = await admitGithubWork(deps, {
      anchor,
      requestId,
      params: {
        mode: 'review',
        ...crossRepo,
      },
      work: buildAnchorWork(selection.pipeline),
      workMirrorsAnchor: true,
      fallbackPipelines: selection.fallbackPipelines,
    });
    return { action: 'rereviewed', outcome };
  }

  return { action: 'ignored', reason: 'clean' };
}

const OPEN_BASE_PULLS_QUERY = `
  query($owner: String!, $name: String!, $baseRef: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, baseRefName: $baseRef, first: 50) {
        nodes {
          number
          isDraft
          mergeable
          mergeStateStatus
        }
      }
    }
  }
`;

const openBasePullsSchema = z.object({
  repository: z
    .object({
      pullRequests: z.object({
        nodes: z.array(
          z
            .object({
              number: z.number().int().positive(),
              isDraft: z.boolean(),
              mergeable: z.string(),
              mergeStateStatus: z.string(),
            })
            .nullable(),
        ),
      }),
    })
    .nullable(),
});

/**
 * Invoked when a pull request merges into `baseRef`. Checks open non-draft PRs
 * targeting that same base branch so any PR that just developed a merge
 * conflict gets an automatic remediation agent immediately instead of waiting
 * on a human.
 */
export async function reconcileMergedPullRequestConflicts(
  deps: PrRemediationDeps,
  input: { repo: string; baseRef: string; mergedNumber: number },
): Promise<void> {
  if (!isControlPlaneRepository(input.repo)) return;
  const watchedRepo = getWatchedRepos().find(
    (repo) => repoKey(repo) === input.repo,
  );
  if (watchedRepo === undefined || watchedRepo.agents === false) return;

  const [owner, name] = input.repo.split('/');
  const sleep = deps.sleepMs ?? defaultSleep;

  const loadCandidates = async () => {
    const data = await graphql(
      deps,
      input.repo,
      OPEN_BASE_PULLS_QUERY,
      { owner, name, baseRef: input.baseRef },
      openBasePullsSchema,
    );
    return (data.repository?.pullRequests.nodes ?? []).filter(
      (node): node is NonNullable<typeof node> =>
        node !== null && !node.isDraft && node.number !== input.mergedNumber,
    );
  };

  let candidates = await loadCandidates();
  if (candidates.some((pr) => pr.mergeable === 'UNKNOWN')) {
    await sleep(3_000);
    candidates = await loadCandidates();
    // Also re-wake delivery-bound PRs after GitHub recomputes mergeability.
    const woken = await wakeDeliveryMonitor(deps, { repo: input.repo });
    if (woken.length > 0) {
      await deps.drain(Math.max(10, woken.length * 2));
    }
  }

  for (const pr of candidates) {
    if (
      pr.mergeable !== 'CONFLICTING' &&
      pr.mergeStateStatus !== 'DIRTY' &&
      pr.mergeable !== 'UNKNOWN'
    ) {
      continue;
    }
    try {
      await reconcilePullRequestRemediation(
        deps,
        { repo: input.repo, issue: pr.number },
        {
          waitForMergeability: pr.mergeable === 'UNKNOWN',
          trigger: 'merge-sweep',
        },
      );
    } catch (error) {
      logger.warn(
        'agent-lcars: post-merge conflict check failed for %s#%s:',
        input.repo,
        pr.number,
        error,
      );
    }
  }
}

/**
 * Periodic maintenance sweep over open GitHub PR projections so PRs whose
 * review/conflict arrived before rollout, during a host restart, or while a
 * sibling authoring run was still live get picked up automatically without
 * needing a manual GitHub event.
 */
export async function reconcileOpenPullRequestRemediations(
  deps: PrRemediationDeps,
  deadlineMs: number,
): Promise<void> {
  const watchedRepos = getWatchedRepos();
  const projections: Awaited<
    ReturnType<OrchestratorStore['listOpenGithubAnchorProjections']>
  > = [];
  let projectionsComplete = false;
  try {
    let cursor: Parameters<
      OrchestratorStore['listOpenGithubAnchorProjectionPage']
    >[0]['cursor'];
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      if (Date.now() + 10_000 >= deadlineMs) break;
      const page = await deps.store.listOpenGithubAnchorProjectionPage({
        limit: 200,
        cursor,
      });
      projections.push(...page.projections);
      if (page.nextCursor === undefined) {
        projectionsComplete = true;
        break;
      }
      cursor = page.nextCursor;
    }
  } catch (error) {
    logger.warn(
      'agent-lcars: open PR remediation sweep could not read projections:',
      error,
    );
    recordPrRemediationCensus({
      complete: false,
      blocked: 0,
      running: 0,
      deliveryOwned: 0,
      stalled: 0,
      oldestStalledSeconds: 0,
      stalledPullRequests: [],
    });
    return;
  }

  const hasConcreteRemediationSignal = (
    projection: (typeof projections)[number],
  ): boolean =>
    (projection.unresolvedReviewThreadCount ?? 0) > 0 ||
    projection.mergeableState === 'dirty' ||
    projection.failingChecks?.some((check) =>
      check.name.startsWith('LCARS review'),
    ) === true;

  const eligible = projections.filter((projection) => {
    if (
      projection.kind !== 'pr' ||
      projection.state !== 'open' ||
      projection.draft === true ||
      projection.mergedAt != null ||
      projection.labels.includes('bot:renovate') ||
      projection.labels.includes('status:needs-human') ||
      projection.labels.includes('status:blocked')
    ) {
      return false;
    }
    if (!isControlPlaneRepository(projection.anchor.repo)) return false;
    const watched = watchedRepos.find(
      (repo) => repoKey(repo) === projection.anchor.repo,
    );
    if (watched === undefined || watched.agents === false) return false;
    if (
      projection.headRepository !== undefined &&
      projection.headRepository.toLowerCase() !==
        projection.anchor.repo.toLowerCase()
    ) {
      return false;
    }
    if (isAutomatedReviewExcludedAuthor(projection.author)) return false;
    return (
      hasConcreteRemediationSignal(projection) ||
      projection.reviewRequirement === 'required'
    );
  });
  // Prioritize PRs with concrete thread, merge-conflict, or LCARS-review block
  // signals ahead of generic `reviewRequirement === 'required'`.
  eligible.sort(
    (left, right) =>
      (hasConcreteRemediationSignal(left) ? 0 : 1) -
      (hasConcreteRemediationSignal(right) ? 0 : 1),
  );

  // Enqueue only: `handleReconcile`'s single outbox drain runs immediately
  // afterward and owns outbox claims, backoff, and response accounting.
  const enqueueOnlyDeps: PrRemediationDeps = {
    ...deps,
    drain: async () => ({ dispatched: [], reported: [], failed: [] }),
  };

  let inspected = 0;
  for (const projection of eligible) {
    if (Date.now() + 10_000 >= deadlineMs || inspected >= 10) break;
    try {
      const active = await deps.store.readActiveRun(projection.anchor);
      if (active !== undefined && isLive(active.state)) continue;
      const waitingDeliveries = await deps.store.readWaitingDeliveryTasks({
        repo: projection.anchor.repo,
        number: projection.anchor.issue,
      });
      if (waitingDeliveries.length > 0) continue;
      inspected += 1;
      await reconcilePullRequestRemediation(
        enqueueOnlyDeps,
        projection.anchor,
        { wakeDelivery: false, trigger: 'open-sweep' },
      );
    } catch (error) {
      logger.warn(
        'agent-lcars: open PR remediation sweep failed for %s#%s:',
        projection.anchor.repo,
        projection.anchor.issue,
        error,
      );
    }
  }

  // After remediation, so the census never spends the sweep's budget before
  // remediation does; a census starved of time reports complete=false.
  // Runs this sweep just admitted count as running.
  await recordBlockedPullRequestCensus(
    deps,
    eligible.filter(
      (projection) =>
        projection.mergeableState === 'dirty' ||
        (projection.unresolvedReviewThreadCount ?? 0) > 0,
    ),
    projectionsComplete,
    deadlineMs,
  );
}

/** Census cap: beyond this many blocked PRs the census reports incomplete. */
const CENSUS_MAX_BLOCKED = 50;

/**
 * Counts blocked PRs (merge conflict or unresolved review threads) and which
 * of them nothing is working: no live run on the PR, no waiting delivery
 * binding, and no PR or run activity within `PR_REMEDIATION_STALL_AFTER_MS`.
 * Read-only; it never admits work.
 */
async function recordBlockedPullRequestCensus(
  deps: PrRemediationDeps,
  blocked: readonly GithubAnchorProjection[],
  projectionsComplete: boolean,
  deadlineMs: number,
): Promise<void> {
  const nowMs = Date.parse(deps.now?.() ?? new Date().toISOString());
  let complete = projectionsComplete && blocked.length <= CENSUS_MAX_BLOCKED;
  let running = 0;
  let deliveryOwned = 0;
  const stalled: { ref: string; idleMs: number }[] = [];
  for (const projection of blocked.slice(0, CENSUS_MAX_BLOCKED)) {
    if (Date.now() + 10_000 >= deadlineMs) {
      complete = false;
      break;
    }
    try {
      const runs = await deps.store.listRuns(projection.anchor);
      if (runs.some((run) => isLive(run.state))) {
        running += 1;
        continue;
      }
      const waiting = await deps.store.readWaitingDeliveryTasks({
        repo: projection.anchor.repo,
        number: projection.anchor.issue,
      });
      if (waiting.length > 0) {
        deliveryOwned += 1;
        continue;
      }
      const lastActivityMs = Math.max(
        Date.parse(projection.sourceUpdatedAt),
        ...runs.map((run) => Date.parse(run.updatedAt)),
      );
      const idleMs = nowMs - lastActivityMs;
      if (idleMs >= PR_REMEDIATION_STALL_AFTER_MS) {
        stalled.push({
          ref: `${projection.anchor.repo}#${projection.anchor.issue}`,
          idleMs,
        });
      }
    } catch (error) {
      complete = false;
      logger.warn(
        'agent-lcars: PR remediation census read failed for %s#%s:',
        projection.anchor.repo,
        projection.anchor.issue,
        error,
      );
    }
  }
  stalled.sort(
    (left, right) =>
      right.idleMs - left.idleMs || left.ref.localeCompare(right.ref),
  );
  recordPrRemediationCensus({
    complete,
    blocked: blocked.length,
    running,
    deliveryOwned,
    stalled: stalled.length,
    oldestStalledSeconds: Math.floor((stalled[0]?.idleMs ?? 0) / 1000),
    stalledPullRequests: stalled.map((entry) => entry.ref),
  });
}
