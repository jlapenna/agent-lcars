import { afterEach, describe, expect, it } from 'vitest';

import { createWatcherMetricsServer, WatcherMetrics } from './metrics';

describe('WatcherMetrics', () => {
  it('starts with explicit zero dead-man values', () => {
    const metrics = new WatcherMetrics(1234);

    expect(metrics.exposition()).toContain(
      'agent_lcars_telemetry_watcher_start_time_seconds 1234',
    );
    expect(metrics.exposition()).toContain(
      'agent_lcars_telemetry_watcher_last_completed_tick_timestamp_seconds 0',
    );
    expect(metrics.exposition()).toContain(
      'agent_lcars_telemetry_watcher_last_active_session_upsert_timestamp_seconds 0',
    );
    expect(metrics.exposition()).toContain(
      'agent_lcars_telemetry_watcher_tracked_sessions 0',
    );
  });

  it('records completed ticks and only active session upserts', () => {
    const metrics = new WatcherMetrics(1234);
    metrics.recordCompletedTick('2026-08-03T20:00:00.000Z', 7);
    metrics.recordSuccessfulSessionUpsert('2026-08-03T20:01:00.000Z', 'ended');
    metrics.recordSuccessfulSessionUpsert('2026-08-03T20:02:00.000Z', 'live');

    expect(metrics.exposition()).toContain(
      'agent_lcars_telemetry_watcher_last_completed_tick_timestamp_seconds 1785787200',
    );
    expect(metrics.exposition()).toContain(
      'agent_lcars_telemetry_watcher_last_active_session_upsert_timestamp_seconds 1785787320',
    );
    expect(metrics.exposition()).toContain(
      'agent_lcars_telemetry_watcher_tracked_sessions 7',
    );
  });
});

describe('watcher metrics server', () => {
  const servers: ReturnType<typeof createWatcherMetricsServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it('serves Prometheus text only from /metrics', async () => {
    const server = createWatcherMetricsServer(new WatcherMetrics(1234));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test metrics server did not bind a TCP port');
    }

    const metricsResponse = await fetch(
      `http://127.0.0.1:${address.port}/metrics`,
    );
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(await metricsResponse.text()).toContain(
      'agent_lcars_telemetry_watcher_start_time_seconds 1234',
    );

    const rootResponse = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(rootResponse.status).toBe(404);
  });
});
