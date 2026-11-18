import type { RunEvidence } from '@agent-lcars/dispatch-contracts';

import type { Run } from './model';
import type { OrchestratorStore } from './store';

/** A run together with what its worker saw its agent do, when recorded. */
export type RunWithEvidence<T> = T & { evidence?: RunEvidence };

/** How long an item's read waits for its runs' evidence before it is served
 * without it. */
export const RUN_EVIDENCE_READ_BUDGET_MS = 1_500;

/** Adds to each of an item's run views the evidence recorded under that
 * run's own claim. `runs` are the stored runs the views were made from: a
 * view does not carry its run's claim.
 *
 * Evidence is a reading aid beside the run, and the item is already loaded
 * when this is asked. So a lookup that fails, or does not answer within
 * `budgetMs`, leaves the views exactly as they were: the item is never held
 * back for it. Runs that were never claimed cost no lookup at all. */
export async function withRunEvidence<T extends Pick<Run, 'runId'>>(
  store: Pick<OrchestratorStore, 'readRunEvidence'>,
  views: readonly T[],
  runs: readonly Pick<Run, 'runId' | 'queue'>[],
  onUnreadable?: (error: unknown) => void,
  budgetMs = RUN_EVIDENCE_READ_BUDGET_MS,
): Promise<RunWithEvidence<T>[]> {
  const claimed = runs.filter((run) => run.queue?.tokenHash !== undefined);
  if (claimed.length === 0) return [...views];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const evidence = await Promise.race([
    store.readRunEvidence(claimed),
    new Promise<never>((_, late) => {
      timer = setTimeout(
        () => late(new Error(`no answer within ${budgetMs} ms`)),
        budgetMs,
      );
    }),
  ])
    .catch((error: unknown) => {
      onUnreadable?.(error);
      return new Map<string, RunEvidence>();
    })
    .finally(() => clearTimeout(timer));
  return views.map((view) => {
    const recorded = evidence.get(view.runId);
    return recorded === undefined ? view : { ...view, evidence: recorded };
  });
}
