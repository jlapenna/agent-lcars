import {
  type OrchestratorStore,
  readRunIssues,
  type Run,
} from '@agent-lcars/orchestrator';
import type { ItemRunView } from '@agent-lcars/work/derive';

/** Only a detail view requests the full admitted source for its rounds. */
export async function withItemRunIssues<T extends ItemRunView>(
  store: OrchestratorStore,
  views: readonly T[],
  runs: readonly Run[],
): Promise<T[]> {
  const issues = await readRunIssues(store, runs);
  return views.map((view) => {
    const issue = issues.get(view.runId);
    return issue === undefined ? view : { ...view, issue };
  });
}
