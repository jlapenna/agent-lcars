import { outlineSourceJobSchema } from '@agent-lcars/work';

import type { DeliveredStore } from './delivered-store';
import type { DeliveryLog, InboundDelivery } from './delivery-agent';
import { MAX_DELIVERY_BYTES } from './delivery-message';
import type { DeliveryMetrics, DeliveryOutcome } from './metrics';
import type { OutlineSource } from './outline-source';

/** Multiplex the existing host Pub/Sub pull; there is no new daemon or port. */
export function outlineJobHandler(deps: {
  readonly host: string;
  readonly source?: OutlineSource;
  readonly delivered: DeliveredStore;
  readonly metrics: DeliveryMetrics;
  readonly log: DeliveryLog;
  readonly now: () => number;
  readonly deliver: (message: InboundDelivery) => Promise<DeliveryOutcome>;
}): (message: InboundDelivery) => Promise<DeliveryOutcome> {
  const failed = new Set<string>();
  const active = new Map<string, Promise<void>>();
  return async (message) => {
    if (message.attributes.source !== 'outline') return deps.deliver(message);
    let job;
    try {
      if (
        deps.host !== 'pike' ||
        message.attributes.host !== deps.host ||
        message.data.length > MAX_DELIVERY_BYTES
      )
        throw new Error('Invalid source target');
      job = outlineSourceJobSchema.parse(
        JSON.parse(message.data.toString('utf8')),
      );
    } catch {
      deps.log({
        component: 'outline-source',
        stage: 'intake',
        outcome: 'invalid',
      });
      await message.ack();
      return 'invalid';
    }
    const id =
      job.type === 'outline-event'
        ? job.notice.deliveryId
        : job.type === 'outline-fallback'
          ? job.id
          : `observe:${job.documentId}`;
    const deduplicate = job.type !== 'outline-observe';
    if (deduplicate && deps.delivered.has(id)) {
      await message.ack();
      failed.delete(id);
      deps.metrics.outlineSourcesFailed = failed.size;
      return 'duplicate';
    }
    try {
      if (!deps.source) throw new Error('Outline source is not configured');
      // One actual handler per source id; concurrent Pub/Sub redelivery waits
      // for it, rather than racing two idempotent fallback comment writes.
      let processing = active.get(id);
      if (!processing) {
        processing = deps.source.handle(job);
        active.set(id, processing);
      }
      try {
        await processing;
      } finally {
        if (active.get(id) === processing) active.delete(id);
      }
      if (deduplicate) deps.delivered.record(id, deps.now());
      failed.delete(id);
      deps.metrics.outlineSourcesFailed = failed.size;
      deps.metrics.outlineJobs++;
      deps.metrics.outlineLastSuccess = Math.floor(deps.now() / 1000);
      deps.log({ component: 'outline-source', stage: job.type, outcome: 'ok' });
      await message.ack();
      return 'delivered';
    } catch (error) {
      failed.add(id);
      deps.metrics.outlineSourcesFailed = failed.size;
      deps.metrics.outlineErrors++;
      deps.log({
        component: 'outline-source',
        stage: job.type,
        outcome: 'failed',
        error: error instanceof Error ? error.name : 'error',
      });
      await message.nack();
      return 'retried';
    }
  };
}
