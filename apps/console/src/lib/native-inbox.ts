import 'server-only';

import type {
  OrchestratorStore,
  TaskListCursor,
} from '@agent-lcars/orchestrator';

import type { NativeDecisionCard } from '../app/inbox-card';
import type { WorkPrincipal } from './work-auth';
import { forbiddenReason } from './work-mint';
import { listWorkSummaries } from './work-summary';

/** Scan bounded datastore pages so older human decisions never disappear
 * behind newer completed work. GitHub parks use their existing projection,
 * giving an anchor represented by both a task and a label exactly one row. */
export async function getNativeInboxCards(
  store: OrchestratorStore,
  principal: WorkPrincipal | undefined,
  selectedItemKey?: string,
): Promise<NativeDecisionCard[]> {
  const cards: NativeDecisionCard[] = [];
  let cursor: TaskListCursor | undefined;
  do {
    const page = await listWorkSummaries(store, { limit: 200, cursor });
    for (const work of page.items) {
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
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return cards;
}
