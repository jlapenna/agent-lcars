import 'server-only';

import { logger } from '@agent-lcars/logging';
import { isE2eTesting } from '@agent-lcars/util-server';
import { cacheLife } from 'next/cache';

import { getGithubClient, getWatchedRepos } from './github-client';
import { repoKey } from './watched-repo';

const DAY_MS = 24 * 60 * 60 * 1000;
/** GitHub reads may run 15s; the readouts route gives up at 8s. A slow merge
 * count must cost only its own figure, not every readout. */
const MERGES_DEADLINE_MS = 5_000;
/** A day's merge count does not need the dashboard's 30s freshness. The
 * dashboard's 60s expiry left each instance refilling cold, a fill that
 * mints a token per repository and outlasts the deadline, so most page
 * loads showed the figure unavailable. Refresh in the background every five
 * minutes; refill cold only after an hour without readers. */
const MERGES_CACHE_LIFE = { stale: 300, revalidate: 300, expire: 3600 };

/** One page per repository. Merged PRs ordered by last update reach the
 * window's edge before the page ends unless a repository merged more than
 * this many in the window, which then reads as a lower bound. */
const PAGE_SIZE = 100;

const MERGED_PULLS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: ${PAGE_SIZE}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { mergedAt updatedAt }
    }
  }
}`;

interface MergedPullsResponse {
  repository?: {
    pullRequests?: {
      nodes?: ({ mergedAt?: string | null; updatedAt?: string } | null)[];
    };
  } | null;
}

export interface MergedPullCount {
  count: number;
  /** A repository could not be read or merged more than one page in the
   * window: the count is a lower bound. */
  partial: boolean;
}

/**
 * Pull requests merged across the watched repositories since `sinceMs`,
 * read from GitHub itself, so every merge counts whether or not a recorded
 * session referenced it. Throws when no repository could be read, so a
 * failure is never reported as zero merges.
 */
export async function countMergedPullsSince(
  sinceMs: number,
  github: Pick<
    ReturnType<typeof getGithubClient>,
    'graphql'
  > = getGithubClient(),
  repos: readonly { owner: string; name: string }[] = getWatchedRepos(),
): Promise<MergedPullCount> {
  const results = await Promise.allSettled(
    repos.map(async ({ owner, name }) => {
      const response = await github.graphql<MergedPullsResponse>(
        MERGED_PULLS_QUERY,
        { owner, name },
      );
      const nodes = response.repository?.pullRequests?.nodes;
      if (!nodes) throw new Error(`${owner}/${name}: no pull request page`);
      const count = nodes.filter(
        (node) => node?.mergedAt && Date.parse(node.mergedAt) >= sinceMs,
      ).length;
      // A full page whose oldest update is still inside the window may have
      // more merges beyond it. Updates follow merges, so an older update
      // closes the window.
      const last = nodes.at(-1);
      const truncated =
        nodes.length === PAGE_SIZE &&
        (last?.updatedAt === undefined ||
          Date.parse(last.updatedAt) >= sinceMs);
      return { count, truncated };
    }),
  );
  let count = 0;
  let partial = false;
  let read = 0;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      read++;
      count += result.value.count;
      partial ||= result.value.truncated;
    } else {
      partial = true;
      const repo = repos[index];
      logger.warn(
        `agent-lcars: merged pull requests unavailable for ${repo?.owner}/${repo?.name}:`,
        result.reason,
      );
    }
  });
  if (read === 0) throw new Error('Merged pull requests unavailable');
  return { count, partial };
}

/** The last day's merges across the watched repositories, or the one
 * `repo` (`owner/name`) a page is scoped to. */
async function readMergedLastDay(repo?: string): Promise<MergedPullCount> {
  const watched = getWatchedRepos();
  return countMergedPullsSince(
    Date.now() - DAY_MS,
    getGithubClient(),
    repo === undefined
      ? watched
      : watched.filter((candidate) => repoKey(candidate) === repo),
  );
}

async function readCachedMergedLastDay(
  repo?: string,
): Promise<MergedPullCount> {
  'use cache';
  cacheLife(MERGES_CACHE_LIFE);
  return readMergedLastDay(repo);
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
  return withinDeadline(
    isE2eTesting() ? readMergedLastDay(repo) : readCachedMergedLastDay(repo),
    MERGES_DEADLINE_MS,
  ).catch(() => undefined);
}
