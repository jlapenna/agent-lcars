/** Audience requested by worker workflows when they call hosted completion. */
export const COMPLETION_OIDC_AUDIENCE = 'agent-lcars-dispatch-completion';

/** Reusable workflow whose isolated job is allowed to report completion. */
export const COMPLETION_FINALIZER_WORKFLOW_PATH =
  '.github/workflows/agent-fallback-finalize.yml';

/** Public App Hosting route that accepts an authenticated worker completion. */
export const HOSTED_COMPLETION_PATH = '/api/control-plane/completion';

/** Canonical production endpoint used by the trusted worker callback. */
export const HOSTED_COMPLETION_URL = `https://agent-console.supersprinkles.racing${HOSTED_COMPLETION_PATH}`;

/** Public, read-only lifecycle aggregate backed by authoritative storage. */
export const HOSTED_TASK_STATE_PATH = '/api/control-plane/task-state';
export const HOSTED_TASK_STATE_URL = `https://agent-console.supersprinkles.racing${HOSTED_TASK_STATE_PATH}`;

/**
 * Audience requested by this repository's own workflows when they report a
 * `RecoveryObservation` (../recovery-observation.ts). Deliberately not yet
 * requested by any workflow in a consumer repository -- see #870: trusting
 * an external repository's OIDC identity here is a security-boundary
 * decision this audience does not itself make, only makes possible once
 * made.
 */
export const RECOVERY_OBSERVATION_OIDC_AUDIENCE =
  'agent-lcars-recovery-observation';

/** Public App Hosting route that accepts an authenticated recovery
 *  observation report. */
export const HOSTED_RECOVERY_OBSERVATION_PATH =
  '/api/control-plane/recovery-observation';
export const HOSTED_RECOVERY_OBSERVATION_URL = `https://agent-console.supersprinkles.racing${HOSTED_RECOVERY_OBSERVATION_PATH}`;
