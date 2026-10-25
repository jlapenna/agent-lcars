import 'server-only';

import { createHash } from 'node:crypto';

import { logger } from '@agent-lcars/logging';
import {
  isRefusal,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
} from '@agent-lcars/orchestrator';
import { summaryWorkSpecSchema, ulid } from '@agent-lcars/work';
import { z } from 'zod';

export const handoffInputSchema = z.strictObject({
  sourceRunId: z.string().min(1),
  messageHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const handoffMessageHash = (message: string) =>
  createHash('sha256').update(message).digest('hex');

/** The completion transaction owns the admission event; retrying its delivery
 * cannot mint a second summary or restart an exhausted generation budget. */
export async function admitHandoffSummary(
  runtime: { store: OrchestratorStore; orchestrator: Orchestrator },
  run: Run,
): Promise<void> {
  if (
    run.state !== 'finished' ||
    run.result?.summary !== 'park' ||
    !run.result.message?.trim()
  )
    return;
  const sourceKey = run.runId;
  const workId = await runtime.store.resolveSourceWorkId(
    `handoff-summary:${sourceKey}`,
    ulid(),
  );
  const input = {
    sourceRunId: run.runId,
    messageHash: handoffMessageHash(run.result.message),
  };
  const spec = summaryWorkSpecSchema.parse({
    title: `Handoff summary: ${run.runId}`,
    description: 'Summarize the human actions in the original settled handoff.',
    pipeline: 'handoff-summary',
    priority: 'background',
    sourceKey,
  });
  const outcome = await runtime.orchestrator.request({
    taskId: { workId },
    requestId: input.messageHash,
    pipeline: spec.pipeline,
    priority: spec.priority,
    work: {
      origin: { principal: 'svc:handoff-summary', channel: 'console' },
      spec,
    },
    sourceRevision: { key: input.messageHash, input },
    isStoredWorkCompatible: (stored) => {
      const parsed = summaryWorkSpecSchema.safeParse(stored['spec']);
      return (
        parsed.success &&
        parsed.data.pipeline === 'handoff-summary' &&
        parsed.data.sourceKey === sourceKey
      );
    },
  });
  if (isRefusal(outcome) && outcome.reason !== 'duplicate-request')
    throw new Error(`Handoff summary admission refused: ${outcome.reason}`);
}

/** A reading projection only. The original terminal result is never rewritten. */
export async function readHandoffActions(
  store: OrchestratorStore,
  run: Pick<Run, 'runId' | 'state' | 'result'>,
) {
  if (run.state !== 'finished' || run.result?.summary !== 'park')
    return undefined;
  if (run.result.humanNeededActions) return run.result.humanNeededActions;
  if (!run.result.message?.trim()) return undefined;
  const workId = await store.readSourceWorkId(`handoff-summary:${run.runId}`);
  if (workId === undefined) return undefined;
  const task = (await store.readTask({ workId }))?.task;
  if (task === undefined) return undefined;
  const summary = await store.readRun(`work:${workId}/r${task.runCount}`);
  const input = handoffInputSchema.safeParse(summary?.sourceRevision?.input);
  return summary?.state === 'finished' &&
    summary.result?.ok &&
    summary.result.summary === 'handoff-summary' &&
    input.success &&
    input.data.sourceRunId === run.runId &&
    input.data.messageHash === handoffMessageHash(run.result.message)
    ? summary.result.humanNeededActions
    : undefined;
}

/** Detail histories expose the reading aid without changing durable outcomes. */
export async function withHandoffActions<
  T extends Pick<Run, 'runId' | 'state' | 'result'>,
>(store: OrchestratorStore, runs: T[]): Promise<T[]> {
  return Promise.all(
    runs.map(async (run) => {
      try {
        const actions = await readHandoffActions(store, run);
        return actions === undefined || run.result === undefined
          ? run
          : { ...run, result: { ...run.result, humanNeededActions: actions } };
      } catch {
        logger.warn('agent-lcars: human-needed summary read unavailable');
        return run;
      }
    }),
  );
}
