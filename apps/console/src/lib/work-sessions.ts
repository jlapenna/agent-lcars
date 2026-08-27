import 'server-only';

import type { SessionDoc } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  getSessionDoc,
  listSessionDocs,
} from '@agent-lcars/telemetry/server';
import type { ItemSessionView } from '@agent-lcars/work/derive';

/**
 * Joins a native work item's runs to the agent telemetry they produced.
 *
 * The join key is `IssueAgentSessionDoc.intentId`, which the runner-mode
 * shipper writes as the orchestrator run id (`work:<ulid>/rN`) -- the same
 * value the item view carries as `ItemRunView.runId`. One equality query
 * per run, deliberately: `intentId` alone is an automatic single-field
 * index, while an `in` query over many run ids plus the `source` filter
 * would need a composite one, and an item has a handful of runs at most.
 *
 * Reads through `getAgentTelemetryReaderFirestore` -- the same read-only
 * accessor `runner-sessions.ts` uses -- rather than opening a second
 * client against the same database.
 *
 * Degrades to an empty list rather than throwing, matching
 * `getRunnerSessionsByRunId`: telemetry is a decoration on the item view,
 * and an unreachable telemetry store must not turn a perfectly good
 * `GET /items/{id}` into a 500.
 */
export async function sessionsForRuns(
  runIds: readonly string[],
): Promise<ItemSessionView[]> {
  if (runIds.length === 0) return [];

  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    const perRun = await Promise.all(
      runIds.map((intentId) =>
        listSessionDocs(firestore, { intentId, source: 'issue-agent' }),
      ),
    );
    return perRun.flat().flatMap((doc) => {
      // `intentId` lives on IssueAgentSessionDoc only; the source filter
      // above already restricts the query, and this narrows the union.
      if (doc.source !== 'issue-agent' || doc.intentId === undefined) return [];
      return [
        {
          sessionId: doc.sessionId,
          runId: doc.intentId,
          startedAt: doc.startedAt,
          lastActivityAt: doc.lastActivityAt,
          ...(doc.title === undefined ? {} : { title: doc.title }),
          ...(doc.status === undefined ? {} : { status: doc.status }),
          ...(doc.transcriptGcsUri === undefined
            ? {}
            : { transcriptGcsUri: doc.transcriptGcsUri }),
        },
      ];
    });
  } catch (error) {
    console.error('agent-lcars: failed to list work item sessions:', error);
    return [];
  }
}

/**
 * Reads one session doc by id, for `redispatch`'s `resumeSessionId`
 * validation (sub-project 6). Read-only, the same accessor `sessionsForRuns`
 * uses; degrades to `undefined` on any failure rather than throwing -- a
 * lookup failure here becomes the handler's own BAD_REQUEST, not a 500.
 */
export async function sessionForResume(
  sessionId: string,
): Promise<SessionDoc | undefined> {
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    return await getSessionDoc(firestore, sessionId);
  } catch (error) {
    console.error('agent-lcars: failed to read session for resume:', error);
    return undefined;
  }
}
