import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import {
  isRefusal,
  type RunResult,
  workRevisionSchema,
} from '@agent-lcars/orchestrator';
import { summaryWorkSpecSchema, ulid } from '@agent-lcars/work';
import { z } from 'zod';

import {
  handoffInputSchema,
  handoffMessageHash,
  summaryTitle,
} from './handoff-summary-work';
import {
  handoffSummaryConfig,
  MAX_SUMMARY_MS,
  summarizeHumanNeeded,
} from './human-needed-summary';
import { summarizeInboxDecision } from './inbox-summary-model';
import type { OrchestratorRouteDeps } from './orchestrator-routes';

const sourceSchema = z.union([
  z.object({ workId: z.string().min(1), title: z.string().optional() }),
  z.object({
    repo: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().optional(),
  }),
]);
const inputSchema = z.strictObject({ context: z.string().min(1) });

export async function admitInboxSummary(
  runtime: OrchestratorRouteDeps,
  context: string,
  observedAt: Record<string, string>,
): Promise<{ description?: string; pending: boolean }> {
  const source = sourceSchema.parse(JSON.parse(context));
  // A native card carries the console task key, which already reads
  // `work:<ulid>`; prefixing it again made an unlinkable `work:work:<ulid>`.
  const sourceKey =
    'workId' in source
      ? `work:${source.workId.replace(/^work:/u, '')}`
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
  const spec = summaryWorkSpecSchema.parse({
    title: summaryTitle('Inbox summary', source.title, sourceKey),
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
      const parsed = summaryWorkSpecSchema.safeParse(stored['spec']);
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
 * coding work. Background passes execute at most four attempts. Maintenance
 * executes one within its request deadline, reserving five seconds to settle. */
export async function executeSummaries(
  runtime: OrchestratorRouteDeps,
  generate: typeof summarizeInboxDecision = summarizeInboxDecision,
  deadline?: number,
): Promise<void> {
  try {
    if (!handoffSummaryConfig()) return;
  } catch {
    return;
  }
  const attempts = deadline === undefined ? 4 : 1;
  for (let count = 0; count < attempts; count++) {
    if (deadline !== undefined && deadline - Date.now() <= 5_000) break;
    const fingerprint = createHash('sha256').update(randomUUID()).digest('hex');
    const run = await runtime.store.claimQueuedRun({
      pipelines: ['inbox-summary', 'handoff-summary'],
      now: new Date().toISOString(),
      claimedBy: 'console-model-call',
      claimedBySubject: 'svc:summary',
      tokenHash: fingerprint,
    });
    if (run === undefined) break;
    const renewed = await runtime.orchestrator.renew(
      run.runId,
      fingerprint,
      true,
    );
    if (isRefusal(renewed)) continue;
    const timeoutMs = Math.min(
      MAX_SUMMARY_MS,
      deadline === undefined ? MAX_SUMMARY_MS : deadline - Date.now() - 5_000,
    );
    if (timeoutMs <= 0) {
      await runtime.store.releaseQueuedRunClaim({
        runId: run.runId,
        claimedBy: 'console-model-call',
        tokenHash: fingerprint,
        now: new Date().toISOString(),
      });
      return;
    }
    const modelDeadline = Date.now() + timeoutMs;
    let result: RunResult = {
      ok: false,
      summary: 'summary-unavailable',
    };
    try {
      if (run.pipeline === 'handoff-summary') {
        const input = handoffInputSchema.parse(run.sourceRevision?.input);
        const source = await runtime.store.readRun(input.sourceRunId);
        if (
          source?.state !== 'finished' ||
          source.result?.summary !== 'park' ||
          source.result.message === undefined ||
          handoffMessageHash(source.result.message) !== input.messageHash
        )
          throw new Error('Handoff source changed or unavailable');
        if (Date.now() >= modelDeadline) {
          await runtime.store.releaseQueuedRunClaim({
            runId: run.runId,
            claimedBy: 'console-model-call',
            tokenHash: fingerprint,
            now: new Date().toISOString(),
          });
          return;
        }
        const summarized = await summarizeHumanNeeded(source.result, {
          deadline: modelDeadline + 5_000,
          now: () => new Date(),
        });
        if (summarized.humanNeededActions !== undefined)
          result = {
            ok: true,
            summary: 'handoff-summary',
            humanNeededActions: summarized.humanNeededActions,
          };
      } else {
        const input = inputSchema.parse(run.sourceRevision?.input);
        const description = await generate(input.context, timeoutMs);
        if (description !== undefined)
          result = { ok: true, summary: 'inbox-summary', message: description };
      }
    } catch {
      // Persist a bounded failure, never raw source text or provider output.
    }
    await runtime.orchestrator.report(run.runId, result, fingerprint);
  }
}
