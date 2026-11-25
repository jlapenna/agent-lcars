import {
  executionPhase,
  type ExecutionRun,
} from '@agent-lcars/dispatch-contracts';

import { ExecutionStatusClock } from './execution-status-clock';

export { EXECUTION_CLOCK_TICK_MS } from './execution-status-clock';

/** Shared placement/start presentation for Agents, canonical task and Work.
 *
 * Callers hold whole run records (results, evidence, transcripts). A client
 * component serializes every prop into the page payload, so this server-side
 * wrapper sends the clock only `state` and `queue`, the fields the execution
 * phase reads. A settled run has no phase at any time, so it renders nothing
 * and sends nothing. */
export function ExecutionStatus({ run }: { run: ExecutionRun }) {
  if (executionPhase(run) === undefined) return null;
  return (
    <ExecutionStatusClock
      run={
        run.queue === undefined
          ? { state: run.state }
          : { state: run.state, queue: run.queue }
      }
    />
  );
}
