import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';
import { NextResponse } from 'next/server';

import {
  defaultGithubAgentEventDeps,
  routeGithubAgentEvents,
} from '@/lib/github-agent-event-intake';
import { verifyWebhookSignature } from '@/lib/github-webhook-auth';
import {
  MAX_PROCESS_ATTEMPTS,
  parseAttempt,
} from '@/lib/hosted-webhook-policy';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';

/**
 * Cloud Tasks target that routes one GitHub delivery's agent events to
 * subscribed sessions (#3569). The webhook routes queue it after their own
 * handling (`queueGithubAgentEvents`); like `/process`, it re-verifies the
 * delivery's HMAC. A routing failure answers 500 so Cloud Tasks retries the
 * delivery, and the router publishes only what it has not published; past
 * the shared attempt cap the delivery is acknowledged and dropped loudly.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (
    !verifyWebhookSignature(
      rawBody,
      request.headers.get('x-hub-signature-256'),
      required('AGENT_LCARS_WEBHOOK_SECRET'),
    )
  ) {
    logger.warn('agent-lcars: rejected queued agent event with bad signature');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const headers = { 'Cache-Control': 'no-store' };
  const deliveryId = request.headers.get('x-github-delivery')?.trim();
  const eventName = request.headers.get('x-github-event')?.trim();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    payload = undefined;
  }
  if (!deliveryId || !eventName || payload === undefined) {
    // Deterministic for this request: a retry would fail the same way.
    logger.error('agent-lcars: dropping unreadable queued agent event', {
      deliveryId,
      eventName,
    });
    return NextResponse.json(
      { outcome: 'dropped_permanent', deliveryId, eventName },
      { status: 200, headers },
    );
  }

  const attempt = parseAttempt(
    request.headers.get('x-cloudtasks-taskretrycount'),
  );
  try {
    const result = await routeGithubAgentEvents(
      {
        event: eventName,
        deliveryId,
        payload,
        receivedAt: new Date().toISOString(),
      },
      defaultGithubAgentEventDeps(createOrchestratorRuntime()),
    );
    logger.info('agent-lcars: GitHub agent events processed', {
      eventName,
      ...result,
    });
    return NextResponse.json(result, { status: 200, headers });
  } catch (error) {
    if (attempt >= MAX_PROCESS_ATTEMPTS) {
      logger.error(
        `agent-lcars: dropping GitHub agent events for ${eventName}/${deliveryId} after ${attempt} failed attempts`,
        error,
      );
      return NextResponse.json(
        { outcome: 'dropped_after_retries', deliveryId, attempt },
        { status: 200, headers },
      );
    }
    logger.error(
      `agent-lcars: GitHub agent event routing failed for ${eventName}/${deliveryId}`,
      error,
    );
    return NextResponse.json(
      { error: 'Agent event routing failed', attempt },
      { status: 500, headers },
    );
  }
}
