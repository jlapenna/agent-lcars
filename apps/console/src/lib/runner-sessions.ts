import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocsByRunIds,
} from '@agent-lcars/telemetry/server';

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
 * Fetches the `source: 'issue-agent'` session docs of exactly the runs a page
 * renders, so live and finished broker Runs can be joined to their session
 * telemetry - turn/cost budget gauges on in-flight runs, run-status
 * diagnosis on finished ones (see run-classification.ts). Reads by run id:
 * the activity window holds hundreds of sessions a day, while a page renders
 * a few dozen runs.
 *
 * A run can hold several sessions (one per provider session, subagents
 * included). Until the writer links them, the join keeps the one with the
 * latest activity, which is deterministic and is the session still moving.
 *
 * Degrades to an empty map rather than throwing, matching `getCliSessions`'s
 * defensive pattern: every caller must render exactly what it did before
 * this telemetry existed (PRD user story 16).
 */
export async function getRunnerSessionsByRunId(
  runs: Iterable<{ id: string | number }>,
): Promise<RunnerSessionsResult> {
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    const docs = await listSessionDocsByRunIds(
      firestore,
      Array.from(runs, (run) => String(run.id)),
    );
    const sessionsByRunId = new Map<string, IssueAgentSessionDoc>();
    for (const doc of docs) {
      if (doc.source !== 'issue-agent' || !doc.runId) continue;
      const held = sessionsByRunId.get(doc.runId);
      if (held === undefined || doc.lastActivityAt > held.lastActivityAt) {
        sessionsByRunId.set(doc.runId, doc);
      }
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
