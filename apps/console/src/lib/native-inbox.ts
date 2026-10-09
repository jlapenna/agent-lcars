import 'server-only';

import type { OrchestratorStore } from '@agent-lcars/orchestrator';
import { toWorkSummary } from '@agent-lcars/work/derive';

import type { NativeDecisionCard } from '../app/inbox-card';
import type { WorkPrincipal } from './work-auth';
import { forbiddenReason } from './work-mint';

/** Scan bounded datastore pages so older human decisions never disappear
 * behind newer completed work. GitHub parks use their existing projection,
 * giving an anchor represented by both a task and a label exactly one row. */
export async function getNativeInboxCards(
  store: OrchestratorStore,
  principal: WorkPrincipal | undefined,
  selectedItemKey?: string,
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
      if (
        !('workId' in work.anchor) ||
        (work.state !== 'parked' && work.id !== selectedItemKey)
      )
        continue;
      cards.push({
        work: { ...work, anchor: work.anchor },
        canReply:
          work.state === 'parked' &&
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
