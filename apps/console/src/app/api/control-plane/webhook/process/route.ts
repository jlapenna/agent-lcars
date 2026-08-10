import { required } from '@agent-lcars/util-server';
import { NextResponse } from 'next/server';

import { verifyWebhookSignature } from '@/lib/github-webhook-auth';
import {
  admitGitHubWebhook,
  type GitHubWebhookPayload,
} from '@/lib/hosted-admission';
import {
  identifyWebhookIngressCanary,
  parseCloudTasksAttempt,
  recordWebhookIngressProcessed,
  recordWebhookIngressProcessing,
  recordWebhookIngressProcessorFailure,
  type WebhookIngressCanaryIdentity,
} from '@/lib/webhook-ingress-receipt';

function header(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`${name} header is required`);
  return value;
}

// A delivery that keeps failing this many times is a poison pill (e.g. a
// deterministically unparseable payload), not a transient outage: returning
// 500 forever keeps Cloud Tasks redelivering it every few seconds
// indefinitely (observed 2026-08-08..10: eight pull_request:labeled
// deliveries at 800+ attempts each, ~10s apart, for 31 hours — the queue's
// own max-attempts did not stop them). Past this bound the delivery is
// acked and dropped with a loud log; the reconcile scan rebuilds any state
// the event carried from GitHub itself.
const MAX_PROCESS_ATTEMPTS = 10;

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

  let canary: WebhookIngressCanaryIdentity | undefined;
  const attempt = parseCloudTasksAttempt(
    request.headers.get('x-cloudtasks-taskretrycount'),
  );
  try {
    const deliveryId = header(request, 'x-github-delivery');
    const eventName = header(request, 'x-github-event');
    const payload = JSON.parse(
      rawBody.toString('utf8'),
    ) as GitHubWebhookPayload;
    canary = identifyWebhookIngressCanary(deliveryId, eventName, payload);
    if (canary) {
      await recordWebhookIngressProcessing(canary, attempt);
    }
    const result = await admitGitHubWebhook({
      deliveryId,
      eventName,
      payload,
    });
    if (canary) await recordWebhookIngressProcessed(canary);
    console.info('agent-lcars: hosted admission completed', result);
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (canary) {
      try {
        await recordWebhookIngressProcessorFailure(canary, attempt, error);
      } catch (receiptError) {
        console.error(
          'agent-lcars: failed to record webhook canary processor failure',
          receiptError,
        );
      }
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
    console.error('agent-lcars: hosted admission failed', error);
    return NextResponse.json(
      { error: 'Hosted admission failed' },
      { status: 500 },
    );
  }
}
