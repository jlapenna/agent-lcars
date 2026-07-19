import type { IssueAgentSessionDoc } from '@repo/agent-telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
} from '@repo/agent-telemetry/server';

/** Mirrors cli-sessions.ts's ACTIVE_WINDOW_HOURS: a runner session only
 * matters while there's a live/recent workflow run to join it to (In Flight
 * budget gauges, Recent Outcomes diagnosis) - the telemetry collection
 * itself keeps every doc until its own TTL, so an unbounded query would grow
 * forever as the fleet runs. */
const ACTIVE_WINDOW_HOURS = 24;

export interface RunnerSessionsResult {
  /** Keyed by the GitHub Actions run id (`AgentRun.id`, stringified) via
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
 * finished GitHub Actions runs can be joined to their session telemetry -
 * turn/cost budget gauges on in-flight runs, run-status diagnosis on
 * finished ones (see run-classification.ts). Degrades to an empty map
 * rather than throwing, matching `getCliSessions`'s defensive pattern: every
 * caller must render exactly what it did before this telemetry existed,
 * since runner sessions may not be flowing yet (the shipper this joins to
 * is a separate, concurrently-developed piece) or the store may be
 * unreachable (PRD user story 16).
 */
export async function getRunnerSessionsByRunId(): Promise<RunnerSessionsResult> {
  const activeSince = new Date(
    Date.now() - ACTIVE_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    const docs = await listSessionDocs(firestore, { activeSince });
    const sessionsByRunId = new Map<string, IssueAgentSessionDoc>();
    for (const doc of docs) {
      if (doc.source === 'issue-agent' && doc.runId) {
        sessionsByRunId.set(doc.runId, doc);
      }
    }
    return { sessionsByRunId, warnings: [] };
  } catch (error) {
    console.error('agent-console: failed to list runner sessions:', error);
    return {
      sessionsByRunId: new Map(),
      warnings: [
        'Runner session telemetry unavailable (agent-telemetry store failed).',
      ],
    };
  }
}
