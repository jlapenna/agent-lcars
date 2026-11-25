import 'server-only';

import { logger } from '@agent-lcars/logging';
import {
  type IssueAgentSessionDoc,
  parentSessionIdOf,
  type TokenUsage,
} from '@agent-lcars/telemetry';
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
 * A run can hold several sessions: its agent's own session and every
 * subagent it spawned. See {@link runSession} for how they become one.
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
    const byRun = new Map<string, IssueAgentSessionDoc[]>();
    for (const doc of docs) {
      if (doc.source !== 'issue-agent' || !doc.runId) continue;
      byRun.set(doc.runId, [...(byRun.get(doc.runId) ?? []), doc]);
    }
    const sessionsByRunId = new Map<string, IssueAgentSessionDoc>();
    for (const [runId, sessions] of byRun) {
      const session = runSession(sessions);
      if (session) sessionsByRunId.set(runId, session);
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

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/**
 * One run's sessions as the run's single session (#3496). The run's own
 * session is a root one (no parent); when a provider fallback left several,
 * the most recently active is the one still moving. Its turns, liveness and
 * result describe the run's agent; its tokens become the run's total, adding
 * every subagent session that descends from it, since a subagent's spend is
 * the run's spend.
 */
export function runSession(
  sessions: readonly IssueAgentSessionDoc[],
): IssueAgentSessionDoc | undefined {
  let root: IssueAgentSessionDoc | undefined;
  for (const session of sessions) {
    if (parentSessionIdOf(session) !== undefined) continue;
    if (root === undefined || session.lastActivityAt > root.lastActivityAt) {
      root = session;
    }
  }
  if (root === undefined) return undefined;

  const parentOf = new Map(
    sessions.map((session) => [session.sessionId, parentSessionIdOf(session)]),
  );
  const descendsFromRoot = (sessionId: string): boolean => {
    const seen = new Set<string>();
    let parent = parentOf.get(sessionId);
    while (parent !== undefined && !seen.has(parent)) {
      if (parent === root.sessionId) return true;
      seen.add(parent);
      parent = parentOf.get(parent);
    }
    return false;
  };
  let tokens = root.tokens;
  for (const session of sessions) {
    if (session !== root && descendsFromRoot(session.sessionId)) {
      tokens = addTokens(tokens, session.tokens);
    }
  }
  return tokens === root.tokens ? root : { ...root, tokens };
}
