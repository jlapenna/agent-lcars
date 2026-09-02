import { required } from '@agent-lcars/util-server';
import { NextResponse } from 'next/server';

import {
  isControlPlaneRepository,
  isPushWatchedRepository,
} from '@/lib/deployment';
import { verifyWebhookSignature } from '@/lib/github-webhook-auth';
import { enqueueGitHubWebhook } from '@/lib/hosted-webhook-queue';

const ADMITTED_EVENTS = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'check_run',
  'pull_request_review_thread',
  'push',
]);

// Only the field this route actually reads. Fuller payload parsing and the
// admission decision itself live behind the queue, in the process route's
// `handleWebhookDelivery` (`@/lib/orchestrator-routes.ts`); the legacy
// broker's fuller WebhookEvent shape was retired in #1015 Wave 4. This
// route only needs to know which repository a delivery is for before
// enqueueing it.
interface GitHubWebhookPayload {
  repository?: { id?: number; full_name?: string };
}

function header(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`${name} header is required`);
  return value;
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
    console.warn('agent-lcars: rejected GitHub webhook with bad signature');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deliveryId = header(request, 'x-github-delivery');
  const eventName = header(request, 'x-github-event');
  if (eventName === 'ping' || !ADMITTED_EVENTS.has(eventName)) {
    return NextResponse.json(
      {
        deliveryId,
        eventName,
        outcome: 'ignored',
        reason: eventName === 'ping' ? 'ping' : 'unsupported event',
      },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as GitHubWebhookPayload;
  } catch {
    console.warn('agent-lcars: ignored malformed signed GitHub webhook');
    return NextResponse.json(
      { deliveryId, eventName, outcome: 'ignored', reason: 'malformed JSON' },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const repository = payload.repository?.full_name;
  // `push` is admitted for a separate, narrower repo list
  // (`AGENT_LCARS_PUSH_WATCHED_REPOS`, see `push-watch.ts`) that does not
  // make a repository eligible for the full control-plane dispatch
  // machinery the other admitted events use — a repository can be
  // push-watched without being a control-plane repository at all.
  const admitted =
    repository !== undefined &&
    (eventName === 'push'
      ? isPushWatchedRepository(repository)
      : isControlPlaneRepository(repository));
  if (!admitted) {
    console.info('agent-lcars: ignored webhook outside control plane', {
      deliveryId,
      eventName,
      repository,
    });
    return NextResponse.json(
      {
        deliveryId,
        eventName,
        outcome: 'ignored',
        reason: 'repository outside control plane',
      },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const result = await enqueueGitHubWebhook({
      rawBody,
      deliveryId,
      eventName,
      signature: header(request, 'x-hub-signature-256'),
    });
    console.info('agent-lcars: hosted admission durably queued', result);
    return NextResponse.json(result, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('agent-lcars: hosted admission enqueue failed', error);
    return NextResponse.json(
      { error: 'Hosted admission enqueue failed' },
      { status: 500 },
    );
  }
}
