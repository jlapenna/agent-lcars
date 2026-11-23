import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
} from '@agent-lcars/telemetry/server';
import { isE2eTesting } from '@agent-lcars/util-server';
import { cacheLife } from 'next/cache';

/** Mirrors cli-sessions.ts's ACTIVE_WINDOW_HOURS: a runner session only
 * matters while there's a live/recent broker run to join it to (In Flight
 * budget gauges, Recent Outcomes diagnosis) - the telemetry collection
 * itself keeps every doc until its own TTL, so an unbounded query would grow
 * forever as the fleet runs. */
const ACTIVE_WINDOW_HOURS = 24;

export interface RunnerSessionsResult {
  /** Keyed by the authoritative broker Run id (`AgentRun.id`) via
   * `IssueAgentSessionDoc.runId` - the join key the runner-mode telemetry
   * shipper writes at upsert time (`buildSessionDoc`'s `options.runId`).
   * Docs with no `runId` yet (shipper not wired up for a given run, or a doc
   * mid-write) can't be joined and are dropped rather than guessed at. */
  sessionsByRunId: Map<string, IssueAgentSessionDoc>;
  /** Human-readable notes when the store degraded instead of crashing (e.g.
   * no telemetry infra reachable - PRD item 16). */
  warnings: string[];
}

/**
 * Fetches recently-active `source: 'issue-agent'` session docs so live and
 * finished broker Runs can be joined to their session telemetry -
 * turn/cost budget gauges on in-flight runs, run-status diagnosis on
 * finished ones (see run-classification.ts). Degrades to an empty map
 * rather than throwing, matching `getCliSessions`'s defensive pattern: every
 * caller must render exactly what it did before this telemetry existed,
 * since runner sessions may not be flowing yet (the shipper this joins to
 * is a separate, concurrently-developed piece) or the store may be
 * unreachable (PRD user story 16).
 */
async function listRunnerSessions(): Promise<IssueAgentSessionDoc[]> {
  const activeSince = new Date(
    Date.now() - ACTIVE_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const firestore = await getAgentTelemetryReaderFirestore();
  const docs = await listSessionDocs(firestore, { activeSince });
  return docs.filter(
    (doc): doc is IssueAgentSessionDoc =>
      doc.source === 'issue-agent' && Boolean(doc.runId),
  );
}

/** The broker runs this joins to come from the 30 s dashboard cache, so a
 * fresher telemetry read buys nothing; the window is ~800 full session
 * documents (several MB) that Bridge and Agents would otherwise re-read on
 * every navigation. Same lifetime and E2E bypass as `dashboard-data.ts`. */
const RUNNER_SESSIONS_CACHE_LIFE = { stale: 30, revalidate: 30, expire: 60 };

async function listCachedRunnerSessions(): Promise<IssueAgentSessionDoc[]> {
  'use cache';
  cacheLife(RUNNER_SESSIONS_CACHE_LIFE);
  return listRunnerSessions();
}

export async function getRunnerSessionsByRunId(): Promise<RunnerSessionsResult> {
  try {
    const docs = await (isE2eTesting()
      ? listRunnerSessions()
      : listCachedRunnerSessions());
    const sessionsByRunId = new Map<string, IssueAgentSessionDoc>();
    for (const doc of docs) {
      if (doc.runId) sessionsByRunId.set(doc.runId, doc);
    }
    return { sessionsByRunId, warnings: [] };
  } catch (error) {
    logger.error('agent-lcars: failed to list runner sessions:', error);
    return {
      sessionsByRunId: new Map(),
      warnings: [
        'Runner session telemetry unavailable (agent-telemetry store failed).',
      ],
    };
  }
}
