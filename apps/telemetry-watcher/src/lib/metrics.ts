import { createServer, Server } from 'node:http';

import { SessionLiveness } from '@agent-lcars/telemetry';

export interface WatcherMetricsSink {
  recordCompletedTick(timestamp: string, trackedSessions: number): void;
  recordSuccessfulSessionUpsert(
    timestamp: string,
    liveness: SessionLiveness,
  ): void;
}

function timestampSeconds(timestamp: string): number {
  return Date.parse(timestamp) / 1000;
}

/** Mutable Prometheus state owned by the long-lived host watcher only. */
export class WatcherMetrics implements WatcherMetricsSink {
  private lastCompletedTickSeconds = 0;
  private lastActiveSessionUpsertSeconds = 0;
  private trackedSessions = 0;

  constructor(private readonly startTimeSeconds = Date.now() / 1000) {}

  recordCompletedTick(timestamp: string, trackedSessions: number): void {
    this.lastCompletedTickSeconds = timestampSeconds(timestamp);
    this.trackedSessions = trackedSessions;
  }

  recordSuccessfulSessionUpsert(
    timestamp: string,
    liveness: SessionLiveness,
  ): void {
    if (liveness === 'live' || liveness === 'idle') {
      this.lastActiveSessionUpsertSeconds = timestampSeconds(timestamp);
    }
  }

  exposition(): string {
    return [
      '# HELP agent_lcars_telemetry_watcher_start_time_seconds Unix timestamp when the watcher process started.',
      '# TYPE agent_lcars_telemetry_watcher_start_time_seconds gauge',
      `agent_lcars_telemetry_watcher_start_time_seconds ${this.startTimeSeconds}`,
      '# HELP agent_lcars_telemetry_watcher_last_completed_tick_timestamp_seconds Unix timestamp of the last fully completed watcher tick.',
      '# TYPE agent_lcars_telemetry_watcher_last_completed_tick_timestamp_seconds gauge',
      `agent_lcars_telemetry_watcher_last_completed_tick_timestamp_seconds ${this.lastCompletedTickSeconds}`,
      '# HELP agent_lcars_telemetry_watcher_last_active_session_upsert_timestamp_seconds Unix timestamp of the last successful live or idle session upsert.',
      '# TYPE agent_lcars_telemetry_watcher_last_active_session_upsert_timestamp_seconds gauge',
      `agent_lcars_telemetry_watcher_last_active_session_upsert_timestamp_seconds ${this.lastActiveSessionUpsertSeconds}`,
      '# HELP agent_lcars_telemetry_watcher_tracked_sessions Sessions currently tracked by the watcher.',
      '# TYPE agent_lcars_telemetry_watcher_tracked_sessions gauge',
      `agent_lcars_telemetry_watcher_tracked_sessions ${this.trackedSessions}`,
      '',
    ].join('\n');
  }
}

export function createWatcherMetricsServer(metrics: WatcherMetrics): Server {
  return createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(metrics.exposition());
  });
}
