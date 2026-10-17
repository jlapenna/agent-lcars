import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { OrchestratorStore } from '@agent-lcars/orchestrator';
import { toWorkSummary } from '@agent-lcars/work/derive';

import {
  type NativeDecisionCard,
  nativeReportRun,
  REPORT_INBOX_WINDOW_MS,
} from '../app/inbox-card';
import type { WorkPrincipal } from './work-auth';
import { forbiddenReason } from './work-mint';

/** Scan bounded datastore pages so older human decisions never disappear
 * behind newer completed work. GitHub parks use their existing projection,
 * giving an anchor represented by both a task and a label exactly one row.
 * A report that settled within REPORT_INBOX_WINDOW_MS is listed too; older
 * ones stay readable from Work. */
export async function getNativeInboxCards(
  store: OrchestratorStore,
  principal: WorkPrincipal | undefined,
  selectedItemKey?: string,
  now = Date.now(),
): Promise<NativeDecisionCard[]> {
  const cards: NativeDecisionCard[] = [];
  let cursor: string | undefined;
  do {
    const tasks = await store.listNativeTasks(200, cursor);
    const summaries = await Promise.all(
      tasks.map(async ({ task }) =>
        toWorkSummary({
          task,
          runs: await store.listRuns(task.task),
        }),
      ),
    );
    for (const work of summaries) {
      const report = nativeReportRun(work);
      const freshReport =
        report !== undefined &&
        now - Date.parse(report.updatedAt) <= REPORT_INBOX_WINDOW_MS;
      if (
        !('workId' in work.anchor) ||
        (work.state !== 'parked' && !freshReport && work.id !== selectedItemKey)
      )
        continue;
      cards.push({
        work: { ...work, anchor: work.anchor },
        kind: report ? 'report' : 'decision',
        queued: work.state === 'parked' || freshReport,
        // A follow-up on a report starts a new round, as a reply to a park does.
        canReply:
          (work.state === 'parked' || report !== undefined) &&
          principal?.scopes.has('work.operator') === true &&
          forbiddenReason(principal, {
            ...work.spec,
            pipeline: (work.runs.at(-1)?.pipeline ??
              work.spec.pipeline) as typeof work.spec.pipeline,
          }) === undefined,
      });
    }
    const last = tasks.at(-1)?.task.task;
    cursor =
      tasks.length === 200 && last && 'workId' in last
        ? last.workId
        : undefined;
  } while (cursor !== undefined);
  return cards;
}

/** Optional Bridge evidence must not reject its GitHub rendering boundary. */
export async function getNativeInboxEvidence(
  load: () => Promise<{
    store: OrchestratorStore;
    principal: WorkPrincipal | undefined;
  }>,
): Promise<{
  cards: NativeDecisionCard[];
  available: boolean;
  warnings: string[];
}> {
  try {
    const { store, principal } = await load();
    return {
      cards: await getNativeInboxCards(store, principal),
      available: true,
      warnings: [],
    };
  } catch (error) {
    logger.error('agent-lcars: native Inbox count unavailable:', error);
    return {
      cards: [],
      available: false,
      warnings: [
        'Native decisions unavailable; the Inbox count includes GitHub decisions only.',
      ],
    };
  }
}
