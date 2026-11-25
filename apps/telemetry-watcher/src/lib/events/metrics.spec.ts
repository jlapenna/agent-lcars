import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { DeliveryMetrics, serveMetrics } from './metrics';

describe('DeliveryMetrics', () => {
  it('exposes every outcome and reason from the start, so idle reads as zero', () => {
    const text = new DeliveryMetrics().render();
    for (const outcome of [
      'delivered',
      'undeliverable',
      'retried',
      'invalid',
      'duplicate',
    ]) {
      expect(text).toContain(
        `lcars_events_agent_deliveries_total{outcome="${outcome}"} 0`,
      );
    }
    expect(text).toContain(
      'lcars_events_agent_undeliverable_total{reason="foreground-changed"} 0',
    );
    expect(text).toContain('lcars_events_agent_configured 0');
    expect(text).toContain(
      'lcars_events_agent_last_successful_pull_timestamp_seconds 0',
    );
  });

  it('counts outcomes and observes latency as a cumulative histogram', () => {
    const metrics = new DeliveryMetrics();
    metrics.count('delivered');
    metrics.countUndeliverable('session-ended');
    metrics.observeLatency(3);
    metrics.observeLatency(120);
    const text = metrics.render();
    expect(text).toContain(
      'lcars_events_agent_deliveries_total{outcome="delivered"} 1',
    );
    expect(text).toContain(
      'lcars_events_agent_undeliverable_total{reason="session-ended"} 1',
    );
    expect(text).toContain(
      'lcars_events_agent_delivery_latency_seconds_bucket{le="1"} 0',
    );
    expect(text).toContain(
      'lcars_events_agent_delivery_latency_seconds_bucket{le="5"} 1',
    );
    expect(text).toContain(
      'lcars_events_agent_delivery_latency_seconds_bucket{le="300"} 2',
    );
    expect(text).toContain(
      'lcars_events_agent_delivery_latency_seconds_bucket{le="+Inf"} 2',
    );
    expect(text).toContain(
      'lcars_events_agent_delivery_latency_seconds_sum 123',
    );
    expect(text).toContain(
      'lcars_events_agent_delivery_latency_seconds_count 2',
    );
  });
});

describe('serveMetrics', () => {
  let server: http.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function get(pathname: string) {
    const { port } = server!.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
    return { status: response.status, body: await response.text() };
  }

  it('serves metrics on loopback and reports health', async () => {
    const metrics = new DeliveryMetrics();
    server = await serveMetrics(metrics, 0);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');

    const scraped = await get('/metrics');
    expect(scraped.status).toBe(200);
    expect(scraped.body).toContain('lcars_events_agent_stream_open 0');

    // Unconfigured is idle, not unhealthy.
    expect((await get('/healthz')).status).toBe(200);
    metrics.configured = 1;
    expect((await get('/healthz')).status).toBe(503);
    metrics.streamOpen = 1;
    expect(await get('/healthz')).toEqual({
      status: 200,
      body: '{"configured":true,"streamOpen":true,"inFlight":0}',
    });
    expect((await get('/other')).status).toBe(404);
  });
});
