import type { SessionAgent } from '@agent-lcars/telemetry';
import { PIPELINES } from '@agent-lcars/work';

import type { AgentPipeline, AgentRun } from '../../lib/agent-activity';
import { repoKey } from '../../lib/watched-repo';

/** The toolbar's activity windows (design/fleet-console.html); absent is
 * all, so nothing is hidden unless asked. */
export const AGENTS_WINDOWS = ['1h', '24h', '7d'] as const;
export type AgentsWindow = (typeof AGENTS_WINDOWS)[number];
const WINDOW_MS: Record<AgentsWindow, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
};

export interface AgentsViewFilters {
  agent?: AgentPipeline;
  window?: AgentsWindow;
  q?: string;
}

type RawParam = string | string[] | undefined;

/** Next hands a repeated parameter (`?q=a&q=b`) over as an array; the first
 * value wins, as on Sessions. */
function first(value: RawParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Unknown values are ignored rather than rejected, as on Work. */
export function parseAgentsViewFilters(params: {
  agent?: RawParam;
  window?: RawParam;
  q?: RawParam;
}): AgentsViewFilters {
  const agentParam = first(params.agent) ?? '';
  const agent = (PIPELINES as readonly string[]).includes(agentParam)
    ? (agentParam as AgentPipeline)
    : undefined;
  const windowParam = first(params.window) ?? '';
  const window = (AGENTS_WINDOWS as readonly string[]).includes(windowParam)
    ? (windowParam as AgentsWindow)
    : undefined;
  const q = first(params.q)?.trim().slice(0, 128) || undefined;
  return { agent, window, q };
}

/** Free-text find over what a row shows: title, `owner/repo#N`, run id. */
export function matchesFind(
  fields: readonly (string | undefined)[],
  q: string | undefined,
): boolean {
  if (!q) return true;
  return fields.join(' ').toLowerCase().includes(q.toLowerCase());
}

/** Agent and find narrow every run. The window narrows finished runs only:
 * a live run is current by definition. */
export function matchesAgentsRun(
  run: Pick<
    AgentRun,
    'id' | 'pipeline' | 'displayTitle' | 'repo' | 'issueNumber' | 'updatedAt'
  >,
  filters: AgentsViewFilters,
  {
    finished,
    now,
    shownTitle,
  }: {
    finished: boolean;
    now: number;
    /** The title the row displays when it differs from the run's own (a
     * live issue renamed since admission). */
    shownTitle?: string;
  },
): boolean {
  if (filters.agent && run.pipeline !== filters.agent) return false;
  if (
    finished &&
    filters.window &&
    now - Date.parse(run.updatedAt) > WINDOW_MS[filters.window]
  ) {
    return false;
  }
  const anchor =
    run.issueNumber === undefined
      ? repoKey(run.repo)
      : `${repoKey(run.repo)}#${run.issueNumber}`;
  return matchesFind([run.displayTitle, shownTitle, anchor, run.id], filters.q);
}

/** Claimed work belongs to the pipeline its authoritative Work spec names;
 * only work with no task record falls back to its `agent:` label. */
export function matchesClaimedAgent(
  item: { labels: readonly string[] },
  specPipeline: string | undefined,
  agent: AgentPipeline | undefined,
): boolean {
  if (!agent) return true;
  return specPipeline === undefined
    ? item.labels.includes(`agent:${agent}`)
    : specPipeline === agent;
}

/** A dispatch pipeline's CLI adapter, for narrowing interactive sessions. */
const SESSION_AGENT: Record<AgentPipeline, SessionAgent> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
};

/** Agent and find narrow interactive sessions too; they are live, so the
 * window does not apply. */
export function matchesAgentsSession(
  session: {
    agent: SessionAgent;
    sessionId: string;
    title?: string;
    branch?: string;
    repo?: { owner: string; name: string };
  },
  filters: AgentsViewFilters,
): boolean {
  if (filters.agent && session.agent !== SESSION_AGENT[filters.agent]) {
    return false;
  }
  return matchesFind(
    [
      session.title,
      session.sessionId,
      session.branch,
      session.repo && repoKey(session.repo),
    ],
    filters.q,
  );
}
