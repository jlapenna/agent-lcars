import { itemStateSchema, workIdSchema } from '@agent-lcars/work';

export const WORK_PAGE_LIMIT = 200;
export interface WorkListParams {
  state?: string;
  repo?: string;
  principal?: string;
  cursor?: string;
}

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
