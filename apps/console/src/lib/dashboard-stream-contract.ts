/** Client-safe invalidation protocol. Frames contain no task, run, or repo data. */
export const DASHBOARD_STREAM_URL = '/api/dashboard/stream';
export const DASHBOARD_EVENT = 'dashboard';
export const DASHBOARD_STREAM_LIFETIME_MS = 4 * 60 * 1000;
export const DASHBOARD_HEARTBEAT_MS = 15_000;
export const DASHBOARD_STALE_MS = 45_000;
export const DASHBOARD_REFRESH_INTERVAL_MS = 5_000;
export interface DashboardSignal {
  state: 'live' | 'degraded';
  changed: boolean;
}
