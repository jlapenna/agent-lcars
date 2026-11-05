import 'server-only';

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
  console.info(
    JSON.stringify({
      severity: ['dropped_permanent', 'projection_repair_dropped'].includes(
        outcome,
      )
        ? 'ERROR'
        : 'INFO',
      component: 'lcars-webhook',
      tracker: 'linear',
      stage,
      outcome,
    }),
  );
}

export function recordLinearWebhookHealth(enabled: boolean): void {
  console.info(
    JSON.stringify({
      severity: 'INFO',
      component: 'lcars-webhook',
      tracker: 'linear',
      stage: 'health',
      enabled,
    }),
  );
}
