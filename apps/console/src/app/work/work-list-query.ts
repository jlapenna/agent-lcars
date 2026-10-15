import { itemStateSchema, workIdSchema } from '@agent-lcars/work';

export const WORK_PAGE_LIMIT = 200;
export interface WorkListParams {
  state?: string;
  repo?: string;
  principal?: string;
  cursor?: string;
  /** Page-level view filters (not Work API inputs): agent, window, find. */
  agent?: string;
  window?: string;
  q?: string;
}

export const WORK_WINDOWS = ['1h', '24h', '7d'] as const;
export type WorkWindow = (typeof WORK_WINDOWS)[number];
const WINDOW_MS: Record<WorkWindow, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
};

export interface WorkViewFilters {
  agent?: string;
  window?: WorkWindow;
  q?: string;
}

/** The toolbar's view filters, as the mockup draws them: agent, activity
 * window and free-text find. Like the API filters they apply to each store
 * page read; work-list-scan.ts reads on past pages they empty. Unknown
 * values are ignored rather than rejected. */
export function parseWorkViewFilters(params: WorkListParams): WorkViewFilters {
  const agent = params.agent?.trim() || undefined;
  const window = (WORK_WINDOWS as readonly string[]).includes(
    params.window ?? '',
  )
    ? (params.window as WorkWindow)
    : undefined;
  const q = params.q?.trim().slice(0, 128) || undefined;
  return { agent, window, q };
}

export function matchesWorkView(
  item: {
    id: string;
    updatedAt: string;
    spec: { title: string; pipeline: string; target: { repo: string } };
    origin: { principal: string };
    runs: readonly { pipeline: string }[];
  },
  filters: WorkViewFilters,
  now: number,
): boolean {
  if (
    filters.agent &&
    item.spec.pipeline !== filters.agent &&
    !item.runs.some((run) => run.pipeline === filters.agent)
  ) {
    return false;
  }
  if (
    filters.window &&
    now - Date.parse(item.updatedAt) > WINDOW_MS[filters.window]
  ) {
    return false;
  }
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack = [
      item.id,
      item.spec.title,
      item.spec.target.repo,
      item.origin.principal,
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** The Work API's list input; view-only filters are excluded. */
export function parseWorkListQuery(params: WorkListParams) {
  const state = params.state ? itemStateSchema.parse(params.state) : undefined;
  const cursor = params.cursor ? workIdSchema.parse(params.cursor) : undefined;
  const repo = params.repo?.trim() || undefined;
  const principal = params.principal?.trim() || undefined;
  if ((repo?.length ?? 0) > 256 || (principal?.length ?? 0) > 128) {
    throw new Error('Work filter exceeds its permitted length.');
  }
  return { state, repo, principal, cursor, limit: WORK_PAGE_LIMIT };
}

export function workListHref(params: WorkListParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  return `/work${query.size ? `?${query}` : ''}`;
}
