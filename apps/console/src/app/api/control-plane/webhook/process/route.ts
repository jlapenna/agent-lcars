import { required } from '@agent-lcars/util-server';
import { NextResponse } from 'next/server';

import { verifyWebhookSignature } from '@/lib/github-webhook-auth';
import {
  admitGitHubWebhook,
  type GitHubWebhookPayload,
  PermanentAdmissionError,
} from '@/lib/hosted-admission';

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
  try {
    deliveryId = header(request, 'x-github-delivery');
    eventName = header(request, 'x-github-event');
    let payload: GitHubWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as GitHubWebhookPayload;
    } catch (error) {
      throw new PermanentAdmissionError('Webhook payload is not valid JSON', {
        cause: error,
      });
    }
    const result = await admitGitHubWebhook({
      deliveryId,
      eventName,
      payload,
    });
    console.info('agent-lcars: hosted admission completed', result);
    return NextResponse.json(result, {
      status: 200,
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
