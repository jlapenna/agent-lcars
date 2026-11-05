import 'server-only';

import { logger } from '@agent-lcars/logging';

/** Bounded metadata only: Cloud Logging is the durable source for Homelab's
 * existing node-exporter/Loki monitoring, including HTTP 200 semantic drops. */
export function recordLinearWebhook(
  stage: 'intake' | 'process',
  body: Record<string, unknown>,
  status: number,
): void {
  const outcome =
    status >= 500
      ? 'retry'
      : body['outcome'] === 'dropped_permanent' ||
          body['outcome'] === 'projection_repair_dropped' ||
          body['outcome'] === 'projection_repair_requeued' ||
          body['outcome'] === 'disabled'
        ? body['outcome']
        : status >= 400
          ? 'rejected'
          : 'processed';
  logger.structured(
    ['dropped_permanent', 'projection_repair_dropped'].includes(outcome)
      ? 'error'
      : 'info',
    'LCARS Linear webhook outcome',
    { component: 'lcars-webhook', tracker: 'linear', stage, outcome },
    { enrich: false },
  );
}

export function recordLinearWebhookHealth(enabled: boolean): void {
  logger.structured(
    'info',
    'LCARS Linear webhook health',
    {
      component: 'lcars-webhook',
      tracker: 'linear',
      stage: 'health',
      enabled,
    },
    { enrich: false },
  );
}
