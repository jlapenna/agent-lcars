import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import {
  type OrchestratorStore,
  readRunIssues,
  type Run,
} from '@agent-lcars/orchestrator';
import type { ItemRunView } from '@agent-lcars/work/derive';

/** Restore full admitted snapshots for non-list responses. */
export async function withItemRunIssues<T extends ItemRunView>(
  store: OrchestratorStore,
  views: readonly T[],
  runs: readonly Run[],
): Promise<(Omit<T, 'issue'> & { issue?: TrackerIssue })[]> {
  const issues = await readRunIssues(store, runs);
  return views.map(({ issue: _display, ...view }) => {
    const issue = issues.get(view.runId);
    return issue === undefined ? view : { ...view, issue };
  });
}
