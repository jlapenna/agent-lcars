import { cacheLife, cacheTag } from 'next/cache';

import { type ActionItemsResult, getActionItems } from './action-items';
import { type AgentActivity, getAgentActivity } from './agent-activity';
import { GITHUB_DATA_TAG } from './cache-tags';

/**
 * A short server-side cache in front of the dashboard's GitHub reads.
 *
 * Every navigation between Queue and Agents, and every Refresh click, used
 * to re-run the whole GitHub fetch. #147/#148 removed the search API's
 * 30-req/min ceiling and #151 collapsed the per-item N+1, but a load still
 * costs ~30 core-budget requests - and ~26 of those are `getAgentActivity`'s
 * workflow-run listings, which cannot be batched at all (GitHub's GraphQL
 * schema has no way to list a workflow's runs). Those are paid on every
 * load forever, which is exactly what a cache is for.
 *
 * Uses Next 16's native `"use cache"` rather than the legacy
 * `unstable_cache`: on this version the latter's entries were not reliably
 * purged by tag invalidation, which showed up as the console serving a
 * stale board after its fixtures changed. A cache whose invalidation does
 * not fire is worse than no cache - it means stale state after a merge.
 * See #149.
 *
 * Deliberately short. This is a live ops console: the point is to collapse
 * incidental refetches (navigation, a double-click, two tabs), NOT to serve
 * meaningfully old data. Everything that should show a change immediately -
 * every mutation in `app/actions.ts`, the Refresh control, and the e2e seed
 * route - invalidates the tag rather than waiting this out.
 *
 * See DASHBOARD_CACHE_LIFE below for why the window is spelled out rather
 * than taken from a named profile.
 */

/**
 * Explicit, NOT the built-in `seconds` profile.
 *
 * `seconds` is `{ stale: 30, revalidate: 1, expire: 60 }`, and that
 * `revalidate: 1` is the problem: any load more than a second after the last
 * one serves the cached value AND kicks off a background refetch. For a
 * human clicking between Queue and Agents that is every single load, so the
 * cache removes the *blocking* but not the *requests* - which is most of
 * why it exists, given ~26 of the ~30 per load are `getAgentActivity`'s
 * workflow-run listings that cannot be batched at all.
 *
 * `revalidate: 30` means loads inside a 30s window are genuinely free.
 * `expire: 60` bounds how stale a served value can get; `stale: 30` is the
 * client router's own window. None of this weakens correctness after a
 * mutation - every writer invalidates the tag rather than waiting this out.
 */
const DASHBOARD_CACHE_LIFE = { stale: 30, revalidate: 30, expire: 60 };

/** Wall-clock time the underlying fetch actually ran.
 *
 * Captured inside the cached function, so it is cached alongside the data it
 * describes and therefore reports the data's real age rather than the render
 * time. The header's "Updated ..." label reads this - without it a cache hit
 * would render "Updated just now" over data up to the cache lifetime old. */
export interface Fetched<T> {
  data: T;
  fetchedAt: string;
}

export async function getCachedActionItems(): Promise<
  Fetched<ActionItemsResult>
> {
  'use cache';
  cacheTag(GITHUB_DATA_TAG);
  cacheLife(DASHBOARD_CACHE_LIFE);
  return { data: await getActionItems(), fetchedAt: new Date().toISOString() };
}

export async function getCachedAgentActivity(): Promise<
  Fetched<AgentActivity>
> {
  'use cache';
  cacheTag(GITHUB_DATA_TAG);
  cacheLife(DASHBOARD_CACHE_LIFE);
  return {
    data: await getAgentActivity(),
    fetchedAt: new Date().toISOString(),
  };
}

/** The age the page should report, given every cached source it rendered
 * from: the oldest of them, since that is the staleness the maintainer is
 * actually looking at. Uncached sources (the Firestore reads) are always
 * current and so never lower this.
 *
 * Plain lexicographic order is chronological here - every input is a UTC
 * `toISOString()` from the cached fetches above. */
export function oldestFetchedAt(...fetchedAt: string[]): string {
  return [...fetchedAt].sort()[0] ?? new Date().toISOString();
}
