import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { isRefusal, workRevisionSchema } from '@agent-lcars/orchestrator';
import { inboxSummarySpecSchema, ulid } from '@agent-lcars/work';
import { z } from 'zod';

import { handoffSummaryConfig } from './human-needed-summary';
import { summarizeInboxDecision } from './inbox-summary-model';
import type { OrchestratorRouteDeps } from './orchestrator-routes';

const sourceSchema = z.union([
  z.object({ workId: z.string().min(1) }),
  z.object({ repo: z.string().min(1), number: z.number().int().positive() }),
]);
const inputSchema = z.strictObject({ context: z.string().min(1) });

export async function admitInboxSummary(
  runtime: OrchestratorRouteDeps,
  context: string,
  observedAt: Record<string, string>,
): Promise<{ description?: string; pending: boolean }> {
  const source = sourceSchema.parse(JSON.parse(context));
  const sourceKey =
    'workId' in source
      ? `work:${source.workId}`
      : `${source.repo}#${source.number}`;
  const workId = await runtime.store.resolveSourceWorkId(
    `inbox-summary:${sourceKey}`,
    ulid(),
  );
  const revision = workRevisionSchema.parse({
    key: createHash('sha256')
      .update(JSON.stringify([context, observedAt]))
      .digest('hex'),
    input: { context },
    observedAt,
  });
  const spec = inboxSummarySpecSchema.parse({
    title: `Inbox summary: ${sourceKey}`,
    description:
      'Explain the current decision or report using its original source context.',
    pipeline: 'inbox-summary',
    priority: 'background',
    sourceKey,
  });
  const outcome = await runtime.orchestrator.request({
    taskId: { workId },
    requestId: revision.key,
    pipeline: spec.pipeline,
    priority: spec.priority,
    work: {
      origin: { principal: 'svc:inbox-summary', channel: 'console' },
      spec,
    },
    sourceRevision: revision,
    isStoredWorkCompatible: (stored) => {
      const parsed = inboxSummarySpecSchema.safeParse(stored['spec']);
      return parsed.success && parsed.data.sourceKey === sourceKey;
    },
  });
  if (isRefusal(outcome) && outcome.reason !== 'duplicate-request')
    throw new Error(`Inbox summary admission refused: ${outcome.reason}`);
  const task = (await runtime.store.readTask({ workId }))?.task;
  if (task === undefined) throw new Error('Admitted summary is missing');
  const latest = await runtime.store.readRun(
    `work:${workId}/r${task.runCount}`,
  );
  const current =
    task.desiredRevision?.input['context'] === context &&
    latest?.sourceRevision?.key === task.desiredRevision?.key;
  return {
    ...(current &&
    latest.state === 'finished' &&
    latest.result?.ok &&
    latest.result.summary === 'inbox-summary'
      ? { description: latest.result.message }
      : {}),
    pending: task.activeRunId !== undefined,
  };
}

/** Uses the same durable claims, token fencing and completion transactions as
 * coding work. A request executes at most four 30-second model attempts. */
export async function executeInboxSummaries(
  runtime: OrchestratorRouteDeps,
  generate: typeof summarizeInboxDecision = summarizeInboxDecision,
): Promise<void> {
  try {
    if (!handoffSummaryConfig()) return;
  } catch {
    return;
  }
  for (let count = 0; count < 4; count++) {
    const fingerprint = createHash('sha256').update(randomUUID()).digest('hex');
    const run = await runtime.store.claimQueuedRun({
      pipelines: ['inbox-summary'],
      now: new Date().toISOString(),
      claimedBy: 'console-model-call',
      claimedBySubject: 'svc:inbox-summary',
      tokenHash: fingerprint,
    });
    if (run === undefined) break;
    const renewed = await runtime.orchestrator.renew(
      run.runId,
      fingerprint,
      true,
    );
    if (isRefusal(renewed)) continue;
    let description: string | undefined;
    try {
      const input = inputSchema.parse(run.sourceRevision?.input);
      description = await generate(input.context);
    } catch {
      // Persist a bounded failure, never raw source text or provider output.
    }
    await runtime.orchestrator.report(
      run.runId,
      description === undefined
        ? { ok: false, summary: 'summary-unavailable' }
        : { ok: true, summary: 'inbox-summary', message: description },
      fingerprint,
    );
  }
}
