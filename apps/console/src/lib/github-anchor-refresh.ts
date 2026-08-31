import 'server-only';

import type {
  GithubAnchorProjection,
  OrchestratorStore,
} from '@agent-lcars/orchestrator';

import { githubAnchorProjectionFromDelivery } from './github-anchor-projection';
import { getGithubClient } from './github-client';
import { createOrchestratorRuntime } from './orchestrator-runtime';

const ENRICHMENT_BATCH_SIZE = 25;
const MAX_REFRESH_GENERATION_RETRIES = 3;

interface RawAnchorDetails {
  body?: string | null;
  comments?: {
    nodes?: ({
      body?: string;
      url?: string;
      createdAt?: string;
      updatedAt?: string;
      author?: { login?: string } | null;
    } | null)[];
  } | null;
  isDraft?: boolean;
  mergeStateStatus?: string;
  reviewRequests?: {
    nodes?: ({ requestedReviewer?: { login?: string } | null } | null)[];
  } | null;
  reviewThreads?: {
    totalCount?: number;
    nodes?: ({ id?: string; isResolved?: boolean } | null)[];
  } | null;
  commits?: {
    nodes?: ({
      commit?: {
        statusCheckRollup?: {
          contexts?: {
            totalCount?: number;
            nodes?: ({
              name?: string;
              status?: string;
              conclusion?: string | null;
              detailsUrl?: string | null;
            } | null)[];
          } | null;
        } | null;
      } | null;
    } | null)[];
  } | null;
}

function anchorAlias(number: number): string {
  return `i${number}`;
}

/** An exact anchor read includes bounded presentation fields that a webhook
 * body can omit. This is invoked only by control-plane refreshes, never by a
 * console render. */
export async function enrichGithubAnchorProjections(
  repository: string,
  projections: GithubAnchorProjection[],
  github: Pick<
    ReturnType<typeof getGithubClient>,
    'graphql'
  > = getGithubClient(),
): Promise<GithubAnchorProjection[]> {
  const [owner, name] = repository.split('/');
  const enriched = new Map<string, GithubAnchorProjection>();
  for (
    let offset = 0;
    offset < projections.length;
    offset += ENRICHMENT_BATCH_SIZE
  ) {
    const batch = projections.slice(offset, offset + ENRICHMENT_BATCH_SIZE);
    const selection = batch
      .map(
        (projection) =>
          `${anchorAlias(projection.anchor.issue)}: issueOrPullRequest(number: ${projection.anchor.issue}) {
        ... on Issue { body comments(last: 1) { nodes { body url createdAt updatedAt author { login } } } }
        ... on PullRequest {
          body isDraft mergeStateStatus
          comments(last: 1) { nodes { body url createdAt updatedAt author { login } } }
          reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
          reviewThreads(first: 100) { totalCount nodes { id isResolved } }
          commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes { ... on CheckRun { name status conclusion detailsUrl } } } } } } }
        }
      }`,
      )
      .join('\n');
    const response = await github.graphql<{
      repository?: Record<string, RawAnchorDetails>;
    }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${selection} } }`,
      { owner: owner as string, name: name as string },
    );
    for (const projection of batch) {
      const detail =
        response.repository?.[anchorAlias(projection.anchor.issue)];
      if (detail === undefined) continue;
      const contexts =
        detail.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
      const checkRuns = (contexts?.nodes ?? []).flatMap((check) =>
        check?.name
          ? [
              {
                name: check.name,
                url: check.detailsUrl ?? projection.url,
                status: check.status?.toLowerCase() ?? 'completed',
                conclusion: check.conclusion?.toLowerCase() ?? null,
              },
            ]
          : [],
      );
      const latestComment = detail.comments?.nodes?.at(-1);
      const mergeableState = detail.mergeStateStatus?.toLowerCase();
      const threadNodes = detail.reviewThreads?.nodes ?? [];
      const unresolvedReviewThreadIds = threadNodes.flatMap((thread) =>
        thread?.isResolved === false && thread.id !== undefined
          ? [thread.id]
          : [],
      );
      const unresolvedReviewThreadCount =
        unresolvedReviewThreadIds.length +
        Math.max(
          0,
          (detail.reviewThreads?.totalCount ?? threadNodes.length) -
            threadNodes.length,
        );
      enriched.set(`${projection.anchor.repo}#${projection.anchor.issue}`, {
        ...projection,
        ...(detail.body === undefined || detail.body === null
          ? {}
          : { body: detail.body }),
        ...(latestComment?.body === undefined ||
        latestComment.url === undefined ||
        latestComment.createdAt === undefined
          ? {}
          : {
              lastComment: {
                body: latestComment.body,
                url: latestComment.url,
                createdAt: latestComment.createdAt,
                ...(latestComment.updatedAt === undefined
                  ? {}
                  : { updatedAt: latestComment.updatedAt }),
                ...(latestComment.author?.login === undefined
                  ? {}
                  : { author: latestComment.author.login }),
              },
            }),
        ...(projection.kind === 'pr'
          ? {
              draft: detail.isDraft ?? projection.draft ?? false,
              mergeableState:
                mergeableState === 'clean' ||
                mergeableState === 'dirty' ||
                mergeableState === 'blocked' ||
                mergeableState === 'unstable' ||
                mergeableState === 'behind' ||
                mergeableState === 'draft' ||
                mergeableState === 'unknown'
                  ? mergeableState
                  : 'unknown',
              requestedReviewerLogins: (
                detail.reviewRequests?.nodes ?? []
              ).flatMap((request) =>
                request?.requestedReviewer?.login === undefined
                  ? []
                  : [request.requestedReviewer.login],
              ),
              checkRuns,
              failingChecks: checkRuns
                .filter(
                  (check) =>
                    check.status === 'completed' &&
                    check.conclusion === 'failure',
                )
                .map(({ name, url }) => ({ name, url })),
              ciRunning: checkRuns.some(
                (check) => check.status !== 'completed',
              ),
              unresolvedReviewThreadCount,
              unresolvedReviewThreadIds,
              checksTruncated:
                (contexts?.totalCount ?? 0) > (contexts?.nodes?.length ?? 0),
              reviewThreadsTruncated:
                (detail.reviewThreads?.totalCount ?? 0) > threadNodes.length,
            }
          : {}),
      });
    }
  }
  return projections.map(
    (projection) =>
      enriched.get(`${projection.anchor.repo}#${projection.anchor.issue}`) ??
      projection,
  );
}

export interface GithubAnchorProjectionRefreshDeps {
  readonly store: Pick<
    OrchestratorStore,
    'beginGithubAnchorProjectionRefresh' | 'applyGithubAnchorProjectionRefresh'
  >;
  load(
    anchor: GithubAnchorProjection['anchor'],
  ): Promise<GithubAnchorProjection>;
}

function isGithubNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 404
  );
}

/** One fence-protected exact refresh path for webhook invalidations. No
 * webhook payload is merged into persisted state. */
export async function refreshGithubAnchorProjection(
  deps: GithubAnchorProjectionRefreshDeps,
  anchor: GithubAnchorProjection['anchor'],
  input: { deleted?: boolean } = {},
): Promise<GithubAnchorProjection | undefined> {
  for (let attempt = 0; attempt < MAX_REFRESH_GENERATION_RETRIES; attempt++) {
    const generation =
      await deps.store.beginGithubAnchorProjectionRefresh(anchor);
    let projection: GithubAnchorProjection | undefined;
    if (!input.deleted) {
      try {
        projection = await deps.load(anchor);
      } catch (error) {
        if (!isGithubNotFound(error)) throw error;
      }
    }
    const applied = await deps.store.applyGithubAnchorProjectionRefresh({
      anchor,
      generation,
      ...(projection === undefined ? {} : { projection }),
    });
    if (applied) return projection;
  }
  throw new Error(
    `GitHub anchor refresh could not apply after ${MAX_REFRESH_GENERATION_RETRIES} fenced attempts: ${anchor.repo}#${anchor.issue}`,
  );
}

async function loadCurrentGithubAnchorProjection(
  github: ReturnType<typeof getGithubClient>,
  anchor: GithubAnchorProjection['anchor'],
): Promise<GithubAnchorProjection> {
  const [owner, repo] = anchor.repo.split('/');
  const { data } = await github.rest.issues.get({
    owner: owner as string,
    repo: repo as string,
    issue_number: anchor.issue,
  });
  const projection = githubAnchorProjectionFromDelivery({
    event: 'issues',
    payload: { repository: { full_name: anchor.repo }, issue: data },
    observedAt: new Date().toISOString(),
  });
  if (projection === undefined) {
    throw new Error(
      `GitHub returned an invalid anchor: ${anchor.repo}#${anchor.issue}`,
    );
  }
  const [enriched] = await enrichGithubAnchorProjections(
    anchor.repo,
    [projection],
    github,
  );
  return enriched ?? projection;
}

/** Server-side webhook ingestion only. Queue rendering never invokes this. */
export async function refreshCurrentGithubAnchorProjection(
  anchor: GithubAnchorProjection['anchor'],
  input: { deleted?: boolean } = {},
): Promise<void> {
  const { store } = createOrchestratorRuntime();
  const github = getGithubClient();
  await refreshGithubAnchorProjection(
    {
      store,
      load: (current) => loadCurrentGithubAnchorProjection(github, current),
    },
    anchor,
    input,
  );
}
