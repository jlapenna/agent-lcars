import * as http from 'node:http';

import type { SessionReportKind } from './subscribe-forwarder';
import {
  UNDELIVERABLE_REASONS,
  type UndeliverableReason,
} from './terminal-target';

/**
 * Prometheus metrics for the delivery agent, served on loopback.
 *
 * Idle is distinct from failure: `configured` says whether this host has a
 * subscription credential at all, `stream_open` whether the streaming pull
 * is up, and `in_flight` whether any delivery is waiting. A configured agent
 * with an open stream, nothing in flight and no deliveries is idle, not
 * broken; a configured agent whose last successful pull is old is broken.
 */
export const DELIVERY_OUTCOMES = [
  'delivered',
  'undeliverable',
  'retried',
  'invalid',
  'duplicate',
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** Session reports: reported; retried (will try again); rejected (LCARS
 * refused it, so it is not retried); failed (given up after retries). */
export const SESSION_REPORT_OUTCOMES = [
  'reported',
  'retried',
  'rejected',
  'failed',
] as const;
export type SessionReportOutcome = (typeof SESSION_REPORT_OUTCOMES)[number];

/** Seconds from the router publishing a delivery to its turn starting. */
const LATENCY_BUCKETS = [1, 5, 15, 30, 60, 300, 900, 3_600, 21_600] as const;

const PREFIX = 'lcars_events_agent';

export class DeliveryMetrics {
  configured = 0;
  streamOpen = 0;
  inFlight = 0;
  /** Unix seconds; 0 until the first successful pull. */
  lastSuccessfulPull = 0;
  streamErrors = 0;
  readonly deliveries = new Map<DeliveryOutcome, number>(
    DELIVERY_OUTCOMES.map((outcome) => [outcome, 0]),
  );
  readonly undeliverable = new Map<UndeliverableReason, number>(
    UNDELIVERABLE_REASONS.map((reason) => [reason, 0]),
  );
  /** Local subscribe, list and unsubscribe requests, by `op` and
   * `outcome` (`ok` or the error code the CLI was given). */
  readonly localRequests = new Map<string, number>();
  /** Session idle and ended reports to LCARS, by kind and outcome. */
  readonly sessionReports = new Map<string, number>(
    (['idle', 'ended'] as const).flatMap((kind) =>
      SESSION_REPORT_OUTCOMES.map((outcome) => [`${kind}\u0000${outcome}`, 0]),
    ),
  );
  private readonly latencyBuckets = LATENCY_BUCKETS.map(() => 0);
  private latencyCount = 0;
  private latencySum = 0;

  count(outcome: DeliveryOutcome): void {
    this.deliveries.set(outcome, (this.deliveries.get(outcome) ?? 0) + 1);
  }

  countUndeliverable(reason: UndeliverableReason): void {
    this.undeliverable.set(reason, (this.undeliverable.get(reason) ?? 0) + 1);
  }

  countLocalRequest(op: string, outcome: string): void {
    const key = `${op}\u0000${outcome}`;
    this.localRequests.set(key, (this.localRequests.get(key) ?? 0) + 1);
  }

  countSessionReport(
    kind: SessionReportKind,
    outcome: SessionReportOutcome,
  ): void {
    const key = `${kind}\u0000${outcome}`;
    this.sessionReports.set(key, (this.sessionReports.get(key) ?? 0) + 1);
  }

  observeLatency(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    LATENCY_BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) this.latencyBuckets[index] += 1;
    });
    this.latencyCount += 1;
    this.latencySum += seconds;
  }

  render(): string {
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number) => {
      lines.push(
        `# HELP ${PREFIX}_${name} ${help}`,
        `# TYPE ${PREFIX}_${name} gauge`,
        `${PREFIX}_${name} ${value}`,
      );
    };
    gauge(
      'configured',
      'One when this host has a subscription credential; zero means the agent is deliberately idle.',
      this.configured,
    );
    gauge(
      'stream_open',
      'One while the streaming pull of this host subscription is open.',
      this.streamOpen,
    );
    gauge(
      'in_flight',
      'Deliveries held now, waiting for or typing into their session.',
      this.inFlight,
    );
    gauge(
      'last_successful_pull_timestamp_seconds',
      'Unix time the streaming pull was last known healthy: a message arrived or the stream stayed open without error.',
      this.lastSuccessfulPull,
    );
    lines.push(
      `# HELP ${PREFIX}_stream_errors_total Streaming pull failures that closed the stream.`,
      `# TYPE ${PREFIX}_stream_errors_total counter`,
      `${PREFIX}_stream_errors_total ${this.streamErrors}`,
      `# HELP ${PREFIX}_deliveries_total Deliveries by outcome; retried is a delivery released back to Pub/Sub while its session stayed busy.`,
      `# TYPE ${PREFIX}_deliveries_total counter`,
      ...[...this.deliveries].map(
        ([outcome, value]) =>
          `${PREFIX}_deliveries_total{outcome="${outcome}"} ${value}`,
      ),
      `# HELP ${PREFIX}_undeliverable_total Undeliverable deliveries by reason.`,
      `# TYPE ${PREFIX}_undeliverable_total counter`,
      ...[...this.undeliverable].map(
        ([reason, value]) =>
          `${PREFIX}_undeliverable_total{reason="${reason}"} ${value}`,
      ),
      `# HELP ${PREFIX}_local_requests_total Subscribe, list and unsubscribe requests from sessions on this host, by outcome (ok or the error returned).`,
      `# TYPE ${PREFIX}_local_requests_total counter`,
      ...[...this.localRequests].map(([key, value]) => {
        const [op, outcome] = key.split('\u0000');
        return `${PREFIX}_local_requests_total{op="${op}",outcome="${outcome}"} ${value}`;
      }),
      `# HELP ${PREFIX}_session_reports_total Reports of this host's sessions going idle or ending, by outcome: reported; retried (will try again); rejected (LCARS refused it); failed (gave up).`,
      `# TYPE ${PREFIX}_session_reports_total counter`,
      ...[...this.sessionReports].map(([key, value]) => {
        const [kind, outcome] = key.split('\u0000');
        return `${PREFIX}_session_reports_total{kind="${kind}",outcome="${outcome}"} ${value}`;
      }),
      `# HELP ${PREFIX}_delivery_latency_seconds Seconds from publication to a started turn.`,
      `# TYPE ${PREFIX}_delivery_latency_seconds histogram`,
      ...LATENCY_BUCKETS.map(
        (bound, index) =>
          `${PREFIX}_delivery_latency_seconds_bucket{le="${bound}"} ${this.latencyBuckets[index]}`,
      ),
      `${PREFIX}_delivery_latency_seconds_bucket{le="+Inf"} ${this.latencyCount}`,
      `${PREFIX}_delivery_latency_seconds_sum ${this.latencySum}`,
      `${PREFIX}_delivery_latency_seconds_count ${this.latencyCount}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

/** Serves `/metrics` and `/healthz` on a loopback address only. `/healthz`
 * fails only when the agent is configured and its stream is down. */
export function serveMetrics(
  metrics: DeliveryMetrics,
  port: number,
  host = '127.0.0.1',
): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.url === '/metrics') {
      response
        .writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        })
        .end(metrics.render());
      return;
    }
    if (request.url === '/healthz') {
      const healthy = metrics.configured === 0 || metrics.streamOpen === 1;
      response
        .writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            configured: metrics.configured === 1,
            streamOpen: metrics.streamOpen === 1,
            inFlight: metrics.inFlight,
          }),
        );
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
