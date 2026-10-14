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

/** A runner pod that is up: everything but one still starting or gone. */
export function isRunnerOnline(state: string): boolean {
  return state !== 'offline' && state !== 'starting';
}

/**
 * The fleet's runners online and in all (the mockup's "11/12"), counted from
 * the host inventory's per-pod rows. Only ARC runners count: a direct agent
 * Job is not a GitHub Actions runner. `lanes` narrows the count to the lanes
 * a page shows. Undefined when the inventory carries no runner rows, so a
 * caller never invents a denominator.
 */
export function arcRunnerCount(
  runners: readonly { kind: string; lane: string; state: string }[] | undefined,
  lanes?: readonly { lane: string }[],
): { online: number; total: number } | undefined {
  if (runners === undefined) return undefined;
  const shown = lanes && new Set(lanes.map((lane) => lane.lane));
  const arc = runners.filter(
    (runner) => runner.kind === 'arc' && (!shown || shown.has(runner.lane)),
  );
  return {
    online: arc.filter((runner) => isRunnerOnline(runner.state)).length,
    total: arc.length,
  };
}
