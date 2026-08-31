import 'server-only';

import type {
  GithubAnchorProjection,
  OrchestratorStore,
} from '@agent-lcars/orchestrator';

import { getActionItems } from './action-items';
import { controlPlaneRepositories } from './deployment';
import { githubAnchorProjectionFromDelivery } from './github-anchor-projection';
import { isSelectedGithubAnchorProjection } from './github-anchor-selector';
import {
  getGithubClient,
  getWatchedRepos,
  type WatchedRepo,
} from './github-client';
import { createOrchestratorRuntime } from './orchestrator-runtime';

export const ANCHOR_RECONCILE_PAGE_SIZE = 100;
export const ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY = 10;
export const ANCHOR_RECONCILE_REFRESH_CONCURRENCY = 16;

export class AnchorProjectionBackfillLimitError extends Error {
  override readonly name = 'AnchorProjectionBackfillLimitError';
}

const ENRICHMENT_BATCH_SIZE = 25;

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

/**
 * GitHub is read here only by the explicitly invoked backfill. The selection
 * is deliberately never imported by a console route: after the cutover every
 * queue signal is read from the stored projection it fills.
 */
export async function enrichBackfillAnchors(
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
        (
          projection,
        ) => `${anchorAlias(projection.anchor.issue)}: issueOrPullRequest(number: ${projection.anchor.issue}) {
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
      // GitHub's connection only returns the first 100 identities. We cannot
      // know how many remaining threads are unresolved, so count every
      // omitted record conservatively until a complete later snapshot says
      // otherwise; an underestimate would hide a merge blocker.
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
                .map(({ name: checkName, url }) => ({ name: checkName, url })),
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

const MAX_REFRESH_GENERATION_RETRIES = 3;

async function mapWithBoundedConcurrency<T, R>(input: {
  values: readonly T[];
  concurrency: number;
  map(value: T): Promise<R>;
}): Promise<R[]> {
  const results: R[] = new Array(input.values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(input.concurrency, input.values.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= input.values.length) return;
        results[index] = await input.map(input.values[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** One fence-protected exact refresh path for webhook invalidations and
 * backfill candidates. No webhook payload is merged into persisted state. */
export async function refreshGithubAnchorProjection(
  deps: GithubAnchorProjectionRefreshDeps,
  anchor: GithubAnchorProjection['anchor'],
  input: { deleted?: boolean } = {},
): Promise<GithubAnchorProjection | undefined> {
  for (let attempt = 0; attempt < MAX_REFRESH_GENERATION_RETRIES; attempt++) {
    const generation =
      await deps.store.beginGithubAnchorProjectionRefresh(anchor);
    const projection = input.deleted ? undefined : await deps.load(anchor);
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

interface AnchorProjectionReconcileDeps {
  readonly store: Pick<
    OrchestratorStore,
    'beginGithubAnchorProjectionRefresh' | 'applyGithubAnchorProjectionRefresh'
  >;
  readonly repositories: readonly string[];
  listOpenIssues(repository: string, page: number): Promise<unknown[]>;
  load(
    anchor: GithubAnchorProjection['anchor'],
  ): Promise<GithubAnchorProjection>;
  currentQueue?(): Promise<{ items: CurrentQueueAnchor[]; warnings: string[] }>;
  repositoryForProjection?(repository: string): WatchedRepo | undefined;
  now(): string;
}

export interface AnchorProjectionReconcileResult {
  repositories: number;
  anchors: number;
  comparison?: AnchorProjectionQueueComparison;
}

export interface AnchorProjectionQueueComparison {
  currentQueue: number;
  projectedQueue: number;
  missingProjectionKeys: string[];
  unexpectedProjectionKeys: string[];
  criticalFieldMismatches: {
    key: string;
    fields: ('title' | 'url' | 'author' | 'assigneeLogins')[];
  }[];
  warnings: string[];
  matches: boolean;
}

interface CurrentQueueAnchor {
  key: string;
  title: string;
  url: string;
  author?: string;
  assigneeLogins: string[];
}

function projectionKey(projection: GithubAnchorProjection): string {
  return `${projection.anchor.repo}#${projection.anchor.issue}`;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

export function compareSelectedGithubAnchorProjections(input: {
  currentQueue: CurrentQueueAnchor[];
  projections: GithubAnchorProjection[];
  warnings?: string[];
  repositoryForProjection?(repository: string): WatchedRepo | undefined;
}): AnchorProjectionQueueComparison {
  const current = new Map(input.currentQueue.map((item) => [item.key, item]));
  const projected = new Map(
    input.projections
      .filter((projection) =>
        isSelectedGithubAnchorProjection(
          projection,
          input.repositoryForProjection?.(projection.anchor.repo),
        ),
      )
      .map((projection) => [projectionKey(projection), projection]),
  );
  const missingProjectionKeys = [...current.keys()]
    .filter((key) => !projected.has(key))
    .sort();
  const unexpectedProjectionKeys = [...projected.keys()]
    .filter((key) => !current.has(key))
    .sort();
  const criticalFieldMismatches = [...current.entries()].flatMap(
    ([key, item]) => {
      const projection = projected.get(key);
      if (projection === undefined) return [];
      const fields: ('title' | 'url' | 'author' | 'assigneeLogins')[] = [];
      if (item.title !== projection.title) fields.push('title');
      if (item.url !== projection.url) fields.push('url');
      if (item.author !== projection.author) fields.push('author');
      if (
        JSON.stringify(sorted(item.assigneeLogins)) !==
        JSON.stringify(sorted(projection.assigneeLogins))
      ) {
        fields.push('assigneeLogins');
      }
      return fields.length === 0 ? [] : [{ key, fields }];
    },
  );
  const warnings = input.warnings ?? [];
  return {
    currentQueue: current.size,
    projectedQueue: projected.size,
    missingProjectionKeys,
    unexpectedProjectionKeys,
    criticalFieldMismatches,
    warnings,
    matches:
      missingProjectionKeys.length === 0 &&
      unexpectedProjectionKeys.length === 0 &&
      criticalFieldMismatches.length === 0 &&
      warnings.length === 0,
  };
}

/**
 * Explicit, bounded control-plane ingestion for anchors that were already
 * open before webhook projection shipped. This is never imported by queue
 * rendering: GitHub is used only to fill the durable projection once, then
 * every console load reads the server-owned copy.
 */
export async function reconcileGithubAnchorProjections(
  deps: AnchorProjectionReconcileDeps,
): Promise<AnchorProjectionReconcileResult> {
  let anchors = 0;
  const allProjections: GithubAnchorProjection[] = [];
  for (const repository of deps.repositories) {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo)
      throw new Error(`Invalid configured repository ${repository}`);
    let complete = false;
    for (
      let page = 1;
      page <= ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY;
      page++
    ) {
      const issues = await deps.listOpenIssues(repository, page);
      const anchorsForPage: GithubAnchorProjection['anchor'][] = [];
      for (const issue of issues) {
        const projection = githubAnchorProjectionFromDelivery({
          event: 'issues',
          payload: { repository: { full_name: repository }, issue },
          observedAt: deps.now(),
        });
        if (projection === undefined) {
          throw new Error(
            `GitHub returned an invalid anchor during projection backfill: ${repository}`,
          );
        }
        anchorsForPage.push(projection.anchor);
      }
      const refreshed = await mapWithBoundedConcurrency({
        values: anchorsForPage,
        concurrency: ANCHOR_RECONCILE_REFRESH_CONCURRENCY,
        map: async (anchor) => {
          const projection = await refreshGithubAnchorProjection(deps, anchor);
          if (projection === undefined) {
            throw new Error(
              `GitHub anchor backfill unexpectedly removed ${anchor.repo}#${anchor.issue}`,
            );
          }
          return projection;
        },
      });
      allProjections.push(...refreshed);
      anchors += refreshed.length;
      if (issues.length < ANCHOR_RECONCILE_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      // A full final page is ambiguous: page ten may be exactly the bounded
      // 1,000th anchor, or there may be more. Ask GitHub for one sentinel
      // page without ingesting it so exact-bound repositories remain valid
      // while >1,000 remains an explicit cutover stop.
      const sentinel = await deps.listOpenIssues(
        repository,
        ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY + 1,
      );
      complete = sentinel.length === 0;
    }
    if (!complete) {
      throw new AnchorProjectionBackfillLimitError(
        `GitHub anchor projection backfill found more than ${ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY * ANCHOR_RECONCILE_PAGE_SIZE} open anchors for ${repository}; increase the bounded limit before cutover.`,
      );
    }
  }
  const currentQueue = await deps.currentQueue?.();
  return {
    repositories: deps.repositories.length,
    anchors,
    ...(currentQueue === undefined
      ? {}
      : {
          comparison: compareSelectedGithubAnchorProjections({
            currentQueue: currentQueue.items,
            projections: allProjections,
            warnings: currentQueue.warnings,
            repositoryForProjection: deps.repositoryForProjection,
          }),
        }),
  };
}

export function reconcileCurrentGithubAnchorProjections(): Promise<AnchorProjectionReconcileResult> {
  const { store } = createOrchestratorRuntime();
  const github = getGithubClient();
  const watchedRepos = new Map(
    getWatchedRepos().map((repository) => [
      `${repository.owner}/${repository.name}`,
      repository,
    ]),
  );
  return reconcileGithubAnchorProjections({
    store,
    repositories: controlPlaneRepositories(),
    listOpenIssues: async (repository, page) => {
      const [owner, repo] = repository.split('/');
      const { data } = await github.rest.issues.listForRepo({
        owner: owner as string,
        repo: repo as string,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: ANCHOR_RECONCILE_PAGE_SIZE,
        page,
      });
      return data;
    },
    load: (anchor) => loadCurrentGithubAnchorProjection(github, anchor),
    currentQueue: async () => {
      const result = await getActionItems();
      return {
        items: result.items.map((item) => ({
          key: `${item.repo.owner}/${item.repo.name}#${item.number}`,
          title: item.title,
          url: item.url,
          ...(item.author === undefined ? {} : { author: item.author }),
          assigneeLogins: item.assigneeLogins,
        })),
        warnings: result.warnings,
      };
    },
    repositoryForProjection: (repository) => watchedRepos.get(repository),
    now: () => new Date().toISOString(),
  });
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
  const [enriched] = await enrichBackfillAnchors(
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
