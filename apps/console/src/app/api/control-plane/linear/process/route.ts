import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';
import { revalidateTag } from 'next/cache';

import { AUTHORITATIVE_QUEUE_TAG } from '@/lib/cache-tags';
import {
  MAX_PROCESS_ATTEMPTS,
  MAX_REPAIR_GENERATIONS,
  parseAttempt,
  parseRepairGeneration,
  PermanentAdmissionError,
  repairSuccessorDelayMs,
} from '@/lib/hosted-webhook-policy';
import { enqueueLinearWebhook } from '@/lib/hosted-webhook-queue';
import { linearConfig } from '@/lib/linear-config';
import { admitLinearWebhook, verifyLinearSignature } from '@/lib/linear-intake';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';
import { googleIdTokenVerifier } from '@/lib/work-auth';

export async function POST(request: Request): Promise<Response> {
  const respond = (body: Record<string, unknown>, status: number) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const audience = `${required('AUTH_URL').replace(/\/$/u, '')}/api/control-plane/linear/process`;
  const bearer = request.headers
    .get('authorization')
    ?.match(/^Bearer (.+)$/u)?.[1];
  try {
    if (!bearer) return respond({ error: 'Unauthorized' }, 401);
    const identity = await googleIdTokenVerifier(audience)(bearer);
    if (
      !identity.emailVerified ||
      identity.email !== required('AGENT_LCARS_WEBHOOK_TASK_SERVICE_ACCOUNT')
    )
      return respond({ error: 'Unauthorized' }, 401);
  } catch {
    return respond({ error: 'Unauthorized' }, 401);
  }
  const rawBody = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get('linear-signature');
  const attempt = parseAttempt(
    request.headers.get('x-cloudtasks-taskretrycount'),
  );
  let repairGeneration = 0;
  try {
    repairGeneration = parseRepairGeneration(
      request.headers.get('x-agent-lcars-projection-repair-generation'),
    );
    const config = linearConfig();
    if (!config) return respond({ outcome: 'disabled' }, 200);
    if (
      !verifyLinearSignature(
        rawBody,
        signature,
        required('AGENT_LCARS_LINEAR_WEBHOOK_SECRET'),
      )
    )
      throw new PermanentAdmissionError(
        'Queued Linear signature no longer verifies',
      );
    const runtime = createOrchestratorRuntime();
    const result = await admitLinearWebhook(
      rawBody,
      config,
      runtime,
      Date.now(),
      {
        authenticatedQueueDelivery: true,
        reconcileTriage: (issue, repo) =>
          issue.reference.tracker === 'linear'
            ? (runtime.reconcileIssueTriage?.(
                { repo, source: issue.reference },
                false,
              ) ?? Promise.resolve())
            : Promise.resolve(),
      },
    );
    await runtime.drain();
    revalidateTag(AUTHORITATIVE_QUEUE_TAG, 'max');
    return respond(result.body, result.status >= 500 ? result.status : 200);
  } catch (error) {
    if (error instanceof PermanentAdmissionError) {
      logger.error(
        'agent-lcars: dropping permanently-unprocessable Linear delivery',
        { attempt, reason: error.message },
      );
      return respond({ outcome: 'dropped_permanent', attempt }, 200);
    }
    if (attempt >= MAX_PROCESS_ATTEMPTS) {
      if (repairGeneration >= MAX_REPAIR_GENERATIONS) {
        logger.error(
          'agent-lcars: Linear projection repair budget exhausted; explicit refresh or a new issue event is required',
          { attempt, repairGeneration },
        );
        return respond(
          { outcome: 'projection_repair_dropped', attempt, repairGeneration },
          200,
        );
      }
      try {
        const generation = repairGeneration + 1;
        await enqueueLinearWebhook(rawBody, signature as string, undefined, {
          generation,
          notBefore: new Date(Date.now() + repairSuccessorDelayMs(generation)),
        });
        logger.error(
          'agent-lcars: deferred Linear projection repair after bounded attempts',
          { attempt, repairGeneration: generation },
        );
        return respond({ outcome: 'projection_repair_requeued', attempt }, 200);
      } catch {
        logger.error(
          'agent-lcars: Linear repair enqueue failed; retaining current durable delivery',
        );
        return respond({ error: 'Linear repair enqueue failed' }, 500);
      }
    }
    logger.error(
      'agent-lcars: queued Linear delivery failed; Cloud Tasks will retry',
      { attempt },
    );
    return respond({ error: 'Linear processing failed' }, 500);
  }
}
