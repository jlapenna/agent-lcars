import { logger } from '@agent-lcars/logging';
import { NextResponse } from 'next/server';

import { readBoundedRequestBody } from '@/lib/bounded-request-body';
import {
  outlineAgentNotice,
  verifyOutlineSignature,
} from '@/lib/outline-agent-events';
import {
  outlineDeliveryEnabled,
  queueOutlineEvent,
} from '@/lib/outline-event-source';

/** The deployed Next server uses HTTP/1; Cloud Run's request envelope is
 * 32 MiB (https://docs.cloud.google.com/run/quotas#request_limits). Do not
 * introduce a smaller document-size policy in this transport adapter. */
export const OUTLINE_WEBHOOK_MAX_BYTES = 32 * 1024 * 1024;

/** Shadow only: authenticate and observe identifiers, never deliver. The
 * existing bridge remains responsible until the explicit cutover. API reads
 * and administrator/creator authorization belong on the trusted host. */
export async function POST(request: Request): Promise<NextResponse> {
  const sourceEnabled =
    process.env.AGENT_LCARS_OUTLINE_SOURCE_ENABLED === 'true';
  const mode = outlineDeliveryEnabled() ? 'live' : 'shadow';
  const report = (outcome: string, fields: Record<string, unknown> = {}) =>
    logger.structured(
      'info',
      'Outline agent event received',
      { component: 'lcars-outline-events', mode, outcome, ...fields },
      { enrich: false },
    );
  const secret = process.env.AGENT_LCARS_OUTLINE_WEBHOOK_SECRET;
  if (!secret) {
    report('disabled');
    return NextResponse.json(
      { error: 'Outline shadow source is not configured' },
      { status: 503 },
    );
  }
  const body = await readBoundedRequestBody(request, OUTLINE_WEBHOOK_MAX_BYTES);
  if (body === undefined) {
    report('oversized');
    return NextResponse.json(
      { error: 'Payload exceeds the deployed request envelope' },
      { status: 413 },
    );
  }
  if (
    !verifyOutlineSignature(
      body,
      request.headers.get('outline-signature'),
      secret,
      Date.now(),
    )
  ) {
    report('unauthorized');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let input: unknown;
  try {
    input = JSON.parse(body.toString('utf8'));
  } catch {
    report('invalid');
    return NextResponse.json({ error: 'Malformed JSON' }, { status: 400 });
  }
  const parsed = outlineAgentNotice(input);
  if (parsed.outcome === 'invalid') {
    report('invalid');
    return NextResponse.json(
      { error: 'Malformed Outline event' },
      { status: 400 },
    );
  }
  if (parsed.outcome === 'ignored') {
    report('ignored');
    return NextResponse.json({ ok: true, mode: 'shadow', outcome: 'ignored' });
  }
  if (sourceEnabled) {
    try {
      await queueOutlineEvent(parsed.notice);
    } catch (error) {
      // Reuse the deployed generic agent-event enqueue alert. A source job
      // that never reached Pub/Sub cannot produce a host-side failure metric.
      logger.structured(
        'error',
        'Outline source enqueue failed',
        {
          component: 'lcars-agent-events',
          stage: 'enqueue',
          outcome: 'failed',
          source: 'outline',
          noticeId: parsed.notice.deliveryId,
          error: error instanceof Error ? error.name : 'error',
        },
        { enrich: false },
      );
      return NextResponse.json(
        { error: 'Outline source is temporarily unavailable' },
        { status: 503 },
      );
    }
  }
  report(sourceEnabled ? 'queued' : 'shadow', { ...parsed.notice });
  return NextResponse.json({
    ok: true,
    mode,
    outcome: sourceEnabled ? 'queued' : 'recorded',
  });
}
