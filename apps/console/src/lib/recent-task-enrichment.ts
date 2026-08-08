import type { DispatchLedger } from '@agent-lcars/dispatch-contracts';
import { cacheLife, cacheTag } from 'next/cache';

import { GITHUB_DATA_TAG } from './cache-tags';
import { DASHBOARD_CACHE_LIFE, type Fetched } from './dashboard-data';
import { repoKey, type WatchedRepo } from './github-client';
import { enrichItems } from './item-enrichment';

export interface RecentTaskLookup {
  repo: WatchedRepo;
  issueNumber: number;
}

export interface RecentTaskEnrichment {
  repo: WatchedRepo;
  issueNumber: number;
  ledger?: DispatchLedger;
  mergedDeliverableNumbers: number[];
}

export interface RecentTaskEnrichmentResult {
  entries: RecentTaskEnrichment[];
  warnings: string[];
}

/**
 * Fetches the exact ledger and merged-PR relationships for the bounded
 * recent-run window. The open action-item board cannot supply these once a
 * successful PR closes its anchor, which used to make the most important
 * reliability outcome disappear at exactly the moment it became "merged".
 *
 * Calls remain bounded and batched: `recentRuns` is globally capped, task
 * references are deduplicated, and `enrichItems` emits one GraphQL document
 * per watched repository (up to its existing per-document item cap).
 */
export async function getCachedRecentTaskEnrichment(
  tasks: RecentTaskLookup[],
): Promise<Fetched<RecentTaskEnrichmentResult>> {
  'use cache';
  cacheTag(GITHUB_DATA_TAG);
  cacheLife(DASHBOARD_CACHE_LIFE);

  const unique = new Map<string, RecentTaskLookup>();
  for (const task of tasks) {
    unique.set(`${repoKey(task.repo)}#${task.issueNumber}`, task);
  }

  const byRepo = new Map<string, RecentTaskLookup[]>();
  for (const task of unique.values()) {
    const key = repoKey(task.repo);
    const group = byRepo.get(key);
    if (group) group.push(task);
    else byRepo.set(key, [task]);
  }

  const results = await Promise.all(
    [...byRepo.values()].map(async (group) => {
      const repo = group[0].repo;
      const enrichment = await enrichItems(
        repo,
        group.map((task) => ({
          number: task.issueNumber,
          isPr: false,
          wantsComments: true,
          wantsMergedDeliverables: true,
        })),
      );
      return {
        entries: group.map((task) => {
          const item = enrichment.byNumber.get(task.issueNumber);
          return {
            repo: task.repo,
            issueNumber: task.issueNumber,
            ledger: item?.ledger,
            mergedDeliverableNumbers: (item?.mergedDeliverables ?? []).map(
              (deliverable) => deliverable.number,
            ),
          };
        }),
        warnings: enrichment.warnings,
      };
    }),
  );

  return {
    data: {
      entries: results.flatMap((result) => result.entries),
      warnings: results.flatMap((result) => result.warnings),
    },
    fetchedAt: new Date().toISOString(),
  };
}
