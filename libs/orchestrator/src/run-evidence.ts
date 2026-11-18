import type { RunEvidence } from '@agent-lcars/dispatch-contracts';

import type { Run } from './model';
import type { OrchestratorStore } from './store';

/** A run together with what its worker saw its agent do, when recorded. */
export type RunWithEvidence<T> = T & { evidence?: RunEvidence };

/** Adds to each of an item's run views the evidence recorded under that
 * run's own claim. `runs` are the stored runs the views were made from: a
 * view does not carry its run's claim. Evidence is a reading aid beside the
 * run, so a store that cannot be read leaves the views exactly as they
 * were. */
export async function withRunEvidence<T extends Pick<Run, 'runId'>>(
  store: Pick<OrchestratorStore, 'readRunEvidence'>,
  views: readonly T[],
  runs: readonly Pick<Run, 'runId' | 'queue'>[],
  onUnreadable?: (error: unknown) => void,
): Promise<RunWithEvidence<T>[]> {
  const evidence = await store.readRunEvidence(runs).catch((error: unknown) => {
    onUnreadable?.(error);
    return new Map<string, RunEvidence>();
  });
  return views.map((view) => {
    const recorded = evidence.get(view.runId);
    return recorded === undefined ? view : { ...view, evidence: recorded };
  });
}
