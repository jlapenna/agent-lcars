import { logger } from '@agent-lcars/logging';
import { NextResponse } from 'next/server';

import { readBoundedRequestBody } from '@/lib/bounded-request-body';
import {
  type OutlineAgentNotice,
  outlineAgentNotice,
  parseOutlineSignature,
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

// Reserve two full deliveries per instance, including chunk and Buffer copies
// (128 MiB total at the limit). Keep the slots through decoding and JSON parsing
// to leave the rest of the 2 GiB Console instance available for shared traffic.
const MAX_IN_FLIGHT_DELIVERIES = 2;
// One default Outline worker can send ten tasks concurrently. Queue the
// other eight without pulling their bodies, and leave most of Outline's
// five-second request timeout for upload and verification after admission.
const MAX_WAITING_DELIVERIES = 8;
const MAX_WAIT_MS = 2_000;
let inFlightDeliveries = 0;
const waitingDeliveries = new Set<(admitted: boolean) => void>();

async function acquireDeliverySlot(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (inFlightDeliveries < MAX_IN_FLIGHT_DELIVERIES) {
    inFlightDeliveries++;
    return true;
  }
  if (waitingDeliveries.size >= MAX_WAITING_DELIVERIES) return false;

  return new Promise((resolve) => {
    const finish = (admitted: boolean) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', leaveQueue);
      waitingDeliveries.delete(finish);
      resolve(admitted);
    };
    const leaveQueue = () => finish(false);
    const timeout = setTimeout(leaveQueue, MAX_WAIT_MS);
    waitingDeliveries.add(finish);
    signal.addEventListener('abort', leaveQueue, { once: true });
  });
}

function releaseDeliverySlot(): void {
  // Transfer the slot to the oldest waiter before a new request can take it.
  const next = waitingDeliveries.values().next().value;
  if (next) next(true);
  else inFlightDeliveries--;
}

/** Authenticate the raw body, then hand off only normalized identifiers.
 * API reads and administrator/creator authorization belong on the trusted host. */
export async function POST(request: Request): Promise<NextResponse> {
  if (process.env['MAINTENANCE_MODE'] === 'true') {
    return new NextResponse('System is under maintenance.', { status: 503 });
  }

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
  const signature = parseOutlineSignature(
    request.headers.get('outline-signature'),
    Date.now(),
  );
  if (!signature) {
    report('unauthorized');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await acquireDeliverySlot(request.signal))) {
    report('overloaded');
    return NextResponse.json(
      { error: 'Outline intake is busy' },
      { status: 503, headers: { 'Retry-After': '1' } },
    );
  }
  let notice: OutlineAgentNotice;
  try {
    const body = await readBoundedRequestBody(
      request,
      OUTLINE_WEBHOOK_MAX_BYTES,
    );
    if (body === undefined) {
      report('oversized');
      return NextResponse.json(
        { error: 'Payload exceeds the deployed request envelope' },
        { status: 413 },
      );
    }
    if (!verifyOutlineSignature(body, signature, secret, Date.now())) {
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
      return NextResponse.json({
        ok: true,
        mode,
        outcome: 'ignored',
      });
    }
    notice = parsed.notice;
  } finally {
    releaseDeliverySlot();
  }
  if (sourceEnabled) {
    try {
      await queueOutlineEvent(notice);
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
          noticeId: notice.deliveryId,
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
  report(sourceEnabled ? 'queued' : 'shadow', { ...notice });
  return NextResponse.json({
    ok: true,
    mode,
    outcome: sourceEnabled ? 'queued' : 'recorded',
  });
}
