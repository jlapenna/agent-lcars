import { required } from '@agent-lcars/util-server';
import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

import { AUTHORITATIVE_QUEUE_TAG } from '@/lib/cache-tags';
import { verifyWebhookSignature } from '@/lib/github-webhook-auth';
import { enqueueGitHubWebhook } from '@/lib/hosted-webhook-queue';
import {
  handleWebhookDelivery,
  ProjectionRefreshError,
} from '@/lib/orchestrator-routes';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';

/**
 * Thrown for admission failures that are deterministic given the delivered
 * request -- a missing header, malformed JSON. Retrying buys nothing, so
 * the handler below acks these immediately instead of letting Cloud Tasks
 * hammer the same poisoned delivery forever (agent-lcars#958). Contrast
 * with an unwrapped `Error` (orchestrator/Firestore/GitHub API failures),
 * which stays on the retryable 5xx path.
 */
class PermanentAdmissionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentAdmissionError';
  }
}

function header(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) {
    throw new PermanentAdmissionError(`${name} header is required`);
  }
  return value;
}

// Defense-in-depth backstop for failures not (yet) recognized as a
// PermanentAdmissionError above: a delivery that keeps failing this many
// times is a poison pill, not a transient outage (returning 500 forever
// keeps Cloud Tasks redelivering it every few seconds indefinitely --
// observed 2026-08-08..10: eight pull_request:labeled deliveries at 800+
// attempts each, ~10s apart, for 31 hours; the queue's own max-attempts did
// not stop them, and agent-lcars#958's incident later showed 1,346
// dispatches on a single task even with this cap in place -- classifying the
// error itself, above, is the primary defense). Past this bound the
// delivery is acked and dropped with a loud log; the reconcile scan
// rebuilds any state the event carried from GitHub itself.
const MAX_PROCESS_ATTEMPTS = 10;

function parseAttempt(retryCount: string | null): number {
  if (retryCount === null || !/^\d+$/u.test(retryCount)) return 1;
  const parsed = Number(retryCount);
  return Number.isSafeInteger(parsed) ? parsed + 1 : 1;
}

/** The durable repair generation is carried separately from Cloud Tasks'
 * per-task retry count. A successor begins at retry one, so reusing the
 * retry count would recreate the same named repair task after every
 * lifecycle. This header is supplied only by our task enqueue path; malformed
 * values are a deterministic delivery error rather than a reason to choose an
 * arbitrary task name. */
function parseRepairGeneration(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d+$/u.test(value)) {
    throw new PermanentAdmissionError(
      'x-agent-lcars-projection-repair-generation must be a nonnegative integer',
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PermanentAdmissionError(
      'x-agent-lcars-projection-repair-generation must be a safe integer',
    );
  }
  return parsed;
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (
    !verifyWebhookSignature(
      rawBody,
      request.headers.get('x-hub-signature-256'),
      required('AGENT_LCARS_WEBHOOK_SECRET'),
    )
  ) {
    console.warn('agent-lcars: rejected queued webhook with bad signature');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const attempt = parseAttempt(
    request.headers.get('x-cloudtasks-taskretrycount'),
  );
  let deliveryId: string | undefined;
  let eventName: string | undefined;
  let repairGeneration = 0;
  try {
    deliveryId = header(request, 'x-github-delivery');
    eventName = header(request, 'x-github-event');
    repairGeneration = parseRepairGeneration(
      request.headers.get('x-agent-lcars-projection-repair-generation'),
    );
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
      throw new PermanentAdmissionError('Webhook payload is not valid JSON', {
        cause: error,
      });
    }
    const result = await handleWebhookDelivery(
      {
        ...createOrchestratorRuntime(),
        // Unlike a Server Action, a Route Handler does not promise
        // read-your-own-writes. Mark the projection cache stale only after the
        // webhook has written its durable snapshot, so a post-mutation render
        // cannot refill this tag from the pre-webhook projection.
        invalidateAuthoritativeQueue: () =>
          revalidateTag(AUTHORITATIVE_QUEUE_TAG, 'max'),
      },
      {
        event: eventName,
        deliveryId,
        payload,
      },
    );
    console.info(
      'agent-lcars: orchestrator webhook delivery processed',
      result,
    );
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof PermanentAdmissionError) {
      // Deterministic given this payload -- every future retry throws the
      // same way. Ack now so Cloud Tasks stops redelivering, but log loudly
      // (structured, severity ERROR) so the drop stays observable; the
      // reconcile scan rebuilds any state the event carried from GitHub
      // itself.
      console.error(
        JSON.stringify({
          severity: 'ERROR',
          message:
            'agent-lcars: dropping permanently-unprocessable webhook delivery',
          deliveryId,
          eventName,
          attempt,
          reason: error.message,
        }),
      );
      return NextResponse.json(
        { outcome: 'dropped_permanent', deliveryId, eventName, attempt },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (error instanceof ProjectionRefreshError) {
      // Unlike an admission failure, this delivery has not created work and
      // may be the only durable signal for a close/delete. Keep the queued
      // task retryable past the generic poison-delivery acknowledgement cap.
      if (attempt >= MAX_PROCESS_ATTEMPTS) {
        // Cloud Tasks itself has a finite retry lifecycle. Before this task
        // can be retired, create a separately named durable successor with
        // the same authenticated envelope and a fresh queue retry budget.
        // If this enqueue fails, return 500 so the current task remains.
        await enqueueGitHubWebhook({
          rawBody,
          deliveryId: deliveryId as string,
          eventName: eventName as string,
          signature: header(request, 'x-hub-signature-256'),
          repairGeneration: repairGeneration + 1,
        });
        console.error(
          `agent-lcars: handed projection-only webhook repair generation ${repairGeneration + 1} to a durable successor after ${attempt} attempts`,
          error,
        );
        return NextResponse.json(
          { outcome: 'projection_repair_requeued', attempt },
          { status: 200, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      console.error(
        `agent-lcars: retaining projection-only webhook repair after ${attempt} attempts`,
        error,
      );
      return NextResponse.json(
        { error: 'Projection refresh pending repair', attempt },
        { status: 500 },
      );
    }
    if (attempt >= MAX_PROCESS_ATTEMPTS) {
      console.error(
        `agent-lcars: dropping webhook delivery after ${attempt} failed attempts; reconcile will heal any state it carried`,
        error,
      );
      return NextResponse.json(
        { outcome: 'dropped_after_retries', attempt },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    console.error('agent-lcars: orchestrator webhook delivery failed', error);
    return NextResponse.json(
      { error: 'Hosted admission failed' },
      { status: 500 },
    );
  }
}
