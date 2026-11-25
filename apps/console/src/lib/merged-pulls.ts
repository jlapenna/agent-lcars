import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { OrchestratorStore } from '@agent-lcars/orchestrator';

import { getWatchedRepos } from './github-client';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { repoKey } from './watched-repo';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The readouts route gives up at 8s; a slow merge count must cost only its
 * own figure, not every readout. */
const MERGES_DEADLINE_MS = 5_000;

export interface MergedPullCount {
  count: number;
  /** The count is a lower bound. Always false for the stored projections,
   * which hold every merged pull request; kept for the readout contract. */
  partial: boolean;
}

/**
 * Pull requests merged since `sinceMs` across `repos`, counted from the
 * GitHub anchor projections the webhook pipeline keeps for every pull
 * request. One indexed Firestore query, no GitHub calls: counting from
 * GitHub minted a token and ran a GraphQL page per repository, which a
 * fresh (scale-to-zero) instance could not finish inside the deadline, so
 * 31% of readouts on 2026-11-25 showed the figure unavailable.
 */
export async function countMergedPullsSince(
  sinceMs: number,
  store: Pick<OrchestratorStore, 'listGithubAnchorsMergedSince'>,
  repos: readonly { owner: string; name: string }[],
): Promise<MergedPullCount> {
  const watched = new Set(repos.map(repoKey));
  const anchors = await store.listGithubAnchorsMergedSince(
    new Date(sinceMs).toISOString(),
  );
  return {
    count: anchors.filter((anchor) => watched.has(anchor.repo)).length,
    partial: false,
  };
}

/** The last day's merges across the watched repositories, or the one
 * `repo` (`owner/name`) a page is scoped to. */
function readMergedLastDay(repo?: string): Promise<MergedPullCount> {
  const watched = getWatchedRepos();
  return countMergedPullsSince(
    Date.now() - DAY_MS,
    createOrchestratorRuntime().store,
    repo === undefined
      ? watched
      : watched.filter((candidate) => repoKey(candidate) === repo),
  );
}

async function withinDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The rail's and the Bridge's "merged · 24h". Undefined when it could not
 * be read in time, which the console shows as unavailable, never as zero. */
export async function mergedLastDay(
  repo?: string,
): Promise<MergedPullCount | undefined> {
  return withinDeadline(readMergedLastDay(repo), MERGES_DEADLINE_MS).catch(
    (error: unknown) => {
      logger.warn('agent-lcars: merged pull request count unavailable:', error);
      return undefined;
    },
  );
}
