import { cache } from 'react';

import { type ActionItemsResult } from './action-items';
import { type AgentActivity, getAgentActivity } from './agent-activity';
import { getAuthoritativeQueueItems } from './authoritative-queue';

/**
 * The authoritative queue and agent activity that Bridge, Inbox, Agents and
 * the console frame render, read fresh for every request.
 *
 * Both are Firestore reads of the control plane's own projections (Work,
 * Task, Run, webhook anchors and autoscaler status) and take about 0.3 s
 * and 0.5 s uncached. They used to sit behind a 30 to 60 s cache, which made
 * every page show runs and queue state up to a minute old. React's `cache`
 * shares one read between the page, the frame's readouts and the inbox
 * badge within a request, so a render pays for each read once.
 */

/** Wall-clock time the underlying read ran. The header's "Data as of" label
 * reads it, so it reports when the data was read rather than the render
 * time of a page that stayed open. */
export interface Fetched<T> {
  data: T;
  fetchedAt: string;
}

export const getCachedQueueItems = cache(
  async (): Promise<Fetched<ActionItemsResult>> => {
    const fetchedAt = new Date().toISOString();
    return { data: await getAuthoritativeQueueItems(), fetchedAt };
  },
);

export const getCachedAgentActivity = cache(
  async (): Promise<Fetched<AgentActivity>> => {
    const fetchedAt = new Date().toISOString();
    return { data: await getAgentActivity(), fetchedAt };
  },
);

/** The age the page should report, given every source it rendered from: the
 * oldest of them.
 *
 * Plain lexicographic order is chronological here - every input is a UTC
 * `toISOString()` from the reads above. */
export function oldestFetchedAt(...fetchedAt: string[]): string {
  return [...fetchedAt].sort()[0] ?? new Date().toISOString();
}
