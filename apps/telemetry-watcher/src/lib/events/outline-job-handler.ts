import { outlineSourceJobSchema } from '@agent-lcars/work';

import type { DeliveredStore } from './delivered-store';
import type { DeliveryLog, InboundDelivery } from './delivery-agent';
import { MAX_DELIVERY_BYTES } from './delivery-message';
import type { DeliveryMetrics, DeliveryOutcome } from './metrics';
import {
  type openOutlineJobInbox,
  type OutlineJobEntry,
  outlineJobId,
} from './outline-job-inbox';
import type { OutlineSource } from './outline-source';

const OUTLINE_SOURCE_CONCURRENCY = 2;
const OUTLINE_RETRY_MS = 30_000;
// Match the broker's retention for work that never succeeds.
const OUTLINE_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** The Pub/Sub lease covers parse and durable admission only. The local
 * queue owns the separate budget for debounce, API calls and reports. */
export function outlineJobHandler(deps: {
  readonly host: string;
  readonly outline?: {
    readonly source: Pick<OutlineSource, 'handle'>;
    readonly inbox: ReturnType<typeof openOutlineJobInbox>;
  };
  readonly delivered: DeliveredStore;
  readonly metrics: DeliveryMetrics;
  readonly log: DeliveryLog;
  readonly now: () => number;
  readonly deliver: (message: InboundDelivery) => Promise<DeliveryOutcome>;
}) {
  const { outline, metrics } = deps;
  const retryAt = new Map<string, number>();
  const active = new Map<string, Promise<void>>();
  let admissionFailed = false;
  let stopped = false;

  const refreshMetrics = () => {
    let oldest = Infinity;
    for (const entry of outline?.inbox.entries.values() ?? [])
      oldest = Math.min(oldest, entry.publishedAt);
    metrics.outlineInFlight = outline?.inbox.entries.size ?? 0;
    metrics.outlineOldestPending = Number.isFinite(oldest)
      ? Math.floor(oldest / 1000)
      : 0;
    metrics.outlineSourcesFailed = retryAt.size + Number(admissionFailed);
  };

  const pump = () => {
    if (stopped || !outline) return;
    const now = deps.now();
    for (const [id, entry] of outline.inbox.entries) {
      if (active.size >= OUTLINE_SOURCE_CONCURRENCY) break;
      const documentId =
        entry.job.type === 'outline-event'
          ? entry.job.notice.documentId
          : entry.job.documentId;
      // Serialize active reads and writes per document. A failed job waiting
      // for retry must not block later notices for the same document.
      if (active.has(documentId) || (retryAt.get(id) ?? 0) > now) continue;
      active.set(
        documentId,
        processEntry(outline, id, entry).finally(() => {
          active.delete(documentId);
          refreshMetrics();
          pump();
        }),
      );
    }
    refreshMetrics();
  };

  const processEntry = async (
    { inbox, source }: NonNullable<typeof outline>,
    id: string,
    entry: OutlineJobEntry,
  ) => {
    const { job, publishedAt } = entry;
    const deduplicate = job.type !== 'outline-observe';
    try {
      if (deps.now() - publishedAt >= OUTLINE_RETENTION_MS) {
        deps.log({
          component: 'outline-source',
          stage: job.type,
          outcome: 'expired',
        });
      } else if (!deduplicate || !deps.delivered.has(id)) {
        await source.handle(job);
        if (deduplicate) deps.delivered.record(id, deps.now());
        metrics.outlineJobs++;
        metrics.outlineLastSuccess = Math.floor(deps.now() / 1000);
        deps.log({
          component: 'outline-source',
          stage: job.type,
          outcome: 'ok',
        });
      }
      inbox.remove(id);
      retryAt.delete(id);
    } catch (error) {
      retryAt.set(id, deps.now() + OUTLINE_RETRY_MS);
      metrics.outlineErrors++;
      deps.log({
        component: 'outline-source',
        stage: job.type,
        outcome: 'failed',
        error: error instanceof Error ? error.name : 'error',
      });
    }
  };

  async function handle(message: InboundDelivery): Promise<DeliveryOutcome> {
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

    const id = outlineJobId(job);
    if (job.type !== 'outline-observe' && deps.delivered.has(id)) {
      await message.ack();
      return 'duplicate';
    }
    try {
      if (stopped || !outline) throw new Error('Outline inbox is unavailable');
      outline.inbox.enqueue(id, {
        job,
        publishedAt: message.publishTime.getTime(),
      });
      admissionFailed = false;
    } catch (error) {
      admissionFailed = true;
      refreshMetrics();
      metrics.outlineErrors++;
      deps.log({
        component: 'outline-source',
        stage: 'intake',
        outcome: 'failed',
        error: error instanceof Error ? error.name : 'error',
      });
      await message.nack();
      return 'retried';
    }
    // A lost ACK can cause redelivery. The pending entry or processed id
    // already covers it, so leave the admitted work available for processing.
    const acknowledged = message.ack();
    pump();
    await acknowledged;
    return 'delivered';
  }

  return {
    handle,
    pump,
    stop: async () => {
      stopped = true;
      await Promise.all(active.values());
    },
  };
}
