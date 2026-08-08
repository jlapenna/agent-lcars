/**
 * A worker may report one of these narrow, machine-verifiable lane failures
 * with its completion callback. The broker uses the signal to open a durable
 * lane-health incident before it considers dispatching another accepted
 * generation. This is separate from `DispatchOutcomeKind`: an attempt can
 * have a startup-failure outcome while also identifying the shared
 * prerequisite that made the whole lane unhealthy.
 */
export const LANE_READINESS_FAILURES = [
  'credential',
  'provider',
  'bootstrap',
] as const;

export type LaneReadinessFailure = (typeof LANE_READINESS_FAILURES)[number];

export function isLaneReadinessFailure(
  value: unknown,
): value is LaneReadinessFailure {
  return (
    typeof value === 'string' &&
    (LANE_READINESS_FAILURES as readonly string[]).includes(value)
  );
}
