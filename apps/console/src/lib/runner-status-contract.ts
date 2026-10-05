/**
 * Client-safe timing contract for the runner-status panel. The producer
 * (apps/runner-autoscaler/console_status.go) writes a document when its
 * content changes and rewrites an unchanged one every heartbeat
 * (`consoleStatusHeartbeat`, 60 s). A document older than three heartbeats
 * (`consoleStatusTTL`, which is also its Firestore TTL) means the producer
 * stopped, not that nothing changed.
 */
export const RUNNER_STATUS_STALENESS_MS = 180_000;

/** Server-sent event name carrying one `AutoscalerStatusResult` as JSON. */
export const RUNNER_STATUS_EVENT = 'runner-status';

/** How long one server-sent stream stays open. The browser's EventSource
 *  reconnects by itself after the server ends a stream, so ending it well
 *  before the hosting request timeout turns a platform-killed request (a
 *  logged error) into an ordinary reconnect. */
export const RUNNER_STATUS_STREAM_LIFETIME_MS = 4 * 60 * 1000;
