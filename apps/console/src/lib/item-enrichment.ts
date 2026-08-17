import { getGithubClient, repoKey, type WatchedRepo } from './github-client';

/**
 * Batched per-item enrichment for the action-item board.
 *
 * `classifyIssue` used to make its own REST calls per item: one
 * `issues.listComments` for every parked or fleet-claimed item, plus - for
 * each PR - one `pulls.get` and up to five `checks.listForRef`. That is a
 * classic N+1, and the one cost on the board that *grows with the board*:
 * #147 got selection down to two calls per repo, but a 20-item board still
 * spent ~20 more on enrichment.
 *
 * GraphQL answers all of it in one request per repo, because every field
 * involved hangs off the item itself. Note the deliberate asymmetry with
 * `agent-activity.ts`, which stays on REST: GitHub's GraphQL schema has no
 * way to *list* a workflow's runs (`WorkflowRun` is reachable only via
 * `CheckSuite.workflowRun`), so that fan-out cannot be collapsed this way.
 */

/** Mirrors the REST comment shape `scanComments` used to return. */
export interface EnrichedComment {
  body: string;
  url: string;
  author?: string;
}

/** Mirrors `checks.listForRef`'s check-run shape, lowercased - see
 * `toCheckRun`. */
export interface EnrichedCheckRun {
  name: string;
  html_url?: string | null;
  status: string;
  conclusion: string | null;
}

export interface EnrichedPr {
  draft: boolean;
  mergeableState: string;
  /** Authoritative PR body - the listing's copy can lag. */
  body?: string | null;
  requestedReviewerLogins: string[];
  checkRuns: EnrichedCheckRun[];
  /** More check runs exist than {@link CHECK_WINDOW} returned. */
  checksTruncated: boolean;
  /** Count of `reviewThreads` nodes with `isResolved: false` - the "read
   * the threads" signal #538 exists for: green checks and an empty
   * `reviewDecision` can both be true while this alone is what keeps a PR
   * unmergeable. */
  unresolvedReviewThreadCount: number;
  /** More review threads exist than {@link REVIEW_THREAD_WINDOW} returned -
   * `unresolvedReviewThreadCount` may be an undercount. */
  reviewThreadsTruncated: boolean;
}

export interface EnrichedMergedDeliverable {
  number: number;
  url: string;
  mergedAt: string;
}

export interface ItemEnrichment {
  /** Oldest→newest, same order `issues.listComments` returned, so the
   * newest is last and a backwards scan finds the newest match first. */
  comments: EnrichedComment[];
  /** Absent for issues. */
  pr?: EnrichedPr;
  /** Authoritative merged PRs GitHub associates with this anchor. Requested
   * only by reliability/task-detail reads; omitted from the open board's
   * ordinary enrichment to avoid paying for unused graph nodes. For a PR
   * anchor this contains the PR itself once merged. */
  mergedDeliverables?: EnrichedMergedDeliverable[];
}

export interface EnrichmentResult {
  byNumber: Map<number, ItemEnrichment>;
  warnings: string[];
}

/** Matches `scanComments`' old window: it read the last page of up to 100
 * comments and scanned backwards, so a takeover command older than that was
 * already invisible. */
const COMMENT_WINDOW = 100;

/** `contexts` caps at 100 per page. The old REST path walked up to 5 pages
 * and flagged truncation past that; `totalCount` gives the same signal in
 * one shot, so anything beyond one page is reported rather than walked. */
export const CHECK_WINDOW = 100;

/** GitHub's `reviewThreads` connection has no `isResolved`-filter argument
 * (verified against the live schema), so an unresolved count can only come
 * from fetching nodes and filtering client-side - there is no way to ask
 * for just the unresolved ones or for a resolved/unresolved split via
 * `totalCount` alone. A typical PR carries at most a handful of threads
 * (the #521 retro's worst case was 17 across ten PRs), so one page is
 * expected to cover it; `totalCount` still catches the rare PR that
 * exceeds it so the count degrades to "truncated" instead of silently
 * undercounting (same pattern as `CHECK_WINDOW`/`checksTruncated`). */
export const REVIEW_THREAD_WINDOW = 100;

/** Items per GraphQL document. Each item is a separate aliased field, so
 * this bounds query size (and blast radius) on a large board rather than
 * emitting one enormous request. */
const ITEMS_PER_QUERY = 25;

/** Deterministic and shared with the e2e GitHub fixture, which keys its
 * canned response off the same aliases. Item numbers are positive integers,
 * so this is always a valid GraphQL alias. */
function alias(number: number): string {
  return `i${number}`;
}

export interface EnrichmentRequest {
  number: number;
  isPr: boolean;
  /** Only parked/fleet-claimed items need a comment scan - see
   * `classifyIssue`. Requesting the window for everything would multiply
   * node cost across the whole board for data nobody reads. */
  wantsComments: boolean;
  /** Fetch exact merged-PR relationships for outcome reporting. */
  wantsMergedDeliverables?: boolean;
}

function selectionFor(request: EnrichmentRequest): string {
  const comments = request.wantsComments
    ? `comments(last: ${COMMENT_WINDOW}) { nodes { body url author { login } } }`
    : '';
  const issueMergedDeliverables = request.wantsMergedDeliverables
    ? `closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
        nodes { number url mergedAt }
      }`
    : '';
  const pullRequestMergeFields = request.wantsMergedDeliverables
    ? 'url mergedAt'
    : '';
  // `number` is always selected: a selection set cannot be empty, and an
  // item needing neither comments nor PR fields would otherwise emit one.
  return `
    ${alias(request.number)}: issueOrPullRequest(number: ${request.number}) {
      __typename
      ... on Issue { number ${comments} ${issueMergedDeliverables} }
      ... on PullRequest {
        number
        ${pullRequestMergeFields}
        isDraft
        mergeStateStatus
        body
        ${comments}
        reviewRequests(first: 20) {
          nodes { requestedReviewer { ... on User { login } } }
        }
        reviewThreads(first: ${REVIEW_THREAD_WINDOW}) {
          totalCount
          nodes { isResolved }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: ${CHECK_WINDOW}) {
                  totalCount
                  nodes { ... on CheckRun { name status conclusion detailsUrl } }
                }
              }
            }
          }
        }
      }
    }`;
}

function buildQuery(requests: EnrichmentRequest[]): string {
  return `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${requests.map(selectionFor).join('\n')}
    }
  }`;
}

// GraphQL enums are SCREAMING_CASE where the REST fields these replace are
// lowercase (`COMPLETED`/`SKIPPED` vs `completed`/`skipped`, `BLOCKED` vs
// `blocked`). Verified against both APIs on the same PR before relying on
// it. Lowercasing is the whole mapping - the value sets are otherwise 1:1.
function lower(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

interface RawComment {
  body?: string | null;
  url?: string | null;
  author?: { login?: string } | null;
}

interface RawCheckContext {
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
}

interface RawItem {
  __typename?: string;
  number?: number;
  url?: string;
  mergedAt?: string | null;
  closedByPullRequestsReferences?: {
    nodes?:
      | ({ number?: number; url?: string; mergedAt?: string | null } | null)[]
      | null;
  } | null;
  isDraft?: boolean;
  mergeStateStatus?: string;
  body?: string | null;
  comments?: { nodes?: (RawComment | null)[] | null } | null;
  reviewRequests?: {
    nodes?: ({ requestedReviewer?: { login?: string } | null } | null)[] | null;
  } | null;
  reviewThreads?: {
    totalCount?: number;
    nodes?: ({ isResolved?: boolean } | null)[] | null;
  } | null;
  commits?: {
    nodes?:
      | ({
          commit?: {
            statusCheckRollup?: {
              contexts?: {
                totalCount?: number;
                nodes?: (RawCheckContext | null)[] | null;
              } | null;
            } | null;
          } | null;
        } | null)[]
      | null;
  } | null;
}

/** The REST `mergeable_state` values `MergeableState` models. GraphQL adds
 * `HAS_HOOKS`, which has no slot in that union, so it degrades to `unknown`
 * rather than being cast through as a value the UI never expects. */
const MERGE_STATES = new Set([
  'clean',
  'dirty',
  'blocked',
  'unstable',
  'behind',
  'draft',
  'unknown',
]);

function toCheckRuns(item: RawItem): {
  checkRuns: EnrichedCheckRun[];
  checksTruncated: boolean;
} {
  const contexts =
    item.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  const nodes = contexts?.nodes ?? [];
  // `contexts` mixes CheckRun and StatusContext; only CheckRun carries
  // `name`/`status`, and only CheckRun is what `checks.listForRef` returned,
  // so anything without a name is a StatusContext and is skipped.
  const checkRuns = nodes.flatMap((node) =>
    node?.name
      ? [
          {
            name: node.name,
            html_url: node.detailsUrl ?? null,
            status: lower(node.status) ?? 'completed',
            conclusion: lower(node.conclusion),
          },
        ]
      : [],
  );
  return {
    checkRuns,
    checksTruncated: (contexts?.totalCount ?? 0) > nodes.length,
  };
}

function toReviewThreads(item: RawItem): {
  unresolvedReviewThreadCount: number;
  reviewThreadsTruncated: boolean;
} {
  const reviewThreads = item.reviewThreads;
  const nodes = reviewThreads?.nodes ?? [];
  const unresolvedReviewThreadCount = nodes.filter(
    (node) => node?.isResolved === false,
  ).length;
  return {
    unresolvedReviewThreadCount,
    reviewThreadsTruncated: (reviewThreads?.totalCount ?? 0) > nodes.length,
  };
}

function toEnrichment(
  item: RawItem,
  wantsMergedDeliverables: boolean,
): ItemEnrichment {
  const comments = (item.comments?.nodes ?? []).flatMap((node) =>
    node?.body
      ? [
          {
            body: node.body,
            url: node.url ?? '',
            author: node.author?.login ?? undefined,
          },
        ]
      : [],
  );

  if (item.__typename !== 'PullRequest') {
    const mergedDeliverables = wantsMergedDeliverables
      ? (item.closedByPullRequestsReferences?.nodes ?? []).flatMap((node) =>
          node?.number && node.url && node.mergedAt
            ? [
                {
                  number: node.number,
                  url: node.url,
                  mergedAt: node.mergedAt,
                },
              ]
            : [],
        )
      : undefined;
    return { comments, mergedDeliverables };
  }

  const mergeState = lower(item.mergeStateStatus) ?? 'unknown';
  const { checkRuns, checksTruncated } = toCheckRuns(item);
  const { unresolvedReviewThreadCount, reviewThreadsTruncated } =
    toReviewThreads(item);
  return {
    comments,
    mergedDeliverables: wantsMergedDeliverables
      ? item.number && item.url && item.mergedAt
        ? [
            {
              number: item.number,
              url: item.url,
              mergedAt: item.mergedAt,
            },
          ]
        : []
      : undefined,
    pr: {
      draft: item.isDraft ?? false,
      mergeableState: MERGE_STATES.has(mergeState) ? mergeState : 'unknown',
      body: item.body,
      requestedReviewerLogins: (item.reviewRequests?.nodes ?? []).flatMap(
        (node) =>
          node?.requestedReviewer?.login ? [node.requestedReviewer.login] : [],
      ),
      checkRuns,
      checksTruncated,
      unresolvedReviewThreadCount,
      reviewThreadsTruncated,
    },
  };
}

/** Octokit throws on a GraphQL response carrying `errors`, but attaches
 * whatever `data` did resolve. A partial result is worth keeping: one bad
 * item shouldn't blank the enrichment for the whole repo, matching the
 * per-item degradation the REST path gave. */
function partialData(error: unknown): Record<string, RawItem> | undefined {
  const data = (error as { data?: { repository?: Record<string, RawItem> } })
    ?.data;
  return data?.repository;
}

export async function enrichItems(
  repo: WatchedRepo,
  requests: EnrichmentRequest[],
): Promise<EnrichmentResult> {
  const byNumber = new Map<number, ItemEnrichment>();
  const warnings: string[] = [];
  if (requests.length === 0) return { byNumber, warnings };

  const octokit = getGithubClient();
  for (let i = 0; i < requests.length; i += ITEMS_PER_QUERY) {
    const chunk = requests.slice(i, i + ITEMS_PER_QUERY);
    let repository: Record<string, RawItem> | undefined;
    try {
      const response = await octokit.graphql<{
        repository: Record<string, RawItem>;
      }>(buildQuery(chunk), { owner: repo.owner, name: repo.name });
      repository = response?.repository;
    } catch (error) {
      repository = partialData(error);
      console.error(
        'agent-lcars: item enrichment query failed (%s):',
        repoKey(repo),
        error,
      );
      warnings.push(
        repository
          ? `Some item details unavailable for ${repoKey(repo)}.`
          : `Item details unavailable for ${repoKey(repo)}.`,
      );
    }
    if (!repository) continue;
    for (const request of chunk) {
      const raw = repository[alias(request.number)];
      if (!raw) continue;
      byNumber.set(
        request.number,
        toEnrichment(raw, Boolean(request.wantsMergedDeliverables)),
      );
    }
  }
  return { byNumber, warnings };
}
