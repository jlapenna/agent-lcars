import type { RunEvidence } from '@agent-lcars/dispatch-contracts';

import type { Run } from './model';
import type { OrchestratorStore } from './store';

/** A run together with what its worker saw its agent do, when recorded. */
export type RunWithEvidence<T> = T & { evidence?: RunEvidence };

/** Adds each run's recorded evidence for a single item's view. Evidence is a
 * reading aid beside the run, so a store that cannot be read leaves the runs
 * exactly as they were. */
export async function withRunEvidence<T extends Pick<Run, 'runId'>>(
  store: Pick<OrchestratorStore, 'readRunEvidence'>,
  runs: readonly T[],
  onUnreadable?: (error: unknown) => void,
): Promise<RunWithEvidence<T>[]> {
  const evidence = await store
    .readRunEvidence(runs.map((run) => run.runId))
    .catch((error: unknown) => {
      onUnreadable?.(error);
      return new Map<string, RunEvidence>();
    });
  return runs.map((run) => {
    const recorded = evidence.get(run.runId);
    return recorded === undefined ? run : { ...run, evidence: recorded };
  });
}
