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

/** Audience requested only by the scheduled/manual real-ingress canary. */
export const WEBHOOK_INGRESS_CANARY_OIDC_AUDIENCE =
  'agent-lcars-webhook-ingress-canary';

/** Trusted workflow allowed to inspect one canary delivery's exact state. */
export const WEBHOOK_INGRESS_CANARY_WORKFLOW_PATH =
  '.github/workflows/webhook-ingress-canary.yml';

/** Read-only App Hosting route used by the real-ingress canary. */
export const WEBHOOK_INGRESS_PROBE_PATH = '/api/control-plane/webhook/probe';
export const WEBHOOK_INGRESS_PROBE_URL = `https://agent-console.supersprinkles.racing${WEBHOOK_INGRESS_PROBE_PATH}`;
