/**
 * Client-safe contract for the runner-status panel. The producer
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

/** What ARC's `gha_max_runners` reports for a scale set with no maximum
 * (int32's maximum), not a runner count. */
export const ARC_UNBOUNDED_MAX_RUNNERS = 2_147_483_647;

/** The lanes' summed maximum runners; undefined when any lane has none, so
 * one unbounded lane never reads as billions of runners. */
export function fleetCapacity(
  lanes: readonly { maxRunners?: number }[],
): number | undefined {
  let total = 0;
  for (const lane of lanes) {
    if (lane.maxRunners === undefined) return undefined;
    total += lane.maxRunners;
  }
  return total;
}
