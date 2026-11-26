import 'server-only';

import { createHash } from 'node:crypto';

import { logger } from '@agent-lcars/logging';
import {
  type AgentEvent,
  agentEventDeliverySchema,
  type OutlineEventNotice,
  type OutlineSourceJob,
  type OutlineSourceReport,
} from '@agent-lcars/work';

import {
  type AgentEventPublisher,
  type AgentEventRoutingDeps,
  defaultAgentEventPublisher,
  routeAgentEvent,
} from './agent-event-routing';
import {
  type OutlineEventStore,
  outlineEventStore,
} from './outline-event-store';

export const OUTLINE_SOURCE_HOST = 'pike';
export function outlineDeliveryEnabled(): boolean {
  return (
    process.env.AGENT_LCARS_OUTLINE_SOURCE_ENABLED === 'true' &&
    process.env.AGENT_LCARS_OUTLINE_DELIVERY_ENABLED === 'true'
  );
}

/** A deterministic UUID prevents a lost fallback response from writing twice. */
export function outlineFallbackId(deliveryId: string): string {
  const bytes = createHash('sha256')
    .update('outline-fallback:')
    .update(deliveryId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function publishOutlineSourceJob(
  job: OutlineSourceJob,
  publisher: AgentEventPublisher = defaultAgentEventPublisher,
): Promise<void> {
  await publisher.publish(Buffer.from(JSON.stringify(job)), {
    host: OUTLINE_SOURCE_HOST,
    source: 'outline',
  });
}

export async function queueOutlineEvent(
  notice: OutlineEventNotice,
  store: OutlineEventStore = outlineEventStore,
  publish: (job: OutlineSourceJob) => Promise<void> = publishOutlineSourceJob,
): Promise<void> {
  await store.saveNotice(notice);
  await publish({ type: 'outline-event', notice });
}

export function normalizedOutlineEvent(notice: OutlineEventNotice): AgentEvent {
  const comment = notice.event.startsWith('comments.');
  return {
    id: `outline.${notice.deliveryId}`,
    key: `outline:doc:${notice.documentId}`,
    kind: comment ? 'comment' : 'edit',
    occurredAt: notice.occurredAt,
    actor: notice.actorId,
    // Outline's commentPath uses commentId, not a document fragment:
    // https://github.com/outline/outline/blob/main/app/utils/routeHelpers.ts
    link: `https://outline.lan.jlapenna.net/doc/${notice.documentId}${comment ? `?commentId=${notice.objectId}` : ''}`,
  };
}

export interface OutlineSourceDependencies {
  readonly store: OutlineEventStore;
  readonly routing: AgentEventRoutingDeps;
  readonly enabled: boolean;
  readonly publish: (job: OutlineSourceJob) => Promise<void>;
  readonly drain?: () => Promise<void>;
}

/** A source result is accepted only for an intake the Console authenticated.
 * The pike identity owns API authorization; the Console owns all routing. */
export async function acceptOutlineSourceReport(
  report: OutlineSourceReport,
  deps: OutlineSourceDependencies,
): Promise<{ eventId: string; delivered: number }> {
  const notice = await deps.store.notice(report.noticeId);
  if (!notice) throw new Error('Outline source notice is unknown');
  await deps.store.observe(notice.documentId, report.agentCreated);
  logger.structured(
    'info',
    'Outline source authorized',
    {
      component: 'lcars-outline-events',
      stage: 'authorize',
      mode: deps.enabled ? 'live' : 'shadow',
      outcome: report.outcome,
      noticeId: notice.deliveryId,
      documentId: notice.documentId,
    },
    { enrich: false },
  );
  const event = normalizedOutlineEvent(notice);
  if (!deps.enabled || report.outcome !== 'accepted' || !report.agentCreated)
    return { eventId: event.id, delivered: 0 };
  const publisher: AgentEventPublisher = {
    publish: async (data, attributes) => {
      const body = agentEventDeliverySchema.parse(
        JSON.parse(data.toString('utf8')),
      );
      if (body.target.type !== 'session')
        throw new Error('Outline delivery target mismatch');
      // Receipt creation precedes publication. A failed publication is retried
      // with the same delivery id; a host can report only its own receipt.
      await deps.store.saveReceipt({
        deliveryId: body.deliveryId,
        host: body.target.host,
        notice,
      });
      const result = await deps.routing.publisher.publish(data, attributes);
      // Persist success before routeAgentEvent can remove an --until target.
      // A lost source-report response must not turn success into fallback.
      await deps.store.markRouted(notice.deliveryId);
      return result;
    },
  };
  const routed = await routeAgentEvent(event, {
    ...deps.routing,
    publisher,
    resumeWork: async (request) => {
      const result = await deps.routing.resumeWork(request);
      if (result.outcome === 'queued' || result.outcome === 'duplicate')
        await deps.store.markRouted(notice.deliveryId);
      return result;
    },
  });
  if (routed.deliveries.some((d) => d.outcome === 'resume-queued'))
    await deps.drain?.();
  if (
    (routed.deliveries.length === 0 ||
      routed.deliveries.every((d) => d.outcome === 'resume-refused')) &&
    (await deps.routing.store.listForKey(event.key)).length === 0 &&
    !(await deps.store.wasRouted(notice.deliveryId)) &&
    (await deps.store.document(notice.documentId))?.everSubscribed
  ) {
    await deps.publish(
      fallbackJob(notice, `unsubscribed:${notice.deliveryId}`),
    );
  }
  return { eventId: event.id, delivered: routed.deliveries.length };
}

function fallbackJob(
  notice: OutlineEventNotice,
  deliveryId: string,
): OutlineSourceJob {
  return {
    type: 'outline-fallback',
    id: outlineFallbackId(deliveryId),
    documentId: notice.documentId,
    ...(notice.event.startsWith('comments.')
      ? { parentCommentId: notice.objectId }
      : {}),
  };
}

export async function queueOutlineFallback(
  deliveryId: string,
  host: string,
  store: OutlineEventStore,
  publish: (job: OutlineSourceJob) => Promise<void>,
): Promise<boolean> {
  const receipt = await store.receipt(deliveryId);
  if (!receipt || receipt.host !== host) return false;
  await publish(fallbackJob(receipt.notice, deliveryId));
  return true;
}
