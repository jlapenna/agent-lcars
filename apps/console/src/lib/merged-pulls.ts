import 'server-only';

import { logger } from '@agent-lcars/logging';

import { getGithubClient, getWatchedRepos } from './github-client';

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
