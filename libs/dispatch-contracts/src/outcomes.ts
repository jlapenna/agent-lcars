/**
 * Durable worker-result categories the console can actually derive.
 *
 * The orchestrator's completion boundary collapses the worker's
 * fine-grained wire vocabulary (startup/trajectory/outcome-gate failures,
 * park, no-op, comment, review, closed - see `orchestrator-routes.ts`'s
 * `OK_OUTCOMES`, a separate wire-string constant) into `RunResult`'s
 * boolean `ok` plus an optional PR `ref`. Only these three kinds are
 * therefore reconstructible on the console side
 * (`outcomeFromRunResult` in `apps/console/src/lib/task-detail.ts`);
 * an unsuccessful run reports no outcome kind at all.
 */
export type DispatchOutcomeKind =
  'pull-request' | 'merged-deliverable' | 'unknown-success';
